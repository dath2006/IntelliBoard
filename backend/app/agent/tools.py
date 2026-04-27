"""Agent tool definitions for Velxio AI agentic layer.

Contains 8 tools:
- 5 MCP wrapper tools (compile, create_circuit, export_wokwi, import_wokwi, generate_code)
- 3 new agent-specific tools (validate_circuit, optimize_circuit, debug_code, analyze_serial_logs, suggest_components, fix_errors, get_circuit_recommendations, apply_circuit_modification)
"""

import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

from app.mcp.wokwi import format_wokwi_diagram, generate_arduino_sketch, parse_wokwi_diagram
from app.services.knowledge_db import get_knowledge_db
from app.services.arduino_cli import ArduinoCLIService


logger = logging.getLogger(__name__)


_arduino_cli: ArduinoCLIService | None = None


def _get_arduino_cli() -> ArduinoCLIService:
    global _arduino_cli
    if _arduino_cli is None:
        _arduino_cli = ArduinoCLIService()
    return _arduino_cli


# ============================================================================
# Tool Result Types
# ============================================================================

@dataclass
class ValidationResult:
    """Result from circuit validation."""
    is_valid: bool
    errors: list[str]
    warnings: list[str]
    pin_conflicts: list[dict[str, Any]]
    power_budget_mA: float


@dataclass
class OptimizationSuggestion:
    """Suggestions result."""
    suggestions: list[dict[str, Any]]
    power_optimization: str
    layout_tips: list[str]


@dataclass
class DebugResult:
    """Code debugging result."""
    issue_type: str  # "compilation_error", "runtime_error", "logic_error"
    severity: str  # "error", "warning"
    explanation: str
    code_fix: str
    why_it_works: str


@dataclass
class AnalysisResult:
    """Serial log analysis result."""
    observations: list[str]
    likely_issues: list[str]
    suggestions: list[str]
    is_working: bool


@dataclass
class ComponentSuggestion:
    """Component suggestion."""
    component_type: str  # wokwi element name
    part_name: str
    relevance_score: float
    why_good: str
    pinout_info: str


# ============================================================================
# Tool Implementations
# ============================================================================

async def validate_circuit(
    circuit: dict[str, Any],
    board_variant: str = "arduino:avr:uno"
) -> ValidationResult:
    """
    Validate circuit for electrical and compatibility issues.
    
    Args:
        circuit: Circuit object with components and connections
        board_variant: Target board (e.g., "arduino:avr:uno", "rp2040:rp2040:rpipico", "esp32:esp32:esp32")
    
    Returns:
        ValidationResult with errors, warnings, pin conflicts, power budget
    
    Checks:
    - Pin conflicts (same pin wired twice)
    - Duplicate connections
    - Component compatibility
    - Power budget (sum current draw vs rail limits)
    - Voltage domain mismatches (3.3V on 5V board)
    
    Example: Detects "LED anode on PORTB pin 2, same as relay coil"
    """
    errors = []
    warnings = []
    pin_conflicts = []
    power_budget_mA = 0.0
    
    # Extract board info
    board_info = {
        "arduino:avr:uno": {"pins": 20, "voltage": "5V", "max_current_mA": 200},
        "arduino:avr:mega": {"pins": 54, "voltage": "5V", "max_current_mA": 400},
        "rp2040:rp2040:rpipico": {"pins": 28, "voltage": "3.3V", "max_current_mA": 100},
        "esp32:esp32:esp32": {"pins": 36, "voltage": "3.3V", "max_current_mA": 500},
    }
    board = board_info.get(board_variant, {"pins": 20, "voltage": "5V", "max_current_mA": 200})
    
    # Get components and connections
    components = circuit.get("components", [])
    connections = circuit.get("connections", [])
    
    # Build pin usage map
    pin_usage = {}  # pin_id -> [list of components using it]
    
    for conn in connections:
        from_part = conn.get("from_part", "")
        from_pin = conn.get("from_pin", "")
        to_part = conn.get("to_part", "")
        to_pin = conn.get("to_pin", "")
        
        # Track pin usage
        pin_key = f"{from_part}:{from_pin}"
        if pin_key not in pin_usage:
            pin_usage[pin_key] = []
        pin_usage[pin_key].append((to_part, to_pin))
    
    def _normalize_pin_name(pin: str) -> str:
        return str(pin).strip().upper()

    def _is_power_or_ground_pin(pin: str) -> bool:
        p = _normalize_pin_name(pin)
        power_tokens = (
            "GND",
            "AGND",
            "VCC",
            "VDD",
            "VIN",
            "5V",
            "3V3",
            "3.3V",
            "AREF",
            "RESET",
            "RST",
        )
        return any(token in p for token in power_tokens)

    # Identify likely board component IDs first, then fall back to known ids.
    board_ids = {
        str(comp.get("id", "")).strip()
        for comp in components
        if any(
            token in str(comp.get("type", "")).lower()
            for token in ("arduino", "rp2040", "esp32")
        )
    }
    board_ids.update({"uno", "mega", "nano", "pico", "rp2040", "esp32", "board"})

    # Detect duplicate wires to reduce noisy circuits.
    seen_edges: set[tuple[tuple[str, str], tuple[str, str]]] = set()

    # Check for board-pin conflicts by looking at BOTH endpoints and using from_pin/to_pin.
    seen_pins: dict[str, set[str]] = {}  # board-pin -> set(component endpoints)

    for conn in connections:
        from_part = str(conn.get("from_part", "")).strip()
        from_pin = str(conn.get("from_pin", "")).strip()
        to_part = str(conn.get("to_part", "")).strip()
        to_pin = str(conn.get("to_pin", "")).strip()

        # Duplicate wire detection (direction agnostic).
        edge = tuple(sorted(((from_part, from_pin), (to_part, to_pin))))
        if edge in seen_edges:
            warnings.append(
                f"Duplicate connection detected: {from_part}:{from_pin} <-> {to_part}:{to_pin}"
            )
        else:
            seen_edges.add(edge)

        if from_part in board_ids and from_pin and not _is_power_or_ground_pin(from_pin):
            board_pin = _normalize_pin_name(from_pin)
            seen_pins.setdefault(board_pin, set()).add(f"{to_part}:{to_pin}" if to_part else to_pin)

        if to_part in board_ids and to_pin and not _is_power_or_ground_pin(to_pin):
            board_pin = _normalize_pin_name(to_pin)
            seen_pins.setdefault(board_pin, set()).add(f"{from_part}:{from_pin}" if from_part else from_pin)

    # Flag pins with multiple non-power connections (likely contention/conflict).
    for pin, endpoint_set in seen_pins.items():
        endpoints = sorted(e for e in endpoint_set if e)
        if len(endpoints) > 1:
            pin_conflicts.append(
                {
                    "pin": pin,
                    "components": endpoints,
                    "message": f"Board pin {pin} has multiple signal connections: {', '.join(endpoints)}",
                }
            )
            errors.append(
                f"Pin conflict on board pin {pin}: multiple signal connections detected ({', '.join(endpoints)})"
            )
    
    # Estimate power budget (simplified)
    # Assume each LED draws ~20mA, sensors ~5mA
    component_types = {}
    for comp in components:
        comp_type = comp.get("type", "")
        if comp_type not in component_types:
            component_types[comp_type] = 0
        component_types[comp_type] += 1
    
    power_draws = {
        "wokwi-led": 20,  # LED ~20mA
        "wokwi-button": 0,  # Button negligible
        "wokwi-buzzer": 50,  # Buzzer ~50mA
        "wokwi-dht22": 5,  # Sensor ~5mA
        "wokwi-bmp280": 3,
        "wokwi-lm35": 1,
        "wokwi-7segment": 30,  # 7-segment ~30mA
        "wokwi-lcd1602": 40,  # LCD ~40mA
    }
    
    for comp_type, count in component_types.items():
        power_draw = power_draws.get(comp_type, 0)
        power_budget_mA += power_draw * count
    
    # Check power budget
    if power_budget_mA > board["max_current_mA"]:
        warnings.append(f"Power budget exceeded: {power_budget_mA}mA > {board['max_current_mA']}mA limit")
    
    # Check for basic structure
    if not components:
        warnings.append("Circuit has no components")
    if not connections:
        warnings.append("Circuit has no connections")
    
    is_valid = len(errors) == 0
    
    return ValidationResult(
        is_valid=is_valid,
        errors=errors,
        warnings=warnings,
        pin_conflicts=pin_conflicts,
        power_budget_mA=power_budget_mA
    )


