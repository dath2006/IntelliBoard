from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings
from app.database.session import Base, async_engine
from app.models.agent_session import AgentSession
from app.models.agent_session_event import AgentSessionEvent


async def refresh_agent_tables() -> None:
    async with async_engine.begin() as conn:
        # Drop dependent tables first to avoid FK issues.
        await conn.exec_driver_sql("DROP TABLE IF EXISTS agent_session_events")
        await conn.exec_driver_sql("DROP TABLE IF EXISTS agent_sessions")
        # Recreate just the agent tables.
        await conn.run_sync(
            lambda sync_conn: Base.metadata.create_all(
                sync_conn,
                tables=[AgentSession.__table__, AgentSessionEvent.__table__],
            )
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Drop and recreate agent session tables (data loss)."
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm the destructive schema refresh.",
    )
    args = parser.parse_args()

    if not args.yes:
        print("Refusing to run without --yes (this deletes agent session data).")
        return 2

    print(f"Refreshing agent tables in {settings.DATABASE_URL} ...")
    asyncio.run(refresh_agent_tables())
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
