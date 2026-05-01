from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock


@dataclass
class _RuntimePinEntry:
    tag_name: str | None = None
    # Union of all observed pin names for a metadata id.
    pin_names: list[str] = field(default_factory=list)
    # Optional per-signature observations (future use/debugging).
    by_signature: dict[str, list[str]] = field(default_factory=dict)


_LOCK = Lock()
_BY_METADATA: dict[str, _RuntimePinEntry] = {}


def record_pin_observation(
    *,
    metadata_id: str,
    tag_name: str | None,
    pin_names: list[str],
    signature: str | None = None,
) -> None:
    mid = (metadata_id or "").strip().lower()
    if not mid:
        return

    clean_names: list[str] = []
    seen: set[str] = set()
    for name in pin_names:
        n = (name or "").strip()
        if not n:
            continue
        if n in seen:
            continue
        seen.add(n)
        clean_names.append(n)
    if not clean_names:
        return

    with _LOCK:
        entry = _BY_METADATA.setdefault(mid, _RuntimePinEntry())
        if tag_name and not entry.tag_name:
            entry.tag_name = tag_name

        # Merge into global union while preserving first-seen ordering.
        existing = set(entry.pin_names)
        for n in clean_names:
            if n not in existing:
                entry.pin_names.append(n)
                existing.add(n)

        # Track optional signature-specific pin list.
        if signature:
            entry.by_signature[signature] = clean_names


def get_observed_pin_names(metadata_id: str) -> list[str]:
    mid = (metadata_id or "").strip().lower()
    if not mid:
        return []
    with _LOCK:
        entry = _BY_METADATA.get(mid)
        return list(entry.pin_names) if entry else []

