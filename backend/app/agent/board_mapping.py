from __future__ import annotations


BOARD_KIND_FQBN: dict[str, str | None] = {
    "arduino-uno": "arduino:avr:uno",
    "arduino-nano": "arduino:avr:nano:cpu=atmega328",
    "arduino-mega": "arduino:avr:mega",
    "raspberry-pi-pico": "rp2040:rp2040:rpipico",
    "pi-pico-w": "rp2040:rp2040:rpipicow",
    "raspberry-pi-3": None,
    "esp32": "esp32:esp32:esp32",
    "esp32-devkit-c-v4": "esp32:esp32:esp32",
    "esp32-cam": "esp32:esp32:esp32cam",
    "wemos-lolin32-lite": "esp32:esp32:lolin32-lite",
    "esp32-s3": "esp32:esp32:esp32s3",
    "xiao-esp32-s3": "esp32:esp32:XIAO_ESP32S3",
    "arduino-nano-esp32": "esp32:esp32:nano_nora",
    "esp32-c3": "esp32:esp32:esp32c3",
    "xiao-esp32-c3": "esp32:esp32:XIAO_ESP32C3",
    "aitewinrobot-esp32c3-supermini": "esp32:esp32:esp32c3",
    "attiny85": "ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz",
}

# Accept legacy/catalog aliases and normalize them to canonical board kinds.
# This keeps agent tool calls robust when model picks a board metadata id/tag
# that is semantically equivalent to a supported kind.
BOARD_KIND_ALIASES: dict[str, str] = {
    "wokwi-arduino-uno": "arduino-uno",
    "wokwi-arduino-nano": "arduino-nano",
    "wokwi-arduino-mega": "arduino-mega",
    "wokwi-pi-pico": "raspberry-pi-pico",
    "wokwi-raspberry-pi-pico": "raspberry-pi-pico",
    "wokwi-pi-pico-w": "pi-pico-w",
    "wokwi-raspberry-pi-3": "raspberry-pi-3",
    "wokwi-esp32-devkit-v1": "esp32",
    "esp32-devkit-v1": "esp32",
    "wokwi-esp32-devkit-c-v4": "esp32-devkit-c-v4",
    "wokwi-esp32-cam": "esp32-cam",
    "wokwi-wemos-lolin32-lite": "wemos-lolin32-lite",
    "wokwi-esp32-s3": "esp32-s3",
    "wokwi-xiao-esp32-s3": "xiao-esp32-s3",
    "wokwi-arduino-nano-esp32": "arduino-nano-esp32",
    "wokwi-esp32-c3": "esp32-c3",
    "wokwi-xiao-esp32-c3": "xiao-esp32-c3",
    "wokwi-aitewinrobot-esp32c3-supermini": "aitewinrobot-esp32c3-supermini",
    "wokwi-attiny85": "attiny85",
}


def canonical_board_kind(board_kind: str) -> str:
    raw = (board_kind or "").strip().lower()
    if not raw:
        return raw

    if raw in BOARD_KIND_FQBN:
        return raw
    if raw in BOARD_KIND_ALIASES:
        return BOARD_KIND_ALIASES[raw]

    # Generic family fallback (defensive):
    # if the model picks an unknown ESP32 board variant id, map by family.
    normalized = raw.replace("_", "-")
    if "esp32c3" in normalized or "esp32-c3" in normalized:
        return "esp32-c3"
    if "esp32s3" in normalized or "esp32-s3" in normalized:
        return "esp32-s3"
    if "esp32" in normalized:
        return "esp32"
    if "pico-w" in normalized:
        return "pi-pico-w"
    if "pico" in normalized:
        return "raspberry-pi-pico"
    return raw


def is_supported_board_kind(board_kind: str) -> bool:
    return canonical_board_kind(board_kind) in BOARD_KIND_FQBN


def fqbn_for_board_kind(board_kind: str) -> str | None:
    canonical = canonical_board_kind(board_kind)
    if canonical not in BOARD_KIND_FQBN:
        raise ValueError(f"unsupported board kind: {board_kind}")
    return BOARD_KIND_FQBN[canonical]
