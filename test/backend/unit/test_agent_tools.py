"""Focused unit tests for agent tool safety and validation logic."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend/ is importable.
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "backend"))

from app.agent.tools import debug_code, fix_errors, validate_circuit


class TestValidateCircuit:
    @pytest.mark.anyio
    async def test_detects_board_pin_conflicts_using_from_to_pin_fields(self):
        circuit = {
            "components": [
                {"id": "uno", "type": "wokwi-arduino-uno"},
                {"id": "led1", "type": "wokwi-led"},
                {"id": "bz1", "type": "wokwi-buzzer"},
            ],
            "connections": [
                {"from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A"},
                {"from_part": "bz1", "from_pin": "1", "to_part": "uno", "to_pin": "13"},
            ],
        }

        result = await validate_circuit(circuit)

        assert not result.is_valid
        assert result.pin_conflicts
        assert any(conflict["pin"] == "13" for conflict in result.pin_conflicts)


class TestDebugCodeFixes:
    @pytest.mark.anyio
    async def test_wrong_argument_fix_only_updates_single_arg_digitalwrite_calls(self):
        code = """void loop() {
  digitalWrite(LED_PIN);
  digitalWrite(BTN_PIN, LOW);
}
"""

        result = await debug_code(
            code=code,
            circuit={},
            compilation_error="wrong number of arguments to function 'digitalWrite'",
        )

        assert "digitalWrite(LED_PIN, HIGH)" in result.code_fix
        assert "digitalWrite(BTN_PIN, LOW)" in result.code_fix


class TestFixErrorsSafety:
    @pytest.mark.anyio
    async def test_logic_fix_inserts_delay_inside_braced_infinite_loop(self):
        code = """void loop() {
  while(true) {
    doWork();
  }
}
"""

        result = await fix_errors(code=code, error_type="logic", circuit={})
        fixed = result["fixed_code"]

        assert "delay(100);" in fixed
        # Brace count should remain balanced after the transform.
        assert fixed.count("{") == fixed.count("}")
