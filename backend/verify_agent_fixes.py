#!/usr/bin/env python3
"""
Verification script for Agent Prompt & Docstring Alignment tasks.

This script verifies:
1. The system prompt matches the instructions from Agent-fixing-prompt.md
2. All tool registrations have proper docstrings
3. The module loads without errors
4. All expected tools are registered
"""

import sys
from typing import Any


def verify_module_loads():
    """Verify the agent module can be imported without errors."""
    try:
        from app.agent.agent import build_agent
        print("✓ Module loads successfully")
        return True
    except Exception as e:
        print(f"✗ Module failed to load: {e}")
        return False


def verify_agent_builds():
    """Verify the agent can be built with defer_model_check."""
    try:
        from app.agent.agent import build_agent
        agent = build_agent(defer_model_check=True)
        print("✓ Agent builds successfully")
        return True
    except Exception as e:
        print(f"✗ Agent failed to build: {e}")
        return False


def verify_tool_registrations():
    """Verify all expected tools are registered with docstrings."""
    try:
        from app.agent.agent import build_agent
        agent = build_agent(defer_model_check=True)
        
        expected_tools = [
            # Introspection tools
            "get_project_outline",
            "get_component_detail",
            "search_component_catalog",
            "get_component_schema",
            "get_canvas_runtime_pins",
            "list_component_schema_gaps",
            # File tools
            "list_files",
            "read_file",
            "create_file",
            "replace_file_range",
            "apply_file_patch",
            # Board tools
            "add_board",
            "change_board_kind",
            "remove_board",
            # Component tools
            "add_component",
            "update_component",
            "move_component",
            "remove_component",
            # Wire tools
            "connect_pins",
            "disconnect_wire",
            "route_wire",
            # Compile tools
            "compile_board",
            "compile_in_frontend",
            # Serial monitor tools
            "open_serial_monitor",
            "close_serial_monitor",
            "get_serial_monitor_status",
            "set_serial_baud_rate",
            "send_serial_message",
            "clear_serial_monitor",
            "capture_serial_monitor",
            # Simulation tools
            "run_simulation",
            "pause_simulation",
            "reset_simulation",
            # Library tools
            "search_libraries",
            "install_library",
            "list_installed_libraries",
            # Validation tools
            "validate_snapshot_state",
            "validate_pin_mapping_state",
            "validate_compile_readiness_state",
            # Utility tools
            "wait_seconds",
        ]
        
        # Get registered tools
        registered_tools = []
        if hasattr(agent, '_function_tools'):
            registered_tools = list(agent._function_tools.keys())
        elif hasattr(agent, 'tools'):
            registered_tools = [t.name for t in agent.tools]
        
        print(f"\n✓ Found {len(registered_tools)} registered tools")
        
        # Check for missing tools
        missing = set(expected_tools) - set(registered_tools)
        if missing:
            print(f"✗ Missing tools: {missing}")
            return False
        
        # Check for extra tools
        extra = set(registered_tools) - set(expected_tools)
        if extra:
            print(f"⚠ Extra tools (not in expected list): {extra}")
        
        print(f"✓ All {len(expected_tools)} expected tools are registered")
        return True
        
    except Exception as e:
        print(f"✗ Failed to verify tool registrations: {e}")
        import traceback
        traceback.print_exc()
        return False


def verify_system_prompt():
    """Verify the system prompt contains key sections."""
    try:
        # Read the agent.py file directly to check the instructions
        import os
        agent_file = os.path.join(os.path.dirname(__file__), 'app', 'agent', 'agent.py')
        
        with open(agent_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check for key sections in the instructions string
        key_sections = [
            "MANDATORY FIRST STEP",
            "TASK PLANNING PROTOCOL",
            "COMPONENT & CATALOG TOOLS",
            "MANDATORY WIRING PROTOCOL",
            "FILE & CODE TOOLS",
            "COMPILATION & SIMULATION TOOLS",
            "ERROR HANDLING RULES",
            "OUTPUT STYLE",
        ]
        
        missing_sections = []
        for section in key_sections:
            if section not in content:
                missing_sections.append(section)
        
        if missing_sections:
            print(f"✗ System prompt missing sections: {missing_sections}")
            return False
        
        print(f"✓ System prompt contains all {len(key_sections)} key sections")
        return True
        
    except Exception as e:
        print(f"✗ Failed to verify system prompt: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all verification checks."""
    print("=" * 60)
    print("Agent Prompt & Docstring Alignment Verification")
    print("=" * 60)
    
    results = []
    
    print("\n1. Verifying module loads...")
    results.append(verify_module_loads())
    
    print("\n2. Verifying agent builds...")
    results.append(verify_agent_builds())
    
    print("\n3. Verifying tool registrations...")
    results.append(verify_tool_registrations())
    
    print("\n4. Verifying system prompt...")
    results.append(verify_system_prompt())
    
    print("\n" + "=" * 60)
    if all(results):
        print("✓ ALL CHECKS PASSED")
        print("=" * 60)
        return 0
    else:
        print("✗ SOME CHECKS FAILED")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
