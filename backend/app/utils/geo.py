"""Country detection from request headers.

Production runs behind Cloudflare, which adds the `CF-IPCountry` header
on every request — ISO-3166 alpha-2 country code (or 'XX' / 'T1' for
unknown / Tor). We just read it; no DB, no API calls, no PII (country
only — no city, no IP stored).
"""

from fastapi import Request

# Special CF values that mean "unknown" / "anonymized" — treat as None.
_UNKNOWN_VALUES = {"XX", "T1", "", "ZZ"}


def country_from_request(request: Request | None) -> str | None:
    """Return ISO-3166 alpha-2 country code, or None.

    Reads `CF-IPCountry` (Cloudflare). Returns None in dev (no header),
    for Tor users, or unknown geolocation.
    """
    if request is None:
        return None
    raw = request.headers.get("cf-ipcountry") or request.headers.get("CF-IPCountry")
    if not raw:
        return None
    code = raw.strip().upper()
    if code in _UNKNOWN_VALUES or len(code) != 2:
        return None
    return code
