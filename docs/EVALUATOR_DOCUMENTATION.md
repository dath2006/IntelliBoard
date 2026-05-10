# IntelliBoard: AI-Powered Browser-Based Embedded System Simulator

## Executive Summary

IntelliBoard is a comprehensive browser-based embedded systems development platform featuring **autonomous AI-powered circuit design**, **multi-architecture emulation**, and **real-time collaborative editing**. The platform uniquely combines:

- **Agentic AI system** for autonomous hardware engineering using Pydantic AI
- **Browser-native emulation** (AVR, RP2040) + **Backend QEMU emulation** (ESP32, ESP32-S3, ESP32-C3)
- **48+ interactive electronic components** with live pin state simulation
- **Multi-board projects** with heterogeneous architectures
- **Custom ai-elements UI library** for streaming AI interactions

---

## Core System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    FRONTEND (Browser)                                        │
│                                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                           AI AGENTIC LAYER (React + AI-SDK)                         │   │
│  │                                                                                      │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                        │   │
│  │   │  ChatPanel   │◀──▶│  useChat()   │◀──▶│   AI-SDK     │                        │   │
│  │   │ (ai-elements)│    │   Transport  │    │   Streaming  │                        │   │
│  │   └──────────────┘    └──────────────┘    └──────────────┘                        │   │
│  │          │                                           │                             │   │
│  │          ▼                                           ▼                             │   │
│  │   ┌──────────────┐                          ┌──────────────┐                      │   │
│  │   │ useAgentStore│                          │  Tool Call   │                      │   │
│  │   │  (Zustand)   │                          │  Renderers   │                      │   │
│  │   └──────────────┘                          └──────────────┘                      │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                          │                                                  │
│  ┌───────────────────────────────────────┼───────────────────────────────────────────┐   │
│  │                              SIMULATION ENGINE                                        │   │
│  │                                                                                       │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │   │
│  │  │   AVR8js        │  │   RP2040js      │  │  ESP32 Bridge   │  │   SPICE      │  │   │
│  │  │ (ATmega328p)    │  │ (ARM Cortex-M0+│  │  (QEMU-WASM)    │  │  (NgSpice)   │  │   │
│  │  │ Browser-native  │  │ Browser-native) │  │  (Xtensa/RISC-V)│  │  (Circuit)   │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  └──────────────┘  │   │
│  │                                                                                       │   │
│  │  ┌───────────────────────────────────────────────────────────────────────────────┐   │   │
│  │  │                      PartSimulationRegistry (Plugin System)                   │   │   │
│  │  │                                                                              │   │   │
│  │  │   LED · RGB · Servo · LCD · Buzzer · Potentiometer · Button · Joystick      │   │   │
│  │  └───────────────────────────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────────────────────────┘   │
│                                          │                                                    │
└──────────────────────────────────────────┼────────────────────────────────────────────────────┘
                                           │ HTTP / WebSocket / SSE
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    BACKEND (Python/FastAPI)                                  │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                            AGENT RUNTIME (Pydantic AI)                               │   │
│  │                                                                                       │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                        │   │
│  │   │  Agent Core  │◀──▶│  40+ Tools     │◀──▶│  SnapshotOps │                        │   │
│  │   │  (agent.py)  │    │  (Granular)    │    │  (Mutation)  │                        │   │
│  │   └──────────────┘    └──────────────┘    └──────────────┘                        │   │
│  │          │                                           │                                │   │
│  │          ▼                                           ▼                                │   │
│  │   ┌──────────────┐                          ┌──────────────┐                       │   │
│  │   │ AgentDeps    │                          │  Session     │                       │   │
│  │   │ (Context)    │                          │  Management  │                       │   │
│  │   └──────────────┘                          └──────────────┘                       │   │
│  └──────────────────────────────────────────────────────────────────────────────────────┘   │
│                                          │                                                    │
│  ┌───────────────────────────────────────┼────────────────────────────────────────────┐   │
│  │                               COMPILATION & EMULATION                                │   │
│  │                                                                                       │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │   │
│  │   │ Arduino CLI  │    │ ESP-IDF      │    │ QEMU Manager │    │ ngspice      │   │   │
│  │   │ (AVR/ARM)    │    │ (ESP32)      │    │ (System)     │    │ (WASM)       │   │   │
│  │   └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘   │   │
│  └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Agentic System: The Core Innovation

