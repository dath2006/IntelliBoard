import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.services.arduino_cli import ArduinoCLIService
from app.services.metrics import record_compile
from app.services.espidf_compiler import espidf_compiler

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()


class SketchFile(BaseModel):
    name: str
    content: str


class CompileRequest(BaseModel):
    # New multi-file API
    files: list[SketchFile] | None = None
    # Legacy single-file API (kept for backward compat)
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"
    # Optional: associate this compile with a project for analytics
    project_id: str | None = None


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    has_wifi: bool = False             # True when sketch uses WiFi (ESP32 only)
    stdout: str
    stderr: str
    error: str | None = None
    core_install_log: str | None = None


def _classify_compile_error(stderr: str, error: str | None) -> str:
    """Map raw compiler output to a stable error_kind for analytics."""
    haystack = f"{error or ''}\n{stderr or ''}".lower()
    if "no such file or directory" in haystack or "fatal error:" in haystack:
        return "missing_library"
    if "core install" in haystack or "failed to install" in haystack:
        return "core_install_failed"
    if "undefined reference" in haystack:
        return "linker_error"
    if "expected" in haystack and "before" in haystack:
        return "syntax_error"
    if "error:" in haystack:
        return "compile_error"
    return "unknown"


@router.post("/", response_model=CompileResponse)
async def compile_sketch(
    request: CompileRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    """
    Compile Arduino sketch and return hex/binary.
    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    # Resolve files list
    if request.files:
        files = [{"name": f.name, "content": f.content} for f in request.files]
    elif request.code is not None:
        files = [{"name": "sketch.ino", "content": request.code}]
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide either 'files' or 'code' in the request body.",
        )

    started = time.monotonic()
    response: CompileResponse
    try:
        # ESP32 targets: use ESP-IDF compiler for QEMU-compatible output
        if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
            logger.info(f"[compile] Using ESP-IDF for {request.board_fqbn}")
            result = await espidf_compiler.compile(files, request.board_fqbn)
            response = CompileResponse(
                success=result["success"],
                hex_content=result.get("hex_content"),
                binary_content=result.get("binary_content"),
                binary_type=result.get("binary_type"),
                has_wifi=result.get("has_wifi", False),
                stdout=result.get("stdout", ""),
                stderr=result.get("stderr", ""),
                error=result.get("error"),
            )
        else:
            # AVR, RP2040, and ESP32 fallback: use arduino-cli
            core_status = await arduino_cli.ensure_core_for_board(request.board_fqbn)
            core_log = core_status.get("log", "")

            if core_status.get("needed") and not core_status.get("installed"):
                response = CompileResponse(
                    success=False,
                    stdout="",
                    stderr=core_log,
                    error=f"Failed to install required core: {core_status.get('core_id')}",
                )
            else:
                result = await arduino_cli.compile(files, request.board_fqbn)
                response = CompileResponse(
                    success=result["success"],
                    hex_content=result.get("hex_content"),
                    binary_content=result.get("binary_content"),
                    binary_type=result.get("binary_type"),
                    stdout=result.get("stdout", ""),
                    stderr=result.get("stderr", ""),
                    error=result.get("error"),
                    core_install_log=core_log if core_log else None,
                )
    except Exception as e:
        # Even on hard failure we want the metric.
        await record_compile(
            db,
            user=current_user,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind="exception",
            extra={"file_count": len(files), "exception": str(e)[:200]},
            request=http_request,
        )
        raise HTTPException(status_code=500, detail=str(e))

    # Best-effort metrics — never blocks the response.
    duration_ms = int((time.monotonic() - started) * 1000)
    await record_compile(
        db,
        user=current_user,
        project_id=request.project_id,
        board_fqbn=request.board_fqbn,
        success=response.success,
        duration_ms=duration_ms,
        error_kind=None if response.success else _classify_compile_error(response.stderr, response.error),
        extra={"file_count": len(files), "has_wifi": response.has_wifi},
        request=http_request,
    )
    return response


@router.get("/setup-status")
async def setup_status():
    return await arduino_cli.get_setup_status()


@router.post("/ensure-core")
async def ensure_core(request: CompileRequest):
    fqbn = request.board_fqbn
    result = await arduino_cli.ensure_core_for_board(fqbn)
    return result


@router.get("/boards")
async def list_boards():
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
