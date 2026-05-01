from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.agent.runtime_pin_catalog import get_observed_pin_names

_PIN_OVERRIDES: dict[str, list[str]] = {
    "led": ["A", "C"],
    "rgb-led": ["R", "G", "B", "COM"],
    "resistor": ["1", "2"],
}

_COMPONENT_ID_ALIASES: dict[str, str] = {
    # Common board aliases used by models/users.
    "esp32": "esp32-devkit-v1",
    "wokwi-esp32-devkit-v1": "esp32-devkit-v1",
}


@lru_cache(maxsize=1)
def load_component_catalog() -> list[dict[str, Any]]:
    root = Path(__file__).resolve().parents[3]
    path = root / "frontend" / "public" / "components-metadata.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    components = data.get("components", [])
    return components if isinstance(components, list) else []


def search_component_catalog(
    query: str,
    *,
    category: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    q = query.strip().lower()
    if not q:
        raise ValueError("query is required")
    results: list[tuple[int, dict[str, Any]]] = []
    for component in load_component_catalog():
        if category and component.get("category") != category:
            continue
        haystack = " ".join(
            [
                str(component.get("id", "")),
                str(component.get("name", "")),
                str(component.get("description", "")),
                " ".join(str(tag) for tag in component.get("tags", [])),
            ]
        ).lower()
        if q not in haystack:
            continue
        score = 0
        if str(component.get("id", "")).lower() == q:
            score += 100
        if q in str(component.get("name", "")).lower():
            score += 50
        if q in " ".join(str(tag).lower() for tag in component.get("tags", [])):
            score += 25
        results.append((score, _compact_component(component)))
    results.sort(key=lambda item: (-item[0], item[1].get("id", "")))
    return [item for _, item in results[:limit]]


def get_component_schema(component_id: str) -> dict[str, Any]:
    component = _find_component(component_id)
    if component is None:
        # Return a structured "missing schema" payload instead of raising so a
        # single lookup miss does not abort the full agent run.
        return {
            "id": component_id,
            "tagName": None,
            "name": component_id,
            "category": None,
            "description": None,
            "pinCount": 0,
            "pinNames": [],
            "pinDetails": [],
            "properties": [],
            "defaultValues": {},
            "missing": ["component"],
            "pinNamesSource": "missing",
            "ok": False,
            "error": f"component not found: {component_id}",
        }

    metadata_pin_names = component.get("pinNames") or []
    override_pin_names = _PIN_OVERRIDES.get(component.get("id", "")) or []
    observed_pin_names = get_observed_pin_names(str(component.get("id", "")))
    pin_names = _merge_pin_names(observed_pin_names, metadata_pin_names, override_pin_names)
    if observed_pin_names:
        pin_names_source = "runtime+catalog"
    elif metadata_pin_names:
        pin_names_source = "metadata"
    elif override_pin_names:
        pin_names_source = "override"
    else:
        pin_names_source = "missing"
    missing: list[str] = []
    pin_count = int(component.get("pinCount", 0) or 0)
    if pin_count > 0 and not pin_names:
        # Broad fallback for components that declare pinCount but not explicit names
        # (common in custom catalog entries). This avoids "blind guessing" by the
        # agent and gives it a deterministic canonical pin namespace.
        pin_names = [str(i) for i in range(1, pin_count + 1)]
        pin_names_source = "inferred_sequential"
        missing.append("pinNames")

    pin_details = [
        {
            "name": name,
            "role": _infer_pin_role(name),
        }
        for name in (pin_names or [])
    ]

    return {
        "id": component.get("id"),
        "tagName": component.get("tagName"),
        "name": component.get("name"),
        "category": component.get("category"),
        "description": component.get("description"),
        "pinCount": pin_count,
        "pinNames": pin_names,
        "pinDetails": pin_details,
        "properties": component.get("properties", []),
        "defaultValues": component.get("defaultValues", {}),
        "missing": missing,
        "pinNamesSource": pin_names_source,
    }


def list_component_schema_gaps(limit: int = 20) -> dict[str, Any]:
    components = load_component_catalog()
    missing_pin_names: list[str] = []
    for component in components:
        pin_count = component.get("pinCount", 0) or 0
        if pin_count > 0 and not component.get("pinNames") and component.get("id") not in _PIN_OVERRIDES:
            missing_pin_names.append(component.get("id", ""))

    return {
        "totalComponents": len(components),
        "missingPinNames": len(missing_pin_names),
        "missingPinNamesSample": missing_pin_names[:limit],
    }


def _compact_component(component: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": component.get("id"),
        "tagName": component.get("tagName"),
        "name": component.get("name"),
        "category": component.get("category"),
        "description": component.get("description"),
        "pinCount": component.get("pinCount"),
        "defaultValues": component.get("defaultValues", {}),
    }


def _find_component(component_id: str) -> dict[str, Any] | None:
    needle = component_id.strip().lower()
    if not needle:
        return None
    needle = _COMPONENT_ID_ALIASES.get(needle, needle)

    components = load_component_catalog()
    needle_norm = _normalize_key(needle)
    needle_tokens = _tokenize_key(needle)

    # Pass 1: exact id/tagName match (strictest; avoids broad tag collisions).
    for component in components:
        cid = str(component.get("id", "")).strip().lower()
        tag = str(component.get("tagName", "")).strip().lower()
        if needle == cid or needle == tag:
            return component
        if needle_norm and (needle_norm == _normalize_key(cid) or needle_norm == _normalize_key(tag)):
            return component

    # Pass 2: exact match on tags/name.
    for component in components:
        name = str(component.get("name", "")).strip().lower()
        tags = [str(tag).strip().lower() for tag in component.get("tags", [])]
        if needle == name or needle in tags:
            return component
        if needle_norm and (
            needle_norm == _normalize_key(name)
            or any(needle_norm == _normalize_key(tag) for tag in tags)
        ):
            return component

    # Pass 3: ranked fuzzy match for broad board variant names.
    scored: list[tuple[int, dict[str, Any]]] = []
    for component in components:
        cid = str(component.get("id", "")).strip().lower()
        tag = str(component.get("tagName", "")).strip().lower()
        name = str(component.get("name", "")).strip().lower()
        tags = [str(tag).strip().lower() for tag in component.get("tags", [])]
        key_norms = [_normalize_key(k) for k in [cid, tag, name, *tags] if k]
        key_tokens = set().union(*(_tokenize_key(k) for k in [cid, tag, name, *tags] if k))
        if not key_norms:
            continue

        score = 0
        if needle_norm and (needle_norm == _normalize_key(cid) or needle_norm == _normalize_key(tag)):
            score += 150
        if needle_norm and any(needle_norm == kn for kn in key_norms):
            score += 80
        if needle_norm and any(needle_norm in kn for kn in key_norms):
            score += 40
        overlap = len(needle_tokens & key_tokens)
        if overlap:
            score += overlap * 15
        # Prefer board-family components when query looks board-like.
        if component.get("category") == "boards" and needle_tokens & {"esp32", "pico", "arduino", "attiny"}:
            score += 10

        if score > 0:
            scored.append((score, component))

    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], str(item[1].get("id", ""))))
    best_score, best_component = scored[0]
    # Avoid overly weak accidental matches.
    return best_component if best_score >= 20 else None