### Why an Agentic Approach?

Traditional embedded development requires:
1. Manual circuit design and component selection
2. Pin mapping and wire routing
3. Firmware writing and compilation
4. Iterative debugging

IntelliBoard's agentic system **automates this entire workflow** through an intelligent agent that reasons about hardware, manipulates the canvas directly, and validates its work through simulation.

### Agent Architecture (Pydantic AI)

```python
# Core architecture from backend/app/agent/agent.py

class AgentDeps:
    """Context object passed to every tool call"""
    db: AsyncSession           # Database session
    session_id: str            # Unique session identifier
    user_id: str               # Authenticated user
    snapshot: ProjectSnapshotV2  # Current project state
    state: AgentUiState        # UI context
    tool_calls: int            # Budget tracking

# Agent initialization with comprehensive system instructions
agent = Agent(
    model="openai:gpt-4.1",
    deps_type=AgentDeps,
    instructions="9-section comprehensive hardware engineering protocol...",
    builtin_tools=[WebSearchTool()]  # For documentation lookup
)
```

### Operation-Based Mutation Methodology

Unlike traditional AI systems that regenerate entire outputs, IntelliBoard uses **granular operations**:

| Approach | Traditional | IntelliBoard (Operation-Based) |
|----------|-------------|-------------------------------|
| Circuit edit | Regenerate entire JSON | `add_component()`, `connect_pins()`, `route_wire()` |
| Code edit | Rewrite whole file | `patch_file_lines()`, `apply_file_patch()` |
| Validation | Post-hoc linting | Real-time `validate_pin_mapping_state()` |
| Safety | None | Per-session locking, tool budgets, size limits |

**Key benefit:** Every mutation is atomic, reversible, and streamed to the UI in real-time via SSE.

### The 7-Step Wiring Protocol

The agent follows a rigorous protocol for circuit construction:

```
STEP 1: Add component/board → Get assigned ID
STEP 2: Fetch runtime pins from live DOM (NEVER guess)
STEP 3: Plan all connections before placing any wire
STEP 4: Connect power/ground first (VCC/GND priority)
STEP 5: Connect signal pins (shared buses before point-to-point)
STEP 6: Route every wire with computed waypoints (orthogonal L-shapes)
STEP 7: Validate with validate_pin_mapping_state()
```

**Wire routing rules enforced:**
- **R1:** No diagonal wires (strictly orthogonal)
- **R2:** L-shaped default with midpoint calculation
- **R3:** Pin exit clearance (20px outside component bbox)
- **R4:** Lane staggering for parallel wires
- **R5:** Power bus consolidation for 3+ components

### Tool Inventory (40+ Tools)

| Category | Tools | Purpose |
|----------|-------|---------|
| **Context** | `get_project_outline`, `get_component_detail`, `read_file` | Read current state |
| **Discovery** | `search_component_catalog`, `get_full_component_catalog`, `get_component_schema` | Find components |
| **Canvas** | `add_board`, `add_component`, `move_component`, `remove_component` | Physical layout |
| **Wiring** | `connect_pins`, `disconnect_wire`, `route_wire` | Connections |
| **Firmware** | `create_file`, `patch_file_lines`, `replace_file_content` | Code editing |
| **Build** | `compile_in_frontend`, `validate_compile_readiness` | Compilation |
| **Simulate** | `run_simulation`, `capture_serial_monitor` | Testing |
| **Library** | `search_libraries`, `install_library`, `list_installed_libraries` | Dependencies |

### Safety & Guardrails

```python
# From backend/app/agent/safety.py

MAX_PROMPT_CHARS = 50_000        # Token overflow prevention
MAX_SNAPSHOT_BYTES = 5_000_000   # Memory exhaustion guard
MAX_TOOL_CALLS = 100             # Infinite loop prevention
MAX_RUN_TIME_SECONDS = 300       # Runaway execution guard
```

Every mutation triggers Pydantic validation:
- Unique entity IDs
- Wire endpoints reference existing components
- File group consistency
- Board kind validity

---

## Multi-Architecture Emulation System

### Supported Boards Matrix

