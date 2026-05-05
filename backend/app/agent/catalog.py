from __future__ import annotations

import json
import re
import os
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.agent.runtime_pin_catalog import get_observed_pin_names

log = logging.getLogger(__name__)

_COMPONENT_ID_ALIASES: dict[str, str] = {
    # Common board aliases used by models/users.
    "esp32": "esp32-devkit-v1",
    "wokwi-esp32-devkit-v1": "esp32-devkit-v1",
}

_QUERY_STOPWORDS: set[str] = {
    "display",
    "module",
    "component",
    "board",
    "sensor",
    "part",
}


@lru_cache(maxsize=1)
def load_component_catalog() -> list[dict[str, Any]]:
    root = Path(__file__).resolve().parents[3]
    candidates: list[Path] = []
    configured = (os.getenv("COMPONENT_CATALOG_PATH") or "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.extend(
        [
            # Local repo/dev path.
            root / "frontend" / "public" / "components-metadata.json",
            # Frontend build output path in some local setups.
            root / "frontend" / "dist" / "components-metadata.json",
            # Docker image path where frontend static assets are copied.
            Path("/usr/share/nginx/html/components-metadata.json"),
        ]
    )
    for path in candidates:
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        components = data.get("components", [])
        if isinstance(components, list):
            return components
    return []


def search_component_catalog(
    query: str,
    *,
    category: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    q = query.strip().lower()
    if not q:
        raise ValueError("query is required")
    q_norm = _normalize_key(q)
    q_tokens = _filter_query_tokens(_tokenize_key(q))
    log.debug(
        "component_search query=%r q_norm=%r q_tokens=%s",
        query,
        q_norm,
        sorted(q_tokens),
    )
    results: list[tuple[int, dict[str, Any]]] = []
    for component in load_component_catalog():
        if category and component.get("category") != category:
            continue
        cid = str(component.get("id", ""))
        name = str(component.get("name", ""))
        desc = str(component.get("description", ""))
        tags = [str(tag) for tag in component.get("tags", [])]
        haystack = " ".join([cid, name, desc, " ".join(tags)]).lower()
        haystack_norm = _normalize_key(haystack)
        haystack_tokens = set().union(*(_tokenize_key(value) for value in [cid, name, desc, *tags] if value))

        token_match = _token_overlap_match(q_tokens, haystack_tokens)
        fuzzy_match = _fuzzy_token_match(q_tokens, haystack_tokens)
        if q not in haystack and (not q_norm or q_norm not in haystack_norm) and not token_match and not fuzzy_match:
            continue
        score = 0
        if str(component.get("id", "")).lower() == q:
            score += 100
        if q in str(component.get("name", "")).lower():
            score += 50
        if q in " ".join(str(tag).lower() for tag in component.get("tags", [])):
            score += 25
        if token_match:
            score += 15 * len(q_tokens)
        if fuzzy_match:
            score += 6 * len(q_tokens)
        if q_norm and q_norm in haystack_norm:
            score += 20
        results.append((score, _compact_component(component)))
    results.sort(key=lambda item: (-item[0], item[1].get("id", "")))
    top = [item for _, item in results[:limit]]
    log.debug(
        "component_search matched=%d returned=%d",
        len(results),
        len(top),
    )
    return top


def get_component_schema(component_id: str) -> dict[str, Any]:
    """Return catalog metadata for a component type.

    NOTE: pinNames here come from static metadata only — they may be incomplete
    or wrong for some components.  Always prefer get_canvas_runtime_pins() for
    wiring decisions; use this only for properties / description / category.
    """
    component = _find_component(component_id)
    if component is None:
        return {
            "id": component_id,
            "tagName": None,
            "name": component_id,
            "category": None,
            "description": None,
            "pinCount": 0,
            "properties": [],
            "defaultValues": {},
            "ok": False,
            "error": f"component not found: {component_id}",
        }

    return {
        "id": component.get("id"),
        "tagName": component.get("tagName"),
        "name": component.get("name"),
        "category": component.get("category"),
        "description": component.get("description"),
        "pinCount": int(component.get("pinCount", 0) or 0),
        "properties": component.get("properties", []),
        "defaultValues": component.get("defaultValues", {}),
    }


def get_canvas_runtime_pins(metadata_id: str) -> dict[str, Any]:
    """Return ONLY the pin names observed from the live DOM canvas.

    These are posted by the frontend after reading element.pinInfo directly
    from the rendered wokwi custom elements — the ground truth for what pin
    names connect_pins actually accepts.  No normalization, no fallbacks,
    no guessing.  If the canvas has not rendered the component yet (i.e. the
    frontend observation has not arrived), pinNames will be empty and
    available will be False.
    """
    mid = (metadata_id or "").strip().lower()
    if not mid:
        return {"metadataId": metadata_id, "available": False, "pinNames": []}

    pin_names = get_observed_pin_names(mid)
    return {
        "metadataId": mid,
        "available": bool(pin_names),
        "pinNames": pin_names,
    }


def list_component_schema_gaps(limit: int = 20) -> dict[str, Any]:
    components = load_component_catalog()
    missing_pin_names: list[str] = []
    for component in components:
        pin_count = component.get("pinCount", 0) or 0
        if pin_count > 0 and not component.get("pinNames"):
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


def _filter_query_tokens(tokens: set[str]) -> set[str]:
    return {t for t in tokens if t and t not in _QUERY_STOPWORDS}


def _token_overlap_match(query_tokens: set[str], haystack_tokens: set[str]) -> bool:
    if not query_tokens or not haystack_tokens:
        return False
    overlap = len(query_tokens & haystack_tokens)
    if overlap == 0:
        return False
    required = max(1, len(query_tokens) - 1)
    return overlap >= required


def _fuzzy_token_match(query_tokens: set[str], haystack_tokens: set[str]) -> bool:
    if not query_tokens or not haystack_tokens:
        return False
    for q in query_tokens:
        if q in haystack_tokens:
            continue
        if not _has_close_token(q, haystack_tokens):
            return False
    return True


def _has_close_token(needle: str, haystack: set[str]) -> bool:
    for token in haystack:
        max_dist = _max_distance_for_token(needle, token)
        if max_dist is None:
            continue
        if _edit_distance(needle, token, max_dist) <= max_dist:
            return True
    return False


def _max_distance_for_token(a: str, b: str) -> int | None:
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return None
    length = max(la, lb)
    if length <= 4:
        return 1
    if length <= 8:
        return 2
    if length <= 12:
        return 3
    return 4


def _edit_distance(a: str, b: str, max_dist: int) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_dist:
        return max_dist + 1

    # Ensure a is the shorter string for less work.
    if len(a) > len(b):
        a, b = b, a

    prev = list(range(len(a) + 1))
    for i, ch_b in enumerate(b, start=1):
        curr = [i] + [0] * len(a)
        row_min = curr[0]
        for j, ch_a in enumerate(a, start=1):
            cost = 0 if ch_a == ch_b else 1
            curr[j] = min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost,
            )
            if curr[j] < row_min:
                row_min = curr[j]
        if row_min > max_dist:
            return max_dist + 1
        prev = curr
    return prev[-1]


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
    return _clean_pin_names(*sources)


def _clean_pin_names(*sources: list[str]) -> list[str]:
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