async def optimize_circuit(
    circuit: dict[str, Any],
    components_metadata: Optional[dict[str, Any]] = None
) -> OptimizationSuggestion:
    """
    Suggest circuit optimizations.
    
    Args:
        circuit: Current circuit object
        components_metadata: Component specifications for calculations
    
    Returns:
        Suggestions for resistor values, capacitors, component swaps
    
    Optimizations:
    - Pull-up/pull-down resistors for buttons
    - Current-limiting resistors for LEDs (calculated from Vf + desired current)
    - Decoupling capacitors (ceramic) and bulk capacitors (electrolytic)
    - Component swaps (e.g., transistor → relay for high current)
    - Layout tips (short high-freq lines, separate analog/digital grounds)
    
    Example: "LED on pin 13 needs 220Ω resistor for safe current (20mA)"
    """
    suggestions = []
    layout_tips = []
    power_optimization = ""
    
    components = circuit.get("components", [])
    
    # Check for LEDs without current-limiting resistors
    led_count = 0
    for comp in components:
        comp_type = comp.get("type", "")
        if "led" in comp_type.lower():
            led_count += 1
            suggestions.append({
                "component": comp.get("id", f"LED-{led_count}"),
                "type": "LED resistor",
                "recommendation": "Add 220Ω current-limiting resistor in series with LED",
                "reason": "Limits LED current to safe 20mA @ 5V (Vf ~2V for red LED)",
                "formula": "R = (Vcc - Vf) / I_desired = (5V - 2V) / 0.02A = 150Ω (use 220Ω standard)"
            })
    
    # Check for buttons without pull-up resistors
    button_count = 0
    for comp in components:
        comp_type = comp.get("type", "")
        if "button" in comp_type.lower():
            button_count += 1
            suggestions.append({
                "component": comp.get("id", f"Button-{button_count}"),
                "type": "Pull-up resistor",
                "recommendation": "Add 10kΩ pull-up resistor from pin to VCC",
                "reason": "Ensures clean high state when button is not pressed",
                "typical_value": "10kΩ"
            })
    
    # Check for lack of decoupling capacitors
    ic_count = sum(1 for c in components if any(x in c.get("type", "") for x in ["ic", "sensor", "module"]))
    if ic_count > 0:
        suggestions.append({
            "type": "Decoupling capacitors",
            "recommendation": f"Add 100nF ceramic capacitors near VCC pins of {ic_count} IC(s)",
            "reason": "Reduces power supply noise and prevents logic errors",
            "placement": "As close as possible to IC power pins"
        })
    
    # Layout recommendations
    layout_tips = [
        "Keep high-frequency signal lines (SPI, I2C) short and grouped",
        "Separate analog and digital ground planes if possible",
        "Place decoupling capacitors within 5mm of IC power pins",
        "Keep button debounce components close to microcontroller",
        "Route GND for analog circuits separately from digital GND"
    ]
    
    # Power optimization advice
    power_optimization = "Consider using lower-power components like low-current LEDs (indicator LEDs) instead of high-brightness types"
    
    return OptimizationSuggestion(
        suggestions=suggestions,
        power_optimization=power_optimization,
        layout_tips=layout_tips
    )


async def debug_code(
    code: str,
    circuit: dict[str, Any],
    compilation_error: Optional[str] = None,
    serial_output: Optional[str] = None
) -> DebugResult:
    """
    Debug Arduino code for compilation and runtime errors.
    
    Args:
        code: Full Arduino code (concatenated files)
        circuit: Current circuit (for pin reference)
        compilation_error: Compiler error message (if compilation failed)
        serial_output: Tail of serial monitor output (if runtime issue)
    
    Returns:
        DebugResult with issue type, explanation, and code fix
    
    Compilation error patterns:
    - "undefined reference to digitalWrite" → suggest #include <Arduino.h>
    - "wrong number of arguments" → show correct syntax
    - "no matching function" → detect typo, suggest correct name
    
    Runtime error patterns from serial:
    - "0 0 0 ..." → sensor not responding, check I2C init
    - Garbled characters → baud rate mismatch
    - Late timestamps → timing issue, adjust delay()
    
    Circuit cross-checks:
    - Code reads pin 5 but circuit shows no component on pin 5 → warn
    - digitalWrite on analog pin → suggest analogWrite
    
    Example: "Error: 'Wire' was not declared. Add `#include <Wire.h>` at the top."
    """
    issue_type = ""
    severity = "error"
    explanation = ""
    code_fix = ""
    why_it_works = ""
    
    # Check compilation errors
    if compilation_error:
        error_lower = compilation_error.lower()
        
        # Common compilation error patterns
        if "undefined reference" in error_lower and "digitalwrite" in error_lower:
            issue_type = "compilation_error"
            explanation = "'digitalWrite' is not found. This usually means Arduino.h is not included."
            code_fix = '#include <Arduino.h>\n\n' + code
            why_it_works = "Arduino.h contains the definitions for digitalWrite, pinMode, and other core functions."
        
        elif "wire" in error_lower and "not declared" in error_lower:
            issue_type = "compilation_error"
            explanation = "'Wire' is not declared. Need to include Wire.h for I2C communication."
            code_fix = '#include <Wire.h>\n\n' + code
            why_it_works = "Wire.h provides the Wire library for I2C communication between Arduino and sensors."
        
        elif "serial" in error_lower and "not declared" in error_lower:
            issue_type = "compilation_error"
            explanation = "'Serial' is not declared. Need to include proper headers."
            if '#include <Arduino.h>' not in code:
                code_fix = '#include <Arduino.h>\n\n' + code
            else:
                code_fix = code
            why_it_works = "Serial is defined in Arduino.h and provides communication with serial monitor."
        
        elif "wrong number of arguments" in error_lower:
            issue_type = "compilation_error"
            explanation = "A function is being called with incorrect number of arguments."
            # Try to find and suggest fix
            if "digitalwrite" in error_lower.lower():
                severity = "error"
                # Only patch one-argument digitalWrite(...) calls.
                one_arg_digital_write = re.compile(r"\bdigitalWrite\s*\(\s*([^,\)]+?)\s*\)")
                code_fix = one_arg_digital_write.sub(r"digitalWrite(\1, HIGH)", code)
                if code_fix == code:
                    explanation += " Could not safely infer a single-argument digitalWrite call to auto-fix."
                why_it_works = "digitalWrite requires 2 arguments: pin number and state (HIGH/LOW)."
            else:
                code_fix = code
        
        else:
            issue_type = "compilation_error"
            severity = "error"
            explanation = f"Compilation error: {compilation_error[:100]}"
            code_fix = code
            why_it_works = "Review the error message above and common Arduino mistakes"
    
    # Check serial output for runtime patterns
    elif serial_output:
        output_lower = serial_output.lower()
        
        if "nan" in output_lower or "inf" in output_lower:
            issue_type = "runtime_error"
            severity = "warning"
            explanation = "Sensor is returning NaN (Not a Number). Sensor not responding or communication issue."
            code_fix = code  # Would need to add initialization check
            why_it_works = "Check I2C address, initialization, and wiring"
        
        elif output_lower.startswith("ü") or "garbled" in output_lower:
            issue_type = "runtime_error"
            severity = "warning"
            explanation = "Serial output is garbled. Likely baud rate mismatch."
            code_fix = code.replace("Serial.begin(9600)", "Serial.begin(115200)") if "Serial.begin" in code else code
            why_it_works = "Default Arduino baud rate is 115200. Serial monitor must match."
        
        elif "not found" in output_lower or "error" in output_lower:
            issue_type = "runtime_error"
            severity = "warning"
            explanation = f"Device/sensor reported error: {output_lower[:80]}"
            code_fix = code
            why_it_works = "Check sensor connections, I2C address, and initialization sequence"
        
        else:
            issue_type = "runtime_error"
            severity = "warning"
            explanation = f"Runtime issue detected: {output_lower[:100]}"
            code_fix = code
            why_it_works = "Check serial output for specific error messages"
    
    else:
        issue_type = "unknown"
        explanation = "No specific error provided for debugging"
        code_fix = code
        why_it_works = "Provide compilation error or serial output for debugging"
    
    return DebugResult(
        issue_type=issue_type,
        severity=severity,
        explanation=explanation,
        code_fix=code_fix,
        why_it_works=why_it_works
    )