| Board | Architecture | Emulation Layer | FQBN | Languages |
|-------|--------------|-----------------|------|-----------|
| **Arduino Uno** | AVR ATmega328p | Browser (avr8js) | `arduino:avr:uno` | Arduino |
| **Arduino Nano** | AVR ATmega328p | Browser (avr8js) | `arduino:avr:nano:cpu=atmega328` | Arduino |
| **Arduino Mega** | AVR ATmega2560 | Browser (avr8js) | `arduino:avr:mega` | Arduino |
| **Raspberry Pi Pico** | ARM Cortex-M0+ | Browser (rp2040js) | `rp2040:rp2040:rpipico` | Arduino, MicroPython |
| **Raspberry Pi Pico W** | ARM Cortex-M0+ + WiFi | Browser (rp2040js) | `rp2040:rp2040:rpipicow` | Arduino, MicroPython |
| **ESP32** | Xtensa LX6 | Backend QEMU | `esp32:esp32:esp32` | Arduino, MicroPython |
| **ESP32-S3** | Xtensa LX7 | Backend QEMU | `esp32:esp32:esp32s3` | Arduino, MicroPython |
| **ESP32-C3** | RISC-V RV32IMC | Backend QEMU | `esp32:esp32:esp32c3` | Arduino, MicroPython |
| **ATtiny85** | AVR ATtiny85 | Browser (avr8js) | `ATTinyCore:avr:attinyx5:chip=85` | Arduino |
| **Raspberry Pi 3** | ARM Cortex-A53 | Backend QEMU | N/A (Python) | Python |

### Emulation Architecture

#### Browser-Native (No Backend Required)

```
┌─────────────────────────────────────────────────────┐
│                 BROWSER TAB                          │
│                                                      │
│  ┌─────────────┐    ┌─────────────┐                │
│  │   avr8js    │    │  rp2040js   │                │
│  │  (16MHz)    │    │  (133MHz)   │                │
│  │             │    │             │                │
│  │ • CPU core  │    │ • CPU core  │                │
│  │ • Timers    │    │ • Timers    │                │
│  │ • USART     │    │ • USB       │                │
│  │ • ADC       │    │ • ADC       │                │
│  │ • GPIO      │    │ • GPIO      │                │
│  └──────┬──────┘    └──────┬──────┘                │
│         │                   │                        │
│         ▼                   ▼                        │
│  ┌─────────────────────────────────────┐            │
│  │      PartSimulationRegistry         │            │
│  │   (16 registered component types)   │            │
│  └─────────────────────────────────────┘            │
└─────────────────────────────────────────────────────┘
```

**AVR8js** (@wokwi/avr8js): Real AVR8 CPU emulation at ~60fps, 267k cycles/frame
**RP2040js**: ARM Cortex-M0+ with PIO, USB, dual-core support

#### Backend QEMU Emulation (ESP32 Family)

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (Python/FastAPI)                  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              EspQemuManager                          │    │
│  │                                                      │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │    │
│  │  │ qemu-system │  │ qemu-system │  │ qemu-system │ │    │
│  │  │  -xtensa    │  │  -xtensa    │  │ -riscv32   │ │    │
│  │  │  (ESP32)    │  │  (ESP32-S3) │  │ (ESP32-C3) │ │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │    │
│  │         │                │                │        │    │
│  │         └────────────────┴────────────────┘        │    │
│  │                        │                           │    │
│  │         UART0 ──▶ TCP socket ──▶ Frontend         │    │
│  │         GPIO ──▶ Chardev socket ──▶ Frontend       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**QEMU Configuration per Board:**

| Board | QEMU Binary | Machine | Architecture |
|-------|-------------|---------|--------------|
| ESP32 | `qemu-system-xtensa` | `esp32` | Xtensa LX6 |
| ESP32-S3 | `qemu-system-xtensa` | `esp32s3` | Xtensa LX7 |
| ESP32-C3 | `qemu-system-riscv32` | `esp32c3` | RISC-V RV32IMC |

**Protocol:**
- UART0 → TCP socket (serial monitor)
- GPIO chardev → TCP socket (pin state I/O)
- Firmware loaded as MTD flash image

---

## Component System

### Component Catalog

**48+ electronic components** across 8 categories:

