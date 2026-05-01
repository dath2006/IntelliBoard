from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable

from pathlib import Path

import httpx

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.agent.snapshot_compat import load_snapshot_json, snapshot_v2_to_legacy
from app.database.session import AsyncSessionLocal
from app.models.agent_session import AgentSession
from app.models.agent_session_event import AgentSessionEvent  # noqa: F401


@dataclass
class EvalResult:
    session_id: str
    project_id: str
    status: str
    output: str | None
    error: str | None
    event_counts: dict[str, int]
    tool_calls: int
    snapshot_updates: int
    first_event_ms: float | None
    first_delta_ms: float | None
    total_ms: float | None
    missing_seq: list[int]


async def _load_session_snapshot(session_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    async with AsyncSessionLocal() as session:
        agent_session = await session.get(AgentSession, session_id)
        if agent_session is None:
            raise RuntimeError("Agent session not found in database.")
        snapshot = load_snapshot_json(agent_session.draft_snapshot_json)
        legacy = snapshot_v2_to_legacy(snapshot)
        return snapshot.model_dump(mode="json"), legacy


def _sse_events(lines: Iterable[str]) -> Iterable[dict[str, Any]]:
    event_id: str | None = None
    event_type: str | None = None
    data_lines: list[str] = []

    for raw in lines:
        line = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
        if line == "":
            if event_type is None and not data_lines and event_id is None:
                continue
            payload: Any | None = None
            if data_lines:
                data = "\n".join(data_lines)
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    payload = data
            yield {"id": event_id, "event": event_type or "message", "data": payload}
            event_id = None
            event_type = None
            data_lines = []
            continue

        if line.startswith(":"):
            continue
        if line.startswith("id:"):
            event_id = line.split(":", 1)[1].strip()
        elif line.startswith("event:"):
            event_type = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].lstrip())


def _create_identity(prefix: str = "agenttest") -> tuple[str, str, str]:
    suffix = uuid.uuid4().hex[:8]
    username = f"{prefix}-{suffix}"
    email = f"{username}@example.com"
    password = "TestPass123!"
    return username, email, password


def _ensure_auth(client: httpx.Client, base_url: str) -> None:
    username, email, password = _create_identity()
    res = client.post(f"{base_url}/api/auth/register", json={
        "username": username,
        "email": email,
        "password": password,
    })
    if res.status_code == 201:
        return
    if res.status_code == 400:
        login = client.post(f"{base_url}/api/auth/login", json={
            "email": email,
            "password": password,
        })
        login.raise_for_status()
        return
    res.raise_for_status()


def _create_project(client: httpx.Client, base_url: str) -> str:
    body = {
        "name": f"Agent SSE Eval {datetime.utcnow().isoformat(timespec='seconds')}",
        "board_type": "arduino-uno",
        "files": [
            {
                "name": "sketch.ino",
                "content": "void setup() {}\n\nvoid loop() {}\n",
            }
        ],
        "components_json": "[]",
        "wires_json": "[]",
        "is_public": False,
    }
    res = client.post(f"{base_url}/api/projects/", json=body)
    res.raise_for_status()
    return res.json()["id"]


def _create_session(client: httpx.Client, base_url: str, project_id: str, model: str | None) -> str:
    payload = {"projectId": project_id}
    if model:
        payload["modelName"] = model
    res = client.post(f"{base_url}/api/agent/sessions", json=payload)
    res.raise_for_status()
    return res.json()["id"]


def _post_message(client: httpx.Client, base_url: str, session_id: str, message: str) -> None:
    res = client.post(
        f"{base_url}/api/agent/sessions/{session_id}/messages",
        json={"message": message},
    )
    res.raise_for_status()