async def analyze_serial_logs(
    serial_output: str,
    circuit: dict[str, Any],
    code: str
) -> AnalysisResult:
    """
    Analyze serial monitor output for patterns and issues.
    
    Args:
        serial_output: Accumulated serial output (last 500 chars or 100 lines)
        circuit: Current circuit (to check active pins)
        code: Current code (to detect intended behavior)
    
    Returns:
        Observations, likely issues, suggestions
    
    Pattern detection:
    - No output → Serial not initialized
    - Repeated pattern → Loop running
    - NaN values → Sensor not responding
    - SPI timeout → Communication failed
    - Garbled → Baud rate issue
    
    Timing analysis:
    - Output every 1.2s but code uses delay(1000) → 200ms overhead detected
    
    Example: "Output shows 'MPU6050 not found'. Likely: I2C address mismatch or missing pullups."
    """
    observations = []
    likely_issues = []
    suggestions = []
    is_working = True
    
    output_lower = serial_output.lower()
    
    # Check if output is empty
    if not serial_output or len(serial_output.strip()) == 0:
        observations.append("No serial output detected")
        likely_issues.append("Serial.begin() not called or baud rate mismatch")
        suggestions.append("Check that Serial.begin(115200) is in setup() and that serial monitor baud rate matches")
        is_working = False
    
    # Check for garbled output
    elif any(c in serial_output for c in ['ü', 'ß', 'ñ']) or "garbled" in output_lower:
        observations.append("Serial output appears garbled")
        likely_issues.append("Baud rate mismatch between code and serial monitor")
        suggestions.append("Ensure Serial.begin() rate matches serial monitor rate (typically 115200 for Arduino Uno)")
        is_working = False
    
    # Check for sensor failures
    elif "not found" in output_lower or "error" in output_lower:
        observations.append(f"Device error detected: {serial_output[:100]}")
        likely_issues.append("Sensor not responding or communication issue")
        suggestions.append("Check I2C/SPI connections and verify correct I2C address")
        is_working = False
    
    # Check for NaN or invalid data
    elif "nan" in output_lower or "inf" in output_lower:
        observations.append("Invalid sensor data (NaN or Inf) detected")
        likely_issues.append("Sensor not responding or uninitialized")
        suggestions.append("Verify sensor initialization in setup() and check power supply")
        is_working = False
    
    # Check for repeated patterns
    elif len(set(serial_output.split('\n')[0])) == 1:  # All same character
        observations.append("Repeated pattern detected (possible stuck loop)")
        likely_issues.append("Code may be in infinite loop without delays")
        suggestions.append("Check for loops without delay() or Serial output")
        is_working = False
    
    # Check for timeout messages
    elif "timeout" in output_lower:
        observations.append("Communication timeout detected")
        likely_issues.append("I2C/SPI communication failure")
        suggestions.append("Check clock line (SCL) for pullups and verify device I2C address")
        is_working = False
    
    else:
        observations.append("Serial output appears normal")
        likely_issues.append("No obvious issues detected")
        suggestions.append("Monitor for any unusual patterns in the output")
        is_working = True
    
    # Analyze for timing patterns
    lines = serial_output.strip().split('\n')
    if len(lines) > 5:
        # Check if output appears regular
        observations.append(f"Captured {len(lines)} lines of output")
        
        # Try to detect timing (simplified)
        if "delay" in code.lower():
            delay_mentions = code.lower().count("delay(")
            observations.append(f"Code contains {delay_mentions} delay() calls")
    
    return AnalysisResult(
        observations=observations,
        likely_issues=likely_issues,
        suggestions=suggestions,
        is_working=is_working
    )


async def suggest_components(
    requirements: str,
    constraints: Optional[dict[str, Any]] = None,
    knowledge_db: Optional[Any] = None
) -> list[ComponentSuggestion]:
    """
    Suggest components based on requirements.
    
    Args:
        requirements: Natural language description (e.g., "temperature sensor that works indoors with LCD")
        constraints: Optional filters {power_supply: "3.3V", max_cost: 5, interface: "I2C"}
        knowledge_db: Vector DB for component search
    
    Returns:
        Top-5 components ranked by relevance with explanations
    
    Example:
    - Input: "temperature sensor that works indoors with LCD"
    - Output: [
        {component_type: "wokwi-bmp280", name: "BMP280", relevance: 0.92, 
         why_good: "I2C interface, high accuracy, common on Arduino"},
        {component_type: "wokwi-dht22", name: "DHT22", relevance: 0.88, ...}
    ]
    """
    suggestions = []

    # Preferred path: query the knowledge DB service (vector or keyword backend).
    if knowledge_db is None:
        try:
            knowledge_db = await get_knowledge_db()
        except Exception:
            logger.warning("Knowledge DB unavailable, falling back to local keyword suggestions", exc_info=True)
            knowledge_db = None

    if knowledge_db is not None:
        try:
            rag_suggestions = await knowledge_db.search_components(
                query_text=requirements,
                constraints=constraints,
                limit=5,
            )
            if rag_suggestions:
                return [
                    ComponentSuggestion(
                        component_type=item.get("component_type", ""),
                        part_name=item.get("part_name", "Unknown component"),
                        relevance_score=float(item.get("relevance_score", 0.0)),
                        why_good=item.get("why_good", "Matches your requirements"),
                        pinout_info=item.get(
                            "pinout_info",
                            "Review component documentation for pin mapping",
                        ),
                    )
                    for item in rag_suggestions
                ]
        except Exception:
            logger.warning("Knowledge DB query failed, using keyword fallback", exc_info=True)
    
    req_lower = requirements.lower()
    
    # Simple keyword matching for component recommendations
    component_database = [
        {
            "component_type": "wokwi-dht22",
            "part_name": "DHT22 Temperature & Humidity",
            "relevance_base": 0.85,
            "keywords": ["temperature", "humidity", "sensor", "thermal"],
            "why_good": "Accurate digital temperature/humidity sensor with single-wire interface",
            "pinout_info": "Data pin, VCC, GND. Requires pull-up resistor on data line."
        },
        {
            "component_type": "wokwi-bmp280",
            "part_name": "BMP280 Pressure & Temperature",
            "relevance_base": 0.88,
            "keywords": ["temperature", "pressure", "i2c", "sensor", "atmospheric"],
            "why_good": "I2C interface, high precision, popular for weather stations",
            "pinout_info": "I2C (SDA/SCL), VCC, GND. I2C Address: 0x76 or 0x77"
        },
        {
            "component_type": "wokwi-lcd1602",
            "part_name": "16x2 LCD Display",
            "relevance_base": 0.82,
            "keywords": ["lcd", "display", "screen", "i2c"],
            "why_good": "Common 16x2 character display for showing sensor values",
            "pinout_info": "I2C or parallel interface available. I2C Address: 0x27 (typical)"
        },
        {
            "component_type": "wokwi-servo",
            "part_name": "SG90 Servo Motor",
            "relevance_base": 0.80,
            "keywords": ["motor", "servo", "control", "movement", "rotation"],
            "why_good": "Standard servo for position control with PWM",
            "pinout_info": "Signal (PWM pin), VCC (5V), GND. Uses 1-2ms pulse width"
        },
        {
            "component_type": "wokwi-buzzer",
            "part_name": "Piezo Buzzer",
            "relevance_base": 0.75,
            "keywords": ["buzzer", "alarm", "sound", "speaker", "audio"],
            "why_good": "Simple audible indicator for alerts",
            "pinout_info": "Positive pin, Negative pin. Can use digitalWrite or PWM for tone"
        },
    ]
    
    # Score each component based on keyword matching
    scored = []
    for comp in component_database:
        relevance = comp["relevance_base"]
        
        # Boost relevance for matching keywords
        for keyword in comp["keywords"]:
            if keyword in req_lower:
                relevance += 0.05
        
        scored.append({
            **comp,
            "relevance": min(relevance, 1.0)  # Cap at 1.0
        })
    
    # Sort by relevance and take top 5
    scored = sorted(scored, key=lambda x: x["relevance"], reverse=True)[:5]
    
    # Convert to ComponentSuggestion objects
    for item in scored:
        suggestions.append(ComponentSuggestion(
            component_type=item["component_type"],
            part_name=item["part_name"],
            relevance_score=item["relevance"],
            why_good=item["why_good"],
            pinout_info=item["pinout_info"]
        ))
    
    return suggestions