| Category | Components |
|----------|------------|
| **Boards** | Arduino Uno, Nano, Mega, ESP32 variants, Pi Pico |
| **Sensors** | DHT22, HC-SR04, PIR, Photoresistor |
| **Displays** | LCD 1602, LCD 2004, 7-Segment, OLED |
| **Input** | Pushbuttons, Switches, Potentiometers, Joystick |
| **Output** | LEDs, RGB LED, LED Bar Graph, Buzzer, Servo |
| **Motors** | Servo, Stepper |
| **Passive** | Resistor, Capacitor, Inductor |
| **Other** | Breadboard, Power supply, Connectors |

### Component Discovery Pipeline

```typescript
// Build-time generation from wokwi-elements source
scripts/generate-component-metadata.ts
  ↓
Parses TypeScript AST of wokwi-elements
  ↓
Extracts: tagName, properties, pinInfo, categories
  ↓
frontend/public/components-metadata.json
  ↓
ComponentRegistry (singleton)
  ↓
Agent tool: search_component_catalog()
```

**Key insight:** New wokwi-elements components appear automatically after rebuild — no manual registration.

### Runtime Pin Discovery

For accurate wiring, the agent fetches **live pin names from the rendered DOM:**

```python
# backend/app/agent/tools.py

async def get_canvas_runtime_pins(snapshot, instance_id) -> dict:
    """
    Returns pin names directly from the web component's pinInfo property.
    Retries 5 times (2.5s total) while component renders.
    
    This ensures the agent NEVER guesses pin names.
    """
    result = _get_canvas_runtime_pins(metadata_id)
    return {
        "instanceId": instance_id,
        "pinNames": result["pinNames"],  # e.g., ["A0", "A1", "D0", "D1"]
        "available": result["available"]
    }
```

---

## Frontend AI Integration: ai-elements

### Custom UI Component Library

IntelliBoard uses **@ai-sdk/react** with a custom component library (`ai-elements`) for streaming AI interactions:

```typescript
// Key components from frontend/src/components/ai-elements/

<Conversation>           // Scrollable message container
  <ConversationContent>
    <Message from="assistant">
      <MessageContent>
        <Reasoning>      // Collapsible thinking steps
          <ReasoningTrigger />
          <ReasoningContent />
        </Reasoning>
        <MessageResponse />  // Final output
      </MessageContent>
    </Message>
  </ConversationContent>
</Conversation>

<PromptInput>            // Composer with tool selector
  <PromptInputTextarea />
  <PromptInputTools>
    <CompactModelSelector />  // OpenAI, Copilot, etc.
  </PromptInputTools>
  <PromptInputSubmit />
</PromptInput>

<Tool>                   // Tool call visualization
  <ToolHeader type="dynamic-tool" state="output-available" />
  <ToolContent>
    <ToolInput input={toolInput} />
    <ToolOutput output={toolOutput} />
  </ToolContent>
</Tool>
```

### Streaming Architecture

```
User Message
    ↓
useChat() from @ai-sdk/react
    ↓
POST /api/agent/chat-stream
    ↓
Backend Agent (Pydantic AI)
    ↓
SSE Stream:
  • model.output.delta (text chunks)
  • tool.call.started / tool.call.result
  • snapshot.updated (state changes)
    ↓
UI Updates:
  • Text streaming in message
  • Tool call accordion expansion
  • Canvas updates from snapshot changes
```

### Agent-Canvas Synchronization

```typescript
// frontend/src/components/agent/useAgentSync.ts

export function useAgentSync(sessionId: string) {
  // 1. Listen to SSE events from backend
  // 2. On snapshot.updated:
  //    - Update useSimulatorStore (components, wires)
  //    - Update useEditorStore (file contents)
  // 3. On tool.call.result:
  //    - Show tool execution status
  // 4. Conflict resolution:
  //    - If local unsaved edits exist:
  //      - Duplicate file with `-agent` suffix
  //      - Apply agent changes to duplicate
}
```

---

## Board Support Libraries

### Arduino Library Management

The agent can search and install Arduino libraries dynamically:

```python
# Available tools
search_component_catalog(query="DHT22")  # Find components
search_libraries(query="DHT sensor library")  # Find libraries
install_library(name="DHT sensor library")  # Install
list_installed_libraries()  # Verify
```