def _normalize_key(value: str) -> str:
    lowered = value.strip().lower()
    # Common prefixes in metadata/tag IDs.
    lowered = lowered.replace("wokwi-", "")
    lowered = lowered.replace("devkit", "dev-kit")
    return "".join(ch for ch in lowered if ch.isalnum())


def _tokenize_key(value: str) -> set[str]:
    lowered = value.strip().lower().replace("wokwi-", "")
    tokens = [t for t in re.split(r"[^a-z0-9]+", lowered) if t]
    # Add compact form for cases like "esp32s3" and split family+suffix heuristics.
    compact = "".join(tokens)
    if compact:
        tokens.append(compact)
    if compact.startswith("esp32") and len(compact) > 5:
        tokens.extend(["esp32", compact[5:]])
    return set(tokens)


def _infer_pin_role(pin_name: str) -> str:
    n = (pin_name or "").strip().lower()
    if not n:
        return "unknown"
    if n in {"gnd", "ground", "vss", "vss1", "vss2"} or n.startswith("gnd"):
        return "ground"
    if n in {"vcc", "vdd", "vin", "5v", "3v3", "3.3v"} or n.startswith("vcc") or n.startswith("vdd"):
        return "power"
    if n.startswith("com"):
        return "common"
    if n.startswith("sig") or n.startswith("out") or n.startswith("in") or n in {"a", "b", "c", "d", "e", "f", "g", "dp"}:
        return "signal"
    if n.startswith("clk") or n in {"scl", "sda", "mosi", "miso", "sck", "rx", "tx"}:
        return "signal"
    return "unknown"


def _merge_pin_names(*sources: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for source in sources:
        for item in source or []:
            if not isinstance(item, str):
                continue
            name = item.strip()
            if not name or name in seen:
                continue
            seen.add(name)
            merged.append(name)
    return merged