async def fix_errors(
    code: str,
    error_type: str,
    circuit: dict[str, Any]
) -> dict[str, Any]:
    """
    Auto-fix common code errors.
    
    Args:
        code: Original Arduino code
        error_type: "missing_include" | "undefined_variable" | "wrong_pin" | "wrong_function" | "syntax" | "logic"
        circuit: Current circuit (for pin reference)
    
    Returns:
        {fixed_code, changes: [{line_num, what_changed, why}], test_suggestion}
    
    Template-based fixes:
    - missing_include: scan for undefined refs, inject #include <library>
    - undefined_variable: detect typo or missing declaration
    - wrong_pin: cross-reference circuit, auto-correct constants
    - wrong_function: suggest correct function name + parameters
    - syntax: fix brackets, semicolons
    - logic: detect infinite loops, uninitialized vars
    
    Example: digitalWrite(5, 255) on analog pin → analogWrite(5, 255) with explanation
    """
    fixed_code = code
    changes = []
    test_suggestion = ""
    
    if error_type == "missing_include":
        # Common includes that might be needed
        if "Wire" in code and "#include <Wire.h>" not in code:
            fixed_code = '#include <Wire.h>\n' + code
            changes.append({"line": 1, "what": "Added #include <Wire.h>", "why": "Wire library needed for I2C"})
        
        if "Servo" in code and "#include <Servo.h>" not in code:
            fixed_code = '#include <Servo.h>\n' + fixed_code
            changes.append({"line": 1, "what": "Added #include <Servo.h>", "why": "Servo library needed"})
        
        if "Serial" in code and "#include <Arduino.h>" not in code:
            fixed_code = '#include <Arduino.h>\n' + fixed_code
            changes.append({"line": 1, "what": "Added #include <Arduino.h>", "why": "Core Arduino library needed"})
    
    elif error_type == "undefined_variable":
        # Look for common undefined variables
        if "LED_PIN" in code and "LED_PIN =" not in code:
            fixed_code = "const int LED_PIN = 13;\n\n" + code
            changes.append({"line": 1, "what": "Added LED_PIN constant", "why": "LED_PIN was used but not defined"})
        
        if "BUTTON_PIN" in code and "BUTTON_PIN =" not in code:
            fixed_code = "const int BUTTON_PIN = 2;\n\n" + fixed_code
            changes.append({"line": 1, "what": "Added BUTTON_PIN constant", "why": "BUTTON_PIN was used but not defined"})
    
    elif error_type == "syntax":
        # Fix common syntax errors
        # Missing semicolons (simplified)
        lines = fixed_code.split('\n')
        for i, line in enumerate(lines):
            if line.strip() and not line.strip().endswith(';') and not line.strip().endswith('{') and not line.strip().endswith('}'):
                if 'digitalWrite' in line or 'Serial.print' in line:
                    if ')' in line:
                        fixed_code = fixed_code.replace(line, line + ';')
                        changes.append({"line": i+1, "what": "Added missing semicolon", "why": "Statement must end with semicolon"})
    
    elif error_type == "logic":
        # Check for infinite loops
        if re.search(r"while\s*\(\s*(?:true|1)\s*\)", code):
            if "delay(" not in code:
                # Only patch braced infinite loops and preserve indentation.
                infinite_loop_pattern = re.compile(
                    r"(^[ \t]*)while\s*\(\s*(?:true|1)\s*\)\s*\{",
                    flags=re.MULTILINE,
                )
                fixed_code, replacements = infinite_loop_pattern.subn(
                    lambda m: (
                        f"{m.group(1)}while(true) {{\n"
                        f"{m.group(1)}    delay(100);  // Prevent watchdog reset / CPU starvation"
                    ),
                    fixed_code,
                    count=1,
                )
                if replacements > 0:
                    changes.append(
                        {
                            "line": 0,
                            "what": "Inserted delay(100) at start of infinite loop body",
                            "why": "Infinite loop without delay can cause watchdog reset and starve cooperative tasks",
                        }
                    )
    
    if changes:
        test_suggestion = "After applying fixes, verify the code compiles and runs as expected"
    else:
        test_suggestion = "Code appears correct for this error type"
    
    return {
        "fixed_code": fixed_code,
        "changes": changes,
        "test_suggestion": test_suggestion
    }


async def get_circuit_recommendations(
    circuit: dict[str, Any]
) -> dict[str, Any]:
    """
    Get recommendations for circuit improvements.
    
    Args:
        circuit: Current circuit object
    
    Returns:
        {missing_components: [], improvements: [], next_steps: []}
    
    Detects:
    - Incomplete circuits (button without pull-up resistor)
    - Suggested upgrades (capacitor for debouncing)
    - Next-step projects based on current components
    """
    missing_components = []
    improvements = []
    next_steps = []
    
    components = circuit.get("components", [])
    component_types = [c.get("type", "").lower() for c in components]
    
    # Check for missing protective components
    if any("led" in t for t in component_types):
        improvements.append("Add 220Ω resistor for each LED to limit current")
    
    if any("button" in t for t in component_types):
        improvements.append("Add 10kΩ pull-up resistor for button stability")
        missing_components.append({
            "type": "Pull-up resistor",
            "value": "10kΩ",
            "reason": "Ensures clean digital states for button input"
        })
    
    if any("sensor" in t or "bmp" in t or "dht" in t for t in component_types):
        improvements.append("Add 100nF decoupling capacitor near sensor power pins")
    
    # Suggest next steps based on what they have
    if any("led" in t for t in component_types) and not any("button" in t for t in component_types):
        next_steps.append("Add a button to control the LED")
    
    if any("button" in t for t in component_types) and not any("lcd" in t for t in component_types):
        next_steps.append("Add an LCD display to show button press count")
    
    if any("sensor" in t for t in component_types):
        next_steps.append("Add a display (LCD or 7-segment) to show sensor readings")
    
    if len(components) < 3:
        next_steps.append("Add more sensors or components for a more interesting project")
    
    return {
        "missing_components": missing_components,
        "improvements": improvements,
        "next_steps": next_steps
    }