### Board-Specific Library Recommendations

| Board | Common Libraries | Use Case |
|-------|------------------|----------|
| **Arduino Uno/Nano** | `Servo`, `LiquidCrystal`, `Wire` | Basic I/O, I2C |
| **Arduino Mega** | `SD`, `Ethernet`, `Servo` (48 servos) | Complex projects |
| **ESP32** | `WiFi`, `BluetoothSerial`, `ESP32Servo` | WiFi/BT connectivity |
| **ESP32-S3** | `USB`, `ESP32Servo`, `Arduino_GFX` | Display + USB OTG |
| **ESP32-C3** | `WiFi`, `ESP32Servo` | Cost-effective WiFi |
| **Pi Pico** | `WiFi` (Pico W), `pico-sdk` (native) | RP2040 native |
| **ATtiny85** | `TinyWireM`, `SoftwareSerial` | Low-power projects |

### FQBN-to-Library Mapping

```python
# backend/app/agent/board_mapping.py

BOARD_KIND_FQBN = {
    "arduino-uno": "arduino:avr:uno",
    "arduino-nano": "arduino:avr:nano:cpu=atmega328",
    "arduino-mega": "arduino:avr:mega",
    "esp32": "esp32:esp32:esp32",
    "esp32-s3": "esp32:esp32:esp32s3",
    "esp32-c3": "esp32:esp32:esp32c3",
    "raspberry-pi-pico": "rp2040:rp2040:rpipico",
    "pi-pico-w": "rp2040:rp2040:rpipicow",
    "attiny85": "ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz",
}
```

---

## Key Differentiators for Evaluators

### 1. True Agentic Hardware Engineering

- **Not just code generation:** The agent reasons about circuits, places components, routes wires
- **Live DOM integration:** Pin names come from rendered components, not static schemas
- **Validation-driven:** Every step validated (pin mapping, compile readiness, simulation)

### 2. Hybrid Emulation Architecture

- **Browser-native:** AVR and RP2040 run at ~60fps without backend
- **Backend-accelerated:** ESP32 family via QEMU with GPIO bridging
- **Unified interface:** Same API regardless of emulation layer

### 3. Operation-Based Safety

- **Atomic mutations:** Each tool call is a discrete operation
- **Draft pattern:** Original state preserved until user applies
- **Guardrails:** Tool budgets, time limits, size limits prevent runaway

### 4. Real-Time Collaborative AI

- **Streaming SSE:** Live tool execution visibility
- **Canvas sync:** Agent changes appear in real-time
- **Conflict resolution:** User edits preserved when agent acts

### 5. Extensible Component Ecosystem

- **Automatic discovery:** Build-time metadata extraction
- **Wokwi compatibility:** Official wokwi-elements library
- **48+ components:** From basic LEDs to complex sensors/displays

---

## Technical Stack Summary

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend Framework** | React 19 + Vite 7 | UI rendering |
| **State Management** | Zustand 5 | Stores (editor, simulator, agent) |
| **AI Integration** | @ai-sdk/react + ai-elements | Streaming chat |
| **Agent Runtime** | Pydantic AI | Python agent framework |
| **Backend** | FastAPI + SQLAlchemy | API + persistence |
| **AVR Emulation** | avr8js (Wokwi) | Browser AVR8 |
| **ARM Emulation** | rp2040js (Wokwi) | Browser RP2040 |
| **ESP32 Emulation** | QEMU (Xtensa/RISC-V) | Backend ESP32 family |
| **Circuit Simulation** | ngspice-wasm | SPICE analysis |
| **Compilation** | arduino-cli | Multi-platform builds |
| **Components** | wokwi-elements | 48+ web components |

---

## Conclusion

IntelliBoard represents a paradigm shift in embedded systems development by combining:

1. **Autonomous AI agent** capable of end-to-end hardware engineering
2. **Multi-architecture emulation** spanning 8+ board families
3. **Browser-native performance** for AVR/ARM with backend acceleration for ESP32
4. **Safety-first design** with operation-based mutations and comprehensive guardrails

The platform enables users to describe a circuit in natural language and watch as the AI designs the schematic, writes the firmware, compiles it, and runs simulation — all within a collaborative, streaming interface.