def _stream_events(
    client: httpx.Client,
    base_url: str,
    session_id: str,
    timeout_s: float,
    t0: float,
) -> EvalResult:
    event_counts: Counter[str] = Counter()
    tool_calls = 0
    snapshot_updates = 0
    output: str | None = None
    error: str | None = None
    first_event_ms: float | None = None
    first_delta_ms: float | None = None
    total_ms: float | None = None
    missing_seq: list[int] = []
    last_seq: int | None = None

    with client.stream(
        "GET",
        f"{base_url}/api/agent/sessions/{session_id}/events",
        params={"stream": "true", "after": "0"},
        timeout=timeout_s,
    ) as response:
        response.raise_for_status()
        for event in _sse_events(response.iter_lines()):
            now = time.monotonic()
            if first_event_ms is None:
                first_event_ms = (now - t0) * 1000.0

            event_type = event.get("event") or "message"
            event_counts[event_type] += 1

            if event_type == "tool.call.started":
                tool_calls += 1
            elif event_type == "snapshot.updated":
                snapshot_updates += 1
            elif event_type == "run.failed":
                error = (event.get("data") or {}).get("payload", {}).get("error")
            elif event_type == "run.completed":
                output = (event.get("data") or {}).get("payload", {}).get("output")

            if event_type == "model.output.delta" and first_delta_ms is None:
                first_delta_ms = (now - t0) * 1000.0

            if event.get("id") is not None:
                try:
                    seq = int(str(event["id"]))
                except ValueError:
                    seq = None
                if seq is not None:
                    if last_seq is not None and seq > last_seq + 1:
                        missing_seq.extend(range(last_seq + 1, seq))
                    last_seq = seq

            if event_type in {"run.completed", "run.failed", "run.cancelled"}:
                total_ms = (now - t0) * 1000.0
                break

    status = "completed" if output is not None else "failed"
    if error:
        status = "failed"

    return EvalResult(
        session_id=session_id,
        project_id="",
        status=status,
        output=output,
        error=error,
        event_counts=dict(event_counts),
        tool_calls=tool_calls,
        snapshot_updates=snapshot_updates,
        first_event_ms=first_event_ms,
        first_delta_ms=first_delta_ms,
        total_ms=total_ms,
        missing_seq=missing_seq,
    )


def _print_summary(result: EvalResult) -> None:
    print("\nAgent SSE Eval Summary")
    print("-" * 28)
    print(f"status: {result.status}")
    if result.error:
        print(f"error: {result.error}")
    if result.output:
        print(f"output: {result.output}")
    print(f"tool_calls: {result.tool_calls}")
    print(f"snapshot_updates: {result.snapshot_updates}")
    if result.first_event_ms is not None:
        print(f"first_event_ms: {result.first_event_ms:.1f}")
    if result.first_delta_ms is not None:
        print(f"first_delta_ms: {result.first_delta_ms:.1f}")
    if result.total_ms is not None:
        print(f"total_ms: {result.total_ms:.1f}")
    if result.missing_seq:
        print(f"missing_seq: {result.missing_seq}")
    print("event_counts:")
    for event, count in sorted(result.event_counts.items()):
        print(f"  {event}: {count}")


def _print_snapshot(snapshot: dict[str, Any], legacy: dict[str, Any]) -> None:
    print("\nCircuit JSON (components_json)")
    print("-" * 28)
    print(legacy.get("components_json", "[]"))

    print("\nCircuit JSON (wires_json)")
    print("-" * 24)
    print(legacy.get("wires_json", "[]"))

    active_group_id = snapshot.get("activeGroupId")
    file_groups = snapshot.get("fileGroups", {})
    files = file_groups.get(active_group_id, []) if active_group_id else []

    if files:
        print("\nEdited Files")
        print("-" * 12)
        for file in files:
            name = file.get("name", "")
            content = file.get("content", "")
            print(f"\n--- {name} ---")
            print(content)
    else:
        print("\nEdited Code")
        print("-" * 11)
        print(legacy.get("code", ""))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run live SSE agent evaluation.")
    parser.add_argument("--base-url", default="http://localhost:8001")
    parser.add_argument("--model", default=None)
    parser.add_argument(
        "--message",
        default=(
            "Add an LED component wired to Arduino pin 13 and update the sketch to blink it. "
            "Do not compile."
        ),
    )
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--out", default=None, help="Optional path to write the raw summary JSON")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")

    timeout = httpx.Timeout(connect=10.0, read=args.timeout_seconds, write=10.0, pool=10.0)
    with httpx.Client(timeout=timeout) as client:
        _ensure_auth(client, base_url)
        project_id = _create_project(client, base_url)
        session_id = _create_session(client, base_url, project_id, args.model)
        t0 = time.monotonic()
        _post_message(client, base_url, session_id, args.message)
        try:
            result = _stream_events(client, base_url, session_id, args.timeout_seconds, t0)
        except httpx.TimeoutException:
            print("\nTimed out while waiting for SSE events. Check AGENT_ENABLED and OPENAI_API_KEY.")
            return 2
        result.project_id = project_id

    _print_summary(result)

    try:
        snapshot, legacy = asyncio.run(_load_session_snapshot(session_id))
    except Exception as exc:
        print(f"\nFailed to load snapshot from DB: {exc}")
        snapshot = None
        legacy = None

    if snapshot is not None and legacy is not None:
        _print_snapshot(snapshot, legacy)

    if args.out:
        payload: dict[str, Any] = {**result.__dict__}
        if snapshot is not None and legacy is not None:
            payload["snapshot"] = snapshot
            payload["legacy"] = legacy
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"\nWrote summary to {args.out}")

    if result.status != "completed":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