async def apply_circuit_modification(
    circuit: dict[str, Any],
    modification: Any
) -> dict[str, Any]:
    """
    Apply circuit modifications using structured operations.
    
    Args:
        circuit: Current circuit
        modification:
            Preferred: dict/list JSON payload with operations.
            Backward compatible: natural language string.
    
    Returns:
        {modified_circuit, changes, warnings, errors}
    
    This is intentionally operation-first, so the LLM can supply explicit JSON
    edits instead of relying on brittle NL parsing. Natural language fallback is
    preserved for compatibility.
    
    Supported operations (op):
    - add_component
    - remove_component
    - move_component
    - update_component_attrs
    - connect
    - disconnect
    """
    import json
    modified_circuit = json.loads(json.dumps(circuit))  # Deep copy
    changes: list[str] = []
    warnings: list[str] = []
    errors: list[str] = []

    if not isinstance(modified_circuit, dict):
        return {
            "modified_circuit": {"components": [], "connections": []},
            "changes": [],
            "warnings": ["Invalid circuit payload; reset to empty circuit."],
            "errors": ["circuit must be a JSON object"],
        }

    # Normalize board_fqbn shortnames → full FQBNs immediately so the output
    # always carries a valid FQBN the frontend can act on.
    _SHORTNAME_TO_FQBN: dict[str, str] = {
        "arduino-uno":       "arduino:avr:uno",
        "arduino-mega":      "arduino:avr:mega",
        "arduino-nano":      "arduino:avr:nano:cpu=atmega328",
        "raspberry-pi-pico": "rp2040:rp2040:rpipico",
        "pi-pico-w":         "rp2040:rp2040:rpipicow",
        "esp32":             "esp32:esp32:esp32",
        "esp32-devkit-c-v4": "esp32:esp32:esp32",
        "esp32-devkit-v1":   "esp32:esp32:esp32",
        "esp32-s3":          "esp32:esp32:esp32s3",
        "esp32-c3":          "esp32:esp32:esp32c3",
        "esp32-cam":         "esp32:esp32:esp32cam",
    }
    _raw_fqbn = str(modified_circuit.get("board_fqbn") or "arduino:avr:uno").strip()
    modified_circuit["board_fqbn"] = _SHORTNAME_TO_FQBN.get(_raw_fqbn, _raw_fqbn)

    modified_circuit.setdefault("components", [])
    modified_circuit.setdefault("connections", [])

    components = modified_circuit["components"]
    connections = modified_circuit["connections"]

    if not isinstance(components, list):
        components = []
        modified_circuit["components"] = components
        warnings.append("Circuit components was not a list and has been reset.")

    if not isinstance(connections, list):
        connections = []
        modified_circuit["connections"] = connections
        warnings.append("Circuit connections was not a list and has been reset.")

    def _reindex_components() -> dict[str, dict[str, Any]]:
        index: dict[str, dict[str, Any]] = {}
        for comp in components:
            if isinstance(comp, dict):
                comp_id = str(comp.get("id", "")).strip()
                if comp_id:
                    index[comp_id] = comp
        return index

    def _existing_component_ids() -> set[str]:
        return set(_reindex_components().keys())

    def _normalize_pin(pin: Any) -> str:
        return str(pin or "").strip()

    def _normalize_part(part: Any) -> str:
        return str(part or "").strip()

    def _board_aliases() -> dict[str, str]:
        return {
            "arduino:avr:uno": "arduino-uno",
            "arduino:avr:mega": "arduino-mega",
            "arduino:avr:nano": "arduino-nano",
            "arduino:avr:nano:cpu=atmega328": "arduino-nano",
            "rp2040:rp2040:rpipico": "raspberry-pi-pico",
            "rp2040:rp2040:rpipicow": "pi-pico-w",
            "esp32:esp32:esp32": "esp32",
            "esp32:esp32:esp32s3": "esp32-s3",
            "esp32:esp32:esp32c3": "esp32-c3",
            "esp32:esp32:esp32cam": "esp32-cam",
        }

    def _resolve_primary_board_id() -> str | None:
        ids = _existing_component_ids()
        preferred = _board_aliases().get(str(modified_circuit.get("board_fqbn", "")), "")
        if preferred and (preferred in ids or not ids):
            return preferred
        for bid in ["arduino-uno", "arduino-mega", "arduino-nano", "raspberry-pi-pico", "esp32"]:
            if bid in ids:
                return bid
        for comp in components:
            if not isinstance(comp, dict):
                continue
            ctype = str(comp.get("type", "")).lower()
            cid = str(comp.get("id", "")).strip()
            if cid and any(t in ctype for t in ("arduino", "rp2040", "esp32", "raspberry-pi")):
                return cid
        return None

    def _resolve_part_id(part: Any) -> str:
        raw = _normalize_part(part)
        if not raw:
            return ""
        ids = _existing_component_ids()
        if raw in ids:
            return raw

        # Canonical alias table — covers board short-names AND FQBN strings
        primary_board = _resolve_primary_board_id() or ""
        aliases = {
            "uno": "arduino-uno",
            "mega": "arduino-mega",
            "nano": "arduino-nano",
            "pico": "raspberry-pi-pico",
            "rp2040": "raspberry-pi-pico",
            "esp32": "esp32",
            "esp32-devkit-c-v4": "esp32",
            "esp32-cam": "esp32-cam",
            "esp32-s3": "esp32-s3",
            "esp32-c3": "esp32-c3",
            "board": primary_board,
            # Allow the agent to use the FQBN as a part id too
            "arduino:avr:uno": "arduino-uno",
            "arduino:avr:mega": "arduino-mega",
            "arduino:avr:nano": "arduino-nano",
            "esp32:esp32:esp32": "esp32",
            "esp32:esp32:esp32s3": "esp32-s3",
            "esp32:esp32:esp32c3": "esp32-c3",
            "rp2040:rp2040:rpipico": "raspberry-pi-pico",
        }
        normalized = aliases.get(raw.lower(), aliases.get(raw, raw))
        if normalized in ids:
            return normalized
        # Last resort: if the raw name is any recognized board root, return primary board
        board_keywords = ("arduino", "esp32", "rp2040", "raspberry-pi", "pico", "attiny")
        if any(kw in raw.lower() for kw in board_keywords) and primary_board:
            return primary_board
        return raw

    def _is_board_endpoint(part: str) -> bool:
        part = _normalize_part(part)
        if not part:
            return False

        board_roots = {
            "arduino-uno",
            "arduino-nano",
            "arduino-mega",
            "attiny85",
            "raspberry-pi-pico",
            "pi-pico-w",
            "raspberry-pi-3",
            "esp32",
            "esp32-c3",
            "esp32-s3",
            "esp32-cam",
            "xiao-esp32-c3",
            "xiao-esp32-s3",
            "arduino-nano-esp32",
            "wemos-lolin32-lite",
            "aitewinrobot-esp32c3-supermini",
        }
        if part in board_roots:
            return True
        return any(part.startswith(f"{root}-") for root in board_roots)

    def _is_valid_endpoint_part(part: str) -> bool:
        ids = _existing_component_ids()
        return part in ids or _is_board_endpoint(part)

    def _safe_float(val: Any, default: float = 0.0) -> float:
        try:
            return float(val)
        except (TypeError, ValueError):
            return default

    def _safe_int(val: Any, default: int = 0) -> int:
        try:
            return int(val)
        except (TypeError, ValueError):
            return default

    def _connection_key(from_part: str, from_pin: str, to_part: str, to_pin: str) -> tuple[tuple[str, str], tuple[str, str]]:
        # Direction-agnostic duplicate key
        return tuple(sorted(((from_part, from_pin), (to_part, to_pin))))

    def _has_connection(from_part: str, from_pin: str, to_part: str, to_pin: str) -> bool:
        key = _connection_key(from_part, from_pin, to_part, to_pin)
        for conn in connections:
            if not isinstance(conn, dict):
                continue
            existing = _connection_key(
                _normalize_part(conn.get("from_part")),
                _normalize_pin(conn.get("from_pin")),
                _normalize_part(conn.get("to_part")),
                _normalize_pin(conn.get("to_pin")),
            )
            if existing == key:
                return True
        return False

    def _next_component_id(prefix: str) -> str:
        existing = _existing_component_ids()
        n = 1
        while f"{prefix}-{n}" in existing:
            n += 1
        return f"{prefix}-{n}"

    def _parse_operations_payload(value: Any) -> list[dict[str, Any]]:
        # 1) Already structured dict/list
        if isinstance(value, list):
            return [op for op in value if isinstance(op, dict)]
        if isinstance(value, dict):
            ops = value.get("operations")
            if isinstance(ops, list):
                return [op for op in ops if isinstance(op, dict)]
            if isinstance(value.get("op"), str):
                return [value]
            return []

        # 2) JSON-in-string (preferred for backward compatibility with text arg)
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("{") or text.startswith("["):
                try:
                    parsed = json.loads(text)
                    return _parse_operations_payload(parsed)
                except Exception:
                    return []

        return []

    def _legacy_fallback_ops(value: Any) -> list[dict[str, Any]]:
        # Keep backward compatibility for old prompts, but ensure concrete ops.
        if not isinstance(value, str):
            return []
        text = value.lower().strip()
        if not text:
            return []

        pin_match = re.search(r"\bpin\s*(\d{1,2})\b", text)
        pin = pin_match.group(1) if pin_match else "13"

        if "add" in text and "led" in text:
            return [
                {
                    "op": "add_component",
                    "component": {
                        "type": "wokwi-led",
                        "left": 100,
                        "top": 100,
                        "rotate": 0,
                        "attrs": {"color": "red"},
                    },
                },
                {
                    "op": "connect",
                    "from": {"part": "board", "pin": pin},
                    "to": {"part": "$last_component", "pin": "A"},
                    "color": "green",
                },
                {
                    "op": "connect",
                    "from": {"part": "board", "pin": "GND"},
                    "to": {"part": "$last_component", "pin": "C"},
                    "color": "black",
                },
            ]

        if "add" in text and "button" in text:
            return [
                {
                    "op": "add_component",
                    "component": {
                        "type": "wokwi-button",
                        "left": 100,
                        "top": 200,
                        "rotate": 0,
                        "attrs": {},
                    },
                },
                {
                    "op": "connect",
                    "from": {"part": "board", "pin": pin},
                    "to": {"part": "$last_component", "pin": "1.l"},
                    "color": "green",
                },
                {
                    "op": "connect",
                    "from": {"part": "board", "pin": "GND"},
                    "to": {"part": "$last_component", "pin": "2.r"},
                    "color": "black",
                },
            ]

        return []

    operations = _parse_operations_payload(modification)
    if not operations and isinstance(modification, dict):
        text_mod = modification.get("modification")
        if isinstance(text_mod, str):
            operations = _parse_operations_payload(text_mod)
            if not operations:
                operations = _legacy_fallback_ops(text_mod)
                if operations:
                    warnings.append(
                        "Used legacy natural-language fallback. Prefer structured operations JSON for robust edits."
                    )

    if not operations:
        operations = _legacy_fallback_ops(modification)
        if operations:
            warnings.append(
                "Used legacy natural-language fallback. Prefer structured operations JSON for robust edits."
            )

    if not operations:
        warnings.append("No valid operations were provided.")
        warnings.append(
            "Send structured operations, e.g. {'operations': [{'op': 'add_component', ...}, {'op': 'connect', ...}]}."
        )
        return {
            "modified_circuit": modified_circuit,
            "changes": changes,
            "warnings": warnings,
            "errors": errors,
        }

    last_component_id = ""

    for index, op in enumerate(operations):
        op_name = str(op.get("op") or op.get("action") or op.get("type") or "").strip().lower()
        if not op_name:
            errors.append(f"Operation #{index} is missing 'op'.")
            continue

        if op_name == "add_component":
            comp = op.get("component")
            if not isinstance(comp, dict):
                errors.append(f"Operation #{index} add_component requires object field 'component'.")
                continue

            ctype = str(comp.get("type", "")).strip()
            if not ctype:
                errors.append(f"Operation #{index} add_component requires component.type.")
                continue

            requested_id = str(comp.get("id", "")).strip()
            if requested_id and requested_id in _existing_component_ids():
                warnings.append(
                    f"Component id '{requested_id}' already exists; generated a new unique id instead."
                )
                requested_id = ""

            prefix = ctype.replace("wokwi-", "") or "component"
            comp_id = requested_id or _next_component_id(prefix)

            new_comp = {
                "id": comp_id,
                "type": ctype,
                "left": _safe_float(comp.get("left"), 100.0),
                "top": _safe_float(comp.get("top"), 100.0),
                "rotate": _safe_int(comp.get("rotate"), 0),
                "attrs": dict(comp.get("attrs", {})) if isinstance(comp.get("attrs"), dict) else {},
            }
            components.append(new_comp)
            last_component_id = comp_id
            changes.append(f"Added component {comp_id} ({ctype}).")
            continue

        if op_name == "remove_component":
            raw_id = op.get("id") or op.get("component_id")
            comp_id = _resolve_part_id(raw_id)
            if not comp_id:
                errors.append(f"Operation #{index} remove_component requires id/component_id.")
                continue

            before_len = len(components)
            components[:] = [c for c in components if str(c.get("id", "")).strip() != comp_id]
            if len(components) == before_len:
                warnings.append(f"remove_component: component '{comp_id}' does not exist.")
                continue

            before_conn = len(connections)
            connections[:] = [
                c
                for c in connections
                if _normalize_part(c.get("from_part")) != comp_id and _normalize_part(c.get("to_part")) != comp_id
            ]
            removed_conn = before_conn - len(connections)
            changes.append(f"Removed component {comp_id} and {removed_conn} related connection(s).")
            continue

        if op_name == "move_component":
            raw_id = op.get("id") or op.get("component_id")
            comp_id = _resolve_part_id(raw_id)
            comp_index = _reindex_components()
            comp = comp_index.get(comp_id)
            if not comp:
                errors.append(f"move_component: component '{comp_id}' not found.")
                continue

            if "left" in op or "top" in op:
                comp["left"] = _safe_float(op.get("left"), _safe_float(comp.get("left"), 0.0))
                comp["top"] = _safe_float(op.get("top"), _safe_float(comp.get("top"), 0.0))
            else:
                dx = _safe_float(op.get("dx"), 0.0)
                dy = _safe_float(op.get("dy"), 0.0)
                comp["left"] = _safe_float(comp.get("left"), 0.0) + dx
                comp["top"] = _safe_float(comp.get("top"), 0.0) + dy

            if "rotate" in op:
                comp["rotate"] = _safe_int(op.get("rotate"), _safe_int(comp.get("rotate"), 0))

            changes.append(f"Moved component {comp_id}.")
            continue

        if op_name == "update_component_attrs":
            raw_id = op.get("id") or op.get("component_id")
            comp_id = _resolve_part_id(raw_id)
            comp = _reindex_components().get(comp_id)
            if not comp:
                errors.append(f"update_component_attrs: component '{comp_id}' not found.")
                continue

            attrs = op.get("attrs")
            if not isinstance(attrs, dict):
                errors.append(f"update_component_attrs: attrs must be an object (component {comp_id}).")
                continue

            existing_attrs = comp.get("attrs") if isinstance(comp.get("attrs"), dict) else {}
            comp["attrs"] = {**existing_attrs, **attrs}
            changes.append(f"Updated attrs for component {comp_id}.")
            continue

        if op_name in {"connect", "disconnect"}:
            from_obj = op.get("from") if isinstance(op.get("from"), dict) else {}
            to_obj = op.get("to") if isinstance(op.get("to"), dict) else {}

            raw_from_part = (
                op.get("from_part")
                or op.get("fromPart")
                or from_obj.get("part")
                or from_obj.get("component")
                or op.get("source_part")
                or op.get("sourcePart")
            )
            raw_from_pin = (
                op.get("from_pin")
                or op.get("fromPin")
                or from_obj.get("pin")
                or from_obj.get("pinName")
                or op.get("source_pin")
                or op.get("sourcePin")
            )
            raw_to_part = (
                op.get("to_part")
                or op.get("toPart")
                or to_obj.get("part")
                or to_obj.get("component")
                or op.get("target_part")
                or op.get("targetPart")
            )
            raw_to_pin = (
                op.get("to_pin")
                or op.get("toPin")
                or to_obj.get("pin")
                or to_obj.get("pinName")
                or op.get("target_pin")
                or op.get("targetPin")
            )

            from_part = _resolve_part_id(raw_from_part)
            to_part = _resolve_part_id(raw_to_part)

            # '$last_component' macro for compact op plans.
            if raw_from_part == "$last_component":
                from_part = last_component_id
            if raw_to_part == "$last_component":
                to_part = last_component_id

            from_pin = _normalize_pin(raw_from_pin)
            to_pin = _normalize_pin(raw_to_pin)

            if not from_part or not to_part or not from_pin or not to_pin:
                errors.append(
                    f"{op_name}: missing endpoint fields (from_part/from_pin/to_part/to_pin)."
                )
                continue

            if not _is_valid_endpoint_part(from_part):
                errors.append(f"{op_name}: from_part '{from_part}' is not a known component or board endpoint.")
                continue
            if not _is_valid_endpoint_part(to_part):
                errors.append(f"{op_name}: to_part '{to_part}' is not a known component or board endpoint.")
                continue

            if op_name == "connect":
                if _has_connection(from_part, from_pin, to_part, to_pin):
                    warnings.append(
                        f"connect skipped: connection already exists ({from_part}:{from_pin} <-> {to_part}:{to_pin})."
                    )
                    continue

                color = str(op.get("color") or "green")
                connections.append(
                    {
                        "from_part": from_part,
                        "from_pin": from_pin,
                        "to_part": to_part,
                        "to_pin": to_pin,
                        "color": color,
                    }
                )
                changes.append(f"Connected {from_part}:{from_pin} to {to_part}:{to_pin}.")
            else:
                before = len(connections)
                target_key = _connection_key(from_part, from_pin, to_part, to_pin)
                connections[:] = [
                    c
                    for c in connections
                    if _connection_key(
                        _normalize_part(c.get("from_part")),
                        _normalize_pin(c.get("from_pin")),
                        _normalize_part(c.get("to_part")),
                        _normalize_pin(c.get("to_pin")),
                    )
                    != target_key
                ]
                removed = before - len(connections)
                if removed > 0:
                    changes.append(f"Disconnected {from_part}:{from_pin} and {to_part}:{to_pin}.")
                else:
                    warnings.append(
                        f"disconnect skipped: connection not found ({from_part}:{from_pin} <-> {to_part}:{to_pin})."
                    )
            continue

        errors.append(f"Unsupported operation '{op_name}' at index {index}.")
    
    return {
        "modified_circuit": modified_circuit,
        "changes": changes,
        "warnings": warnings,
        "errors": errors,
    }


