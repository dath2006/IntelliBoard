# Velxio (IntelliBoard) Project Context

## Project Overview

Velxio (also referenced as IntelliBoard) is a fully local, open-source multi-board hardware and embedded systems emulator. It provides an interactive web-based environment where developers can write code (C++ or Python), construct electronic circuits from a rich library of components, and simulate them using real CPU emulation.

### Core Capabilities
- **Multi-Architecture Simulation**: Supports an impressive range of architectures including AVR8 (Arduino Uno/Mega/Nano), ARM Cortex-M0+ (Raspberry Pi Pico), Xtensa LX6/LX7 (ESP32 series), RISC-V (ESP32-C3/CH32V003), and ARM Cortex-A53 (Raspberry Pi 3 Linux via QEMU).
- **Interactive Hardware Sandbox**: A robust frontend built with React 19 and Vite featuring a Monaco editor, a comprehensive wire routing system, and over 48 interactive components (sensors, displays, motors, logic chips).
- **Real Compilation**: A FastAPI Python backend that wraps `arduino-cli`, compiling actual `.hex` and `.bin` files for the simulated hardware.

---

## The Agentic Layer (Core Focus)

The defining and most powerful aspect of this project is its **Agentic Layer**, implemented via the **Model Context Protocol (MCP)**. This layer transforms Velxio from a traditional human-facing IDE into a fully programmable sandbox for AI agents (like Claude Desktop, Cursor, or autonomous systems). 

By exposing the emulator's internals via MCP, AI agents can autonomously iterate on embedded hardware designs and code, closing the loop on AI-assisted hardware engineering.

### What the Agentic Layer Does

The MCP server exposes a suite of high-level tools that allow an AI to act as an embedded engineer:

1. **Autonomous Circuit Design**: Agents use tools like `create_circuit` and `update_circuit` to define hardware topologies in structured JSON. They can place components (e.g., LEDs, I2C displays, servos) and map out electrical connections and wiring programmatically.
2. **Code Generation & Scaffold**: Using `generate_code_files`, the AI can generate the corresponding `.ino` or Python scripts perfectly tailored to the circuit it just designed.
3. **Automated Compilation & Validation**: Agents invoke `compile_project` and `run_project` to pass their generated code through the actual `arduino-cli` compiler. They receive deterministic feedback (compiler warnings, errors, or successful hex artifacts) allowing them to debug their own work without human intervention.
4. **Format Interoperability**: With `import_wokwi_json` and `export_wokwi_json`, the agent can translate projects between Velxio's internal state and the popular Wokwi format.

### Agentic Architecture Hardening & Guardrails

To make the AI interactions reliable and production-grade, the agentic architecture has been explicitly hardened:

- **Token-Efficient Granular Tooling**: Instead of passing massive, monolithic JSON dumps of the entire canvas state (which overwhelms LLM context windows), the agent interacts via granular, metadata-driven tools. This makes the agent's actions precise and token-efficient.
- **Atomic State Synchronization**: When an agent performs complex operations, like a board-kind transition (e.g., swapping an Uno for an ESP32), the system enforces atomic synchronization of pin mappings, file groups, and UI canvas state to prevent invalid hardware configurations.
- **Post-Mutation Validation**: The system enforces rigorous guardrails. Any time the agent mutates a circuit, mandatory post-mutation validations verify the structural and electrical integrity of the connections before allowing simulation. 
- **Sandboxed Execution**: AI-driven compilations run in temporary, isolated directories, ensuring host system security while the AI experiments.

### The Vision of the Agentic Layer

In traditional software development, AI agents can write code and run test suites to verify their work. In embedded development, this feedback loop is usually broken because it requires physical hardware. 

The Velxio Agentic Layer solves this. By providing the AI with tools to **build the circuit, write the firmware, compile it, and receive compiler feedback**, the agent can engage in true Test-Driven Development (TDD) for hardware. It empowers the AI to experiment, fail, read logs, and fix embedded systems autonomously.
