from __future__ import annotations

from app.agent.board_mapping import canonical_board_kind, fqbn_for_board_kind, is_supported_board_kind
from app.agent.schemas import (
    CompileReadinessValidationResult,
    PinMappingValidationResult,
    ProjectSnapshotV2,
    SnapshotValidationResult,
    ValidationIssue,
)


def validate_snapshot(snapshot: ProjectSnapshotV2) -> SnapshotValidationResult:
    # ProjectSnapshotV2 already enforces structural invariants. This validator
    # adds semantic checks that should not block parsing older drafts.
    issues: list[ValidationIssue] = []
    for board in snapshot.boards:
        if not is_supported_board_kind(board.boardKind):
            issues.append(
                ValidationIssue(
                    code="unsupported_board_kind",
                    message=f"Unsupported board kind: {board.boardKind}",
                    entityId=board.id,
                )
            )
    return SnapshotValidationResult(ok=not issues, issues=issues)


def validate_pin_mapping(snapshot: ProjectSnapshotV2) -> PinMappingValidationResult:
    issues: list[ValidationIssue] = []
    entity_ids = {board.id for board in snapshot.boards} | {comp.id for comp in snapshot.components}
    for wire in snapshot.wires:
        if wire.start.componentId not in entity_ids:
            issues.append(
                ValidationIssue(
                    code="missing_start_entity",
                    message=f"Wire {wire.id} start references missing entity",
                    entityId=wire.id,
                )
            )
        if wire.end.componentId not in entity_ids:
            issues.append(
                ValidationIssue(
                    code="missing_end_entity",
                    message=f"Wire {wire.id} end references missing entity",
                    entityId=wire.id,
                )
            )
        if not wire.start.pinName.strip() or not wire.end.pinName.strip():
            issues.append(
                ValidationIssue(
                    code="missing_pin_name",
                    message=f"Wire {wire.id} has an empty pin name",
                    entityId=wire.id,
                )
            )
    return PinMappingValidationResult(ok=not issues, issues=issues)


def validate_compile_readiness(
    snapshot: ProjectSnapshotV2,
    *,
    board_id: str,
) -> CompileReadinessValidationResult:
    board = next((b for b in snapshot.boards if b.id == board_id), None)
    if board is None:
        return CompileReadinessValidationResult(
            ok=False,
            boardId=board_id,
            issues=[
                ValidationIssue(
                    code="missing_board",
                    message=f"Board not found: {board_id}",
                    entityId=board_id,
                )
            ],
        )
    normalized_kind = canonical_board_kind(board.boardKind)
    try:
        fqbn = fqbn_for_board_kind(normalized_kind)
    except ValueError as exc:
        return CompileReadinessValidationResult(
            ok=False,
            boardId=board_id,
            issues=[
                ValidationIssue(
                    code="unsupported_board_kind",
                    message=str(exc),
                    entityId=board_id,
                )
            ],
        )
    if fqbn is None:
        return CompileReadinessValidationResult(
            ok=False,
            boardId=board_id,
            fqbn=None,
            issues=[
                ValidationIssue(
                    code="not_compilable",
                    message=f"Board {normalized_kind} does not use Arduino compile artifacts",
                    entityId=board_id,
                )
            ],
        )
    files = snapshot.fileGroups.get(board.activeFileGroupId, [])
    if not files:
        return CompileReadinessValidationResult(
            ok=False,
            boardId=board_id,
            fqbn=fqbn,
            issues=[
                ValidationIssue(
                    code="missing_files",
                    message=f"Board {board_id} has no source files",
                    entityId=board_id,
                )
            ],
        )
    return CompileReadinessValidationResult(ok=True, boardId=board_id, fqbn=fqbn)