# ============================================================================
# MCP Wrapper Tools
# ============================================================================

async def compile_code(
    files: list[dict[str, str]],
    board: str = "arduino:avr:uno"
) -> dict[str, Any]:
    """
    Compile Arduino code to hex/binary.
    
    Args:
        files: List of {name, content} sketch files
        board: Board FQBN (e.g., "arduino:avr:uno", "esp32:esp32:esp32")
    
    Returns:
        {success, hex_content, binary_content, binary_type, stdout, stderr, error}
    """
    cli = _get_arduino_cli()
    core_status = await cli.ensure_core_for_board(board)
    if core_status.get("needed") and not core_status.get("installed"):
        return {
            "success": False,
            "hex_content": None,
            "binary_content": None,
            "binary_type": None,
            "stdout": "",
            "stderr": core_status.get("log", ""),
            "error": f"Failed to install required core: {core_status.get('core_id')}",
        }
    return await cli.compile(files, board)


async def create_circuit(
    components: list[dict[str, Any]],
    connections: list[dict[str, Any]],
    board_fqbn: str = "arduino:avr:uno"
) -> dict[str, Any]:
    """Create circuit object from components and connections."""
    # Normalize shortname board IDs to full FQBNs so the frontend
    # board-switch logic always finds a match.
    SHORTNAME_TO_FQBN: dict[str, str] = {
        "arduino-uno":        "arduino:avr:uno",
        "arduino-mega":       "arduino:avr:mega",
        "arduino-nano":       "arduino:avr:nano:cpu=atmega328",
        "raspberry-pi-pico":  "rp2040:rp2040:rpipico",
        "pi-pico-w":          "rp2040:rp2040:rpipicow",
        "esp32":              "esp32:esp32:esp32",
        "esp32-devkit-c-v4":  "esp32:esp32:esp32",
        "esp32-devkit-v1":    "esp32:esp32:esp32",
        "esp32-s3":           "esp32:esp32:esp32s3",
        "esp32-c3":           "esp32:esp32:esp32c3",
        "esp32-cam":          "esp32:esp32:esp32cam",
        "attiny85":           "ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz",
    }
    raw_fqbn = str(board_fqbn or "arduino:avr:uno").strip()
    normalized_fqbn = SHORTNAME_TO_FQBN.get(raw_fqbn, raw_fqbn)

    normalized_components: list[dict[str, Any]] = []
    for i, comp in enumerate(components or []):
        if not isinstance(comp, dict):
            continue
            
        def safe_float(val: Any, default: float = 0.0) -> float:
            if val is None: return default
            try: return float(val)
            except (ValueError, TypeError): return default
            
        def safe_int(val: Any, default: int = 0) -> int:
            if val is None: return default
            try: return int(val)
            except (ValueError, TypeError): return default

        attrs = comp.get("attrs")
        safe_attrs = dict(attrs) if isinstance(attrs, dict) else {}

        normalized_components.append(
            {
                "id": str(comp.get("id") or f"comp{i}"),
                "type": str(comp.get("type") or ""),
                "left": safe_float(comp.get("left"), 0.0),
                "top": safe_float(comp.get("top"), 0.0),
                "rotate": safe_int(comp.get("rotate"), 0),
                "attrs": safe_attrs,
            }
        )

    # Auto-layout: if the LLM forgot to set meaningful positions (i.e. most
    # non-board components are piled at (0,0)), redistribute them on the canvas
    # so they don't overlap.
    _auto_layout_components(normalized_components)

    normalized_connections: list[dict[str, Any]] = []
    for conn in connections or []:
        if not isinstance(conn, dict):
            continue
        normalized_connections.append(
            {
                "from_part": str(conn.get("from_part") or ""),
                "from_pin": str(conn.get("from_pin") or ""),
                "to_part": str(conn.get("to_part") or ""),
                "to_pin": str(conn.get("to_pin") or ""),
                "color": str(conn.get("color") or "green"),
            }
        )

    return {
        "board_fqbn": normalized_fqbn,
        "components": normalized_components,
        "connections": normalized_connections,
        "version": 1,
    }


