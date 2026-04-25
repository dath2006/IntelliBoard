"""Board / FQBN classification helpers."""

# Maps the first segment of an FQBN ("arduino:avr:uno" → "arduino") plus a
# couple of friendly board_type values used by the frontend ProjectStore.
_FAMILY_BY_VENDOR = {
    "arduino": "arduino",
    "esp32": "esp32",
    "rp2040": "rp2040",
    "raspberry": "raspberry-pi",
    "RPiPico": "rp2040",
}

# Friendly board_type → family (used when no FQBN is present, e.g. project.board_type)
_FAMILY_BY_BOARD_TYPE = {
    "arduino-uno": "arduino",
    "arduino-nano": "arduino",
    "arduino-mega": "arduino",
    "raspberry-pi-pico": "rp2040",
    "raspberry-pi-3": "raspberry-pi",
    "esp32": "esp32",
    "esp32-s3": "esp32",
    "esp32-c3": "esp32",
}


def board_family_from_fqbn(fqbn: str | None) -> str | None:
    """Return the board family slug for a given FQBN.

    Examples:
        arduino:avr:uno         → arduino
        esp32:esp32:esp32       → esp32
        rp2040:rp2040:rpipico   → rp2040
    """
    if not fqbn:
        return None
    vendor = fqbn.split(":", 1)[0].lower()
    return _FAMILY_BY_VENDOR.get(vendor, vendor)


def board_family_from_board_type(board_type: str | None) -> str | None:
    """Return the board family slug for a friendly board_type value."""
    if not board_type:
        return None
    return _FAMILY_BY_BOARD_TYPE.get(board_type, board_type)
