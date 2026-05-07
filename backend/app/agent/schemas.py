from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SnapshotFile(StrictModel):
    name: str = Field(min_length=1, max_length=255)
    content: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        if normalized.startswith("/") or ".." in normalized.split("/"):
            raise ValueError("file name must be relative and cannot contain traversal segments")
        return value


class SnapshotBoard(StrictModel):
    id: str = Field(min_length=1)
    boardKind: str = Field(min_length=1)
    x: float
    y: float
    languageMode: Literal["arduino", "micropython"] = "arduino"
    activeFileGroupId: str = Field(min_length=1)


class SnapshotComponent(StrictModel):
    id: str = Field(min_length=1)
    metadataId: str = Field(min_length=1)
    x: float
    y: float
    properties: dict[str, Any] = Field(default_factory=dict)


class WireEndpoint(StrictModel):
    componentId: str = Field(min_length=1)
    pinName: str = Field(min_length=1)
    x: float = 0
    y: float = 0


class WireWaypoint(StrictModel):
    x: float
    y: float


class SnapshotWire(StrictModel):
    id: str = Field(min_length=1)
    start: WireEndpoint
    end: WireEndpoint
    waypoints: list[WireWaypoint] = Field(default_factory=list)
    color: str = "#22c55e"
    signalType: str | None = None


class BoardCompileState(StrictModel):
    stale: bool = True
    reason: str = "not_compiled"
    updatedAt: datetime | None = None


class ProjectSnapshotV2(StrictModel):
    version: Literal[2] = 2
    boards: list[SnapshotBoard] = Field(default_factory=list)
    activeBoardId: str | None = None
    components: list[SnapshotComponent] = Field(default_factory=list)
    wires: list[SnapshotWire] = Field(default_factory=list)
    fileGroups: dict[str, list[SnapshotFile]] = Field(default_factory=dict)
    activeGroupId: str | None = None
    compileState: dict[str, BoardCompileState] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_snapshot_invariants(self) -> "ProjectSnapshotV2":
        board_ids = [b.id for b in self.boards]
        component_ids = [c.id for c in self.components]
        wire_ids = [w.id for w in self.wires]

        _ensure_unique("board id", board_ids)
        _ensure_unique("component id", component_ids)
        _ensure_unique("wire id", wire_ids)

        entity_ids = set(board_ids) | set(component_ids)
        overlap = set(board_ids) & set(component_ids)
        if overlap:
            raise ValueError(f"board/component ids must be unique: {sorted(overlap)}")

        if self.activeBoardId is not None and self.activeBoardId not in board_ids:
            raise ValueError("activeBoardId must reference an existing board")

        if self.activeGroupId is not None and self.activeGroupId not in self.fileGroups:
            raise ValueError("activeGroupId must reference an existing file group")

        for board in self.boards:
            if board.activeFileGroupId not in self.fileGroups:
                raise ValueError(f"board {board.id} references missing file group")

        for wire in self.wires:
            if wire.start.componentId not in entity_ids:
                raise ValueError(f"wire {wire.id} start references missing component or board")
            if wire.end.componentId not in entity_ids:
                raise ValueError(f"wire {wire.id} end references missing component or board")

        return self


class AgentUiState(BaseModel):
    model_config = ConfigDict(extra="allow")
    projectId: str | None = None
    sessionId: str | None = None
    activeBoardId: str | None = None
    activeGroupId: str | None = None
    activeFileId: str | None = None
    activeFileName: str | None = None
    selectedWireId: str | None = None


def _ensure_unique(label: str, values: list[str]) -> None:
    seen: set[str] = set()
    duplicates = sorted({value for value in values if value in seen or seen.add(value)})
    if duplicates:
        raise ValueError(f"duplicate {label}: {duplicates}")


class AddBoardInput(StrictModel):
    boardKind: str = Field(min_length=1)
    id: str | None = None
    x: float = 50
    y: float = 50
    languageMode: Literal["arduino", "micropython"] = "arduino"


class ChangeBoardKindInput(StrictModel):
    boardId: str = Field(min_length=1)
    boardKind: str = Field(min_length=1)


class ConnectPinsInput(StrictModel):
    wireId: str | None = None
    start: WireEndpoint
    end: WireEndpoint
    color: str = "#22c55e"
    signalType: str | None = None


class ReplaceFileRangeInput(StrictModel):
    groupId: str = Field(min_length=1)
    fileName: str = Field(min_length=1)
    startLine: int = Field(ge=1)
    endLine: int = Field(ge=1)
    replacement: str

    @model_validator(mode="after")
    def validate_range(self) -> "ReplaceFileRangeInput":
        if self.endLine < self.startLine:
            raise ValueError("endLine must be greater than or equal to startLine")
        return self


class ToolResult(StrictModel):
    ok: bool
    message: str = ""
    changedBoardIds: list[str] = Field(default_factory=list)
    changedComponentIds: list[str] = Field(default_factory=list)
    changedWireIds: list[str] = Field(default_factory=list)
    changedFileGroups: list[str] = Field(default_factory=list)
    invalidatedBoardIds: list[str] = Field(default_factory=list)


class ValidationIssue(StrictModel):
    code: str
    message: str
    entityId: str | None = None


class SnapshotValidationResult(StrictModel):
    ok: bool
    issues: list[ValidationIssue] = Field(default_factory=list)


class PinMappingValidationResult(StrictModel):
    ok: bool
    issues: list[ValidationIssue] = Field(default_factory=list)


class CompileReadinessValidationResult(StrictModel):
    ok: bool
    boardId: str
    fqbn: str | None = None
    issues: list[ValidationIssue] = Field(default_factory=list)


RunState = Literal["queued", "running", "waiting_approval", "stopped", "completed", "failed"]


class AgentEvent(StrictModel):
    seq: int = Field(ge=1)
    sessionId: str
    eventType: str = Field(min_length=1)
    runState: RunState | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    createdAt: datetime = Field(default_factory=datetime.utcnow)


class AgentSessionCreateRequest(StrictModel):
    projectId: str | None = None
    snapshotJson: str | None = None
    modelName: str | None = None


class AgentSessionMessageRequest(StrictModel):
    message: str = Field(min_length=1)


class FrontendActionRequest(StrictModel):
    actionId: str = Field(min_length=1)
    action: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    timeoutMs: int | None = Field(default=None, ge=1000, le=120000)


class FrontendActionResultRequest(StrictModel):
    ok: bool
    payload: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    action: str | None = None


class PinCatalogObservationRequest(StrictModel):
    metadataId: str = Field(min_length=1)
    tagName: str | None = None
    pinNames: list[str] = Field(default_factory=list)
    propertySignature: str | None = None


class AgentSessionResponse(StrictModel):
    id: str
    projectId: str | None = None
    status: str
    modelName: str
    createdAt: datetime
    updatedAt: datetime


class AgentSessionEventResponse(StrictModel):
    id: str
    sessionId: str
    seq: int
    eventType: str
    payload: dict[str, Any]
    createdAt: datetime