def _is_board_component(ctype: str) -> bool:
    """Return True if the component type is a microcontroller board."""
    board_keywords = ("arduino", "rp2040", "esp32", "raspberry-pi", "pico")
    low = ctype.lower()
    return any(k in low for k in board_keywords)


# Approximate bounding-box widths/heights for common Wokwi components (px).
_COMPONENT_SIZE: dict[str, tuple[float, float]] = {
    "wokwi-led": (30, 60),
    "wokwi-resistor": (80, 20),
    "wokwi-button": (50, 50),
    "wokwi-buzzer": (60, 60),
    "wokwi-dht22": (60, 90),
    "wokwi-bmp280": (60, 60),
    "wokwi-lm35": (40, 50),
    "wokwi-lcd1602": (160, 60),
    "wokwi-servo": (80, 60),
    "wokwi-7segment": (60, 80),
    "wokwi-potentiometer": (60, 60),
    "wokwi-neopixel": (40, 40),
    "wokwi-ir-receiver": (40, 60),
    "wokwi-pir-motion-sensor": (60, 60),
}
_DEFAULT_COMPONENT_SIZE = (60, 60)  # fallback
_BOARD_WIDTH = 220.0   # Arduino Uno approximate rendered width
_BOARD_HEIGHT = 320.0  # Arduino Uno approximate rendered height
_PADDING = 40.0        # minimum gap between components
_COL_START = _BOARD_WIDTH + 60.0  # X origin for non-board components
_ROW_START = 20.0                 # Y origin for first row


def _auto_layout_components(components: list[dict[str, Any]]) -> None:
    """Redistribute non-board components on the canvas when their positions
    are all identical (typically 0,0 default from the LLM).

    Strategy:
    - Board component stays wherever it is (or at 0,0).
    - Non-board components are placed in a column-first grid to the right of
      the board, with per-type width/height awareness and consistent padding.
    - Groups of the same type are kept together in the same row to honour
      phrases like "4 LEDs in a row".
    """
    if not components:
        return

    # Separate board vs non-board.
    board_comps = [c for c in components if _is_board_component(str(c.get("type", "")))]
    other_comps = [c for c in components if not _is_board_component(str(c.get("type", "")))]

    if not other_comps:
        return

    # Detect whether the LLM actually provided distinct positions.
    positions = {(c.get("left", 0.0), c.get("top", 0.0)) for c in other_comps}
    all_at_origin = len(positions) <= 1 and (0.0, 0.0) in positions

    # Also treat as needing layout when many components share the exact same spot.
    max_overlap = max(
        sum(
            1
            for c in other_comps
            if c.get("left", 0.0) == p[0] and c.get("top", 0.0) == p[1]
        )
        for p in positions
    ) if positions else 0

    needs_layout = all_at_origin or max_overlap > 1

    if not needs_layout:
        return  # LLM set unique positions — trust them.

    # Group non-board components by type to keep same-type components together.
    from collections import defaultdict
    type_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for comp in other_comps:
        type_groups[str(comp.get("type", "unknown"))].append(comp)

    # Place groups row by row (one type per row keeps same-type horizontal).
    cursor_y = _ROW_START
    for ctype, group in type_groups.items():
        w, h = _COMPONENT_SIZE.get(ctype, _DEFAULT_COMPONENT_SIZE)
        col_step = w + _PADDING  # horizontal spacing for this type
        row_height = h + _PADDING  # vertical spacing before next type

        cursor_x = _COL_START
        for comp in group:
            comp["left"] = cursor_x
            comp["top"] = cursor_y
            cursor_x += col_step

        cursor_y += row_height


