"""Agent-focused MCP tool implementations."""

from __future__ import annotations

from typing import Any, Optional

from app.agent import tools as agent_tools


async def validate_circuit(
    circuit: dict[str, Any],
    board_variant: str = "arduino:avr:uno",
) -> dict[str, Any]:
    """Validate circuit wiring, pin conflicts, and rough power budget."""
    result = await agent_tools.validate_circuit(circuit, board_variant)
    return {
        "is_valid": result.is_valid,
        "errors": result.errors,
        "warnings": result.warnings,
        "pin_conflicts": result.pin_conflicts,
        "power_budget_mA": result.power_budget_mA,
    }


async def optimize_circuit(
    circuit: dict[str, Any],
    components_metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Suggest circuit-level improvements."""
    result = await agent_tools.optimize_circuit(circuit, components_metadata)
    return {
        "suggestions": result.suggestions,
        "power_optimization": result.power_optimization,
        "layout_tips": result.layout_tips,
    }


async def debug_code(
    code: str,
    circuit: dict[str, Any],
    compilation_error: Optional[str] = None,
    serial_output: Optional[str] = None,
) -> dict[str, Any]:
    """Debug compile/runtime issues using compiler and serial hints."""
    result = await agent_tools.debug_code(code, circuit, compilation_error, serial_output)
    return {
        "issue_type": result.issue_type,
        "severity": result.severity,
        "explanation": result.explanation,
        "code_fix": result.code_fix,
        "why_it_works": result.why_it_works,
    }


async def analyze_serial_logs(
    serial_output: str,
    circuit: dict[str, Any],
    code: str,
) -> dict[str, Any]:
    """Analyze serial output to identify runtime patterns and likely faults."""
    result = await agent_tools.analyze_serial_logs(serial_output, circuit, code)
    return {
        "observations": result.observations,
        "likely_issues": result.likely_issues,
        "suggestions": result.suggestions,
        "is_working": result.is_working,
    }


async def suggest_components(
    requirements: str,
    constraints: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Suggest top components for natural-language requirements."""
    suggestions = await agent_tools.suggest_components(requirements, constraints)
    return [
        {
            "component_type": item.component_type,
            "part_name": item.part_name,
            "relevance_score": item.relevance_score,
            "why_good": item.why_good,
            "pinout_info": item.pinout_info,
        }
        for item in suggestions
    ]


async def fix_errors(
    code: str,
    error_type: str,
    circuit: dict[str, Any],
) -> dict[str, Any]:
    """Apply template-based code corrections for common failure types."""
    return await agent_tools.fix_errors(code, error_type, circuit)
