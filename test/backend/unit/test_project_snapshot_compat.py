from __future__ import annotations

import json
from datetime import datetime, timezone

from app.agent.schemas import ProjectSnapshotV2, SnapshotBoard, SnapshotFile
from app.agent.snapshot_compat import dump_snapshot_json
from app.api.routes.projects import _snapshot_from_create_body, _to_response
from app.models.project import Project
from app.schemas.project import ProjectCreateRequest, SketchFile


def test_create_body_with_snapshot_derives_legacy_fields():
    snapshot = ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id="esp32",
                boardKind="esp32",
                x=10.0,
                y=20.0,
                activeFileGroupId="group-esp32",
            )
        ],
        activeBoardId="esp32",
        fileGroups={"group-esp32": [SnapshotFile(name="main.cpp", content="esp32 code")]},
        activeGroupId="group-esp32",
    )
    body = ProjectCreateRequest(
        name="ESP Project",
        board_type="arduino-uno",
        files=[SketchFile(name="sketch.ino", content="legacy code")],
        snapshot_json=dump_snapshot_json(snapshot),
    )

    snapshot_json, legacy = _snapshot_from_create_body(body)

    assert json.loads(snapshot_json)["activeBoardId"] == "esp32"
    assert legacy["board_type"] == "esp32"
    assert legacy["files"] == [{"name": "main.cpp", "content": "esp32 code"}]
    assert legacy["code"] == "esp32 code"


def test_project_response_prefers_snapshot_over_stale_legacy_fields():
    snapshot = ProjectSnapshotV2(
        boards=[
            SnapshotBoard(
                id="esp32",
                boardKind="esp32",
                x=10.0,
                y=20.0,
                activeFileGroupId="group-esp32",
            )
        ],
        activeBoardId="esp32",
        fileGroups={"group-esp32": [SnapshotFile(name="main.cpp", content="esp32 code")]},
        activeGroupId="group-esp32",
    )
    now = datetime.now(timezone.utc)
    project = Project(
        id="project-1",
        user_id="user-1",
        name="Project",
        slug="project",
        is_public=True,
        board_type="arduino-uno",
        code="stale code",
        components_json="[]",
        wires_json="[]",
        snapshot_json=dump_snapshot_json(snapshot),
        created_at=now,
        updated_at=now,
        compile_count=0,
        compile_error_count=0,
        run_count=0,
        update_count=0,
    )

    response = _to_response(project, "owner")

    assert response.board_type == "esp32"
    assert response.files == [SketchFile(name="main.cpp", content="esp32 code")]
    assert response.code == "esp32 code"
    assert response.snapshot_json is not None