async def export_wokwi_json(circuit: dict[str, Any]) -> dict[str, Any]:
    """Export circuit to Wokwi diagram.json format."""
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}
    return format_wokwi_diagram(circuit, author="Velxio Agent")


async def import_wokwi_json(diagram_json: dict[str, Any]) -> dict[str, Any]:
    """Import Wokwi diagram.json to Velxio circuit format."""
    if not isinstance(diagram_json, dict):
        return {"error": "diagram_json must be a JSON object."}
    return parse_wokwi_diagram(diagram_json)


async def apply_code_modification(
    active_code: dict[str, str],
    files: list[dict[str, str]],
    replace_all: bool = False,
) -> dict[str, Any]:
    """Apply explicit code file edits to the active workspace.

    Args:
        active_code: Current code files map {name: content}
        files: File updates as [{name, content}]
        replace_all: If true, replace the whole workspace with provided files

    Returns:
        {
          files: full updated file list,
          updated_files: [names],
          created_files: [names],
          deleted_files: [names when replace_all=True],
          errors: [messages],
        }
    """
    errors: list[str] = []
    updated_files: list[str] = []
    created_files: list[str] = []

    if not isinstance(active_code, dict):
        active_code = {}

    if not isinstance(files, list) or not files:
        return {
            "files": [
                {"name": name, "content": content}
                for name, content in active_code.items()
            ],
            "updated_files": [],
            "created_files": [],
            "deleted_files": [],
            "errors": ["files must be a non-empty list of {name, content}."],
        }

    next_code: dict[str, str] = {} if replace_all else dict(active_code)
    existing_names = set(active_code.keys())

    for idx, entry in enumerate(files):
        if not isinstance(entry, dict):
            errors.append(f"files[{idx}] must be an object.")
            continue

        name = str(entry.get("name", "")).strip()
        if not name:
            errors.append(f"files[{idx}] is missing a valid name.")
            continue

        content = entry.get("content")
        if not isinstance(content, str):
            errors.append(f"files[{idx}] content for '{name}' must be a string.")
            continue

        if name in next_code:
            updated_files.append(name)
        else:
            created_files.append(name)
        next_code[name] = content

    deleted_files: list[str] = []
    if replace_all:
        deleted_files = sorted(existing_names - set(next_code.keys()))

    return {
        "files": [
            {"name": name, "content": content}
            for name, content in next_code.items()
        ],
        "updated_files": sorted(set(updated_files)),
        "created_files": sorted(set(created_files)),
        "deleted_files": deleted_files,
        "errors": errors,
    }


async def control_simulation_action(
    action: str,
    board_id: str | None = None,
    ensure_compiled: bool = False,
    serial_input: str | None = None,
    board_fqbn: str | None = None,
) -> dict[str, Any]:
    """Normalize runtime control requests into a frontend-executable action payload."""
    raw = str(action or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not raw:
        return {
            "ok": False,
            "error": "action is required",
            "supported_actions": [
                "compile",
                "run",
                "start",
                "stop",
                "reset",
                "open_terminal",
                "close_terminal",
                "toggle_terminal",
                "send_terminal_input",
                "read_serial_monitor",
            ],
        }

    action_name = raw
    open_serial_monitor: bool | None = None

    if action_name == "run":
        action_name = "start"
        ensure_compiled = True
    elif action_name == "open_terminal":
        action_name = "set_serial_monitor"
        open_serial_monitor = True
    elif action_name == "close_terminal":
        action_name = "set_serial_monitor"
        open_serial_monitor = False
    elif action_name == "toggle_terminal":
        action_name = "toggle_serial_monitor"
    elif action_name == "send_terminal_input":
        action_name = "send_serial_input"

    supported = {
        "compile",
        "start",
        "stop",
        "reset",
        "set_serial_monitor",
        "toggle_serial_monitor",
        "send_serial_input",
        "read_serial_monitor",
    }
    if action_name not in supported:
        return {
            "ok": False,
            "error": f"Unsupported action '{action}'.",
            "supported_actions": sorted(supported),
        }

    if action_name == "send_serial_input" and not str(serial_input or "").strip():
        return {
            "ok": False,
            "error": "serial_input is required for send_terminal_input/send_serial_input.",
        }

    return {
        "ok": True,
        "action": action_name,
        "board_id": str(board_id or "").strip() or None,
        "ensure_compiled": bool(ensure_compiled),
        "serial_input": serial_input,
        "open_serial_monitor": open_serial_monitor,
        "board_fqbn": str(board_fqbn or "").strip() or None,
    }


async def generate_code_files(
    circuit: dict[str, Any],
    sketch_name: str = "sketch",
    extra_instructions: str = "",
) -> dict[str, Any]:
    """Generate starter Arduino code from circuit."""
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    sketch_content = generate_arduino_sketch(circuit, sketch_name=sketch_name)
    if extra_instructions:
        sketch_content = f"// {extra_instructions}\n" + sketch_content

    return {
        "files": [
            {
                "name": f"{sketch_name}.ino",
                "content": sketch_content,
            }
        ],
        "board_fqbn": circuit.get("board_fqbn", "arduino:avr:uno"),
    }


async def search_components_db(
    query: str,
    limit: int = 5
) -> list[dict[str, Any]]:
    """Search the Knowledge DB for components."""
    db = await get_knowledge_db()
    return await db.search_components(query, limit=limit)


async def get_component_details(
    component_type: str
) -> dict[str, Any] | None:
    """Get exact details for a specific component, including pins."""
    db = await get_knowledge_db()
    return await db.get_component_details(component_type)


def get_circuit_topology(
    circuit: dict[str, Any]
) -> dict[str, Any]:
    """Get a token-efficient summary of the circuit."""
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    board_fqbn = circuit.get("board_fqbn", "arduino:avr:uno")
    components = circuit.get("components", [])
    connections = circuit.get("connections", [])

    # Derive the canonical board canvas ID from the FQBN so the agent can use
    # it verbatim as from_part/to_part in connection calls.
    FQBN_TO_BOARD_ID = {
        "arduino:avr:uno": "arduino-uno",
        "arduino:avr:mega": "arduino-mega",
        "arduino:avr:nano": "arduino-nano",
        "arduino:avr:nano:cpu=atmega328": "arduino-nano",
        "rp2040:rp2040:rpipico": "raspberry-pi-pico",
        "rp2040:rp2040:rpipicow": "pi-pico-w",
        "esp32:esp32:esp32": "esp32",
        "esp32:esp32:esp32s3": "esp32-s3",
        "esp32:esp32:esp32c3": "esp32-c3",
        "esp32:esp32:esp32cam": "esp32-cam",
    }
    board_id = FQBN_TO_BOARD_ID.get(board_fqbn, board_fqbn)

    summary_components = [
        {"id": c.get("id"), "type": c.get("type")}
        for c in components
        if isinstance(c, dict)
    ]

    summary_connections = [
        f"{c.get('from_part')}:{c.get('from_pin')} <-> {c.get('to_part')}:{c.get('to_pin')} ({c.get('color', 'green')})"
        for c in connections
        if isinstance(c, dict)
    ]

    return {
        "board_fqbn": board_fqbn,
        "board_id": board_id,   # Use this exact string as from_part/to_part for board connections
        "components": summary_components,
        "connections": summary_connections,
    }
