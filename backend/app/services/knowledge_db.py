"""Knowledge DB service for component recommendations and error pattern retrieval."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

try:
    import chromadb
except Exception:  # pragma: no cover - optional dependency runtime guard
    chromadb = None

try:
    from sentence_transformers import SentenceTransformer
except Exception:  # pragma: no cover - optional dependency runtime guard
    SentenceTransformer = None


class KnowledgeDBService:
    """Provides retrieval over component metadata with vector and keyword fallback."""

    def __init__(
        self,
        metadata_path: str | Path | None = None,
        chroma_persist_dir: str | Path | None = None,
        model_name: str = "all-MiniLM-L6-v2",
    ) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        self._repo_root = repo_root
        self._metadata_path = self._resolve_metadata_path(metadata_path)
        self._chroma_persist_dir = Path(chroma_persist_dir or settings.CHROMA_PERSISTENCE_DIR)
        self._model_name = model_name

        self._initialized = False
        self._index_backend = "keyword"

        self._components: list[dict[str, Any]] = []
        self._component_map: dict[str, dict[str, Any]] = {}
        self._example_circuits: dict[str, dict[str, Any]] = self._default_example_circuits()
        self._error_patterns: list[dict[str, str]] = []

        self._model: Any = None
        self._chroma_client: Any = None
        self._collection: Any = None

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def index_backend(self) -> str:
        return self._index_backend

    def _resolve_metadata_path(self, metadata_path: str | Path | None) -> Path:
        if metadata_path:
            candidate = Path(metadata_path)
            if candidate.exists():
                return candidate

        configured = Path(settings.KNOWLEDGE_DB_PATH)
        candidates = [
            self._repo_root / "frontend" / "public" / "components-metadata.json",
            configured / "components-metadata.json",
            configured,
        ]

        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return candidate

        return candidates[0]

    async def initialize(self) -> None:
        """Initialize in-memory index and optional vector index."""
        if self._initialized:
            return

        await self.index_components()
        await self.index_error_patterns()
        self._initialized = True

    async def index_components(self) -> int:
        """Load component metadata and build searchable indexes."""
        if not self._metadata_path.exists():
            logger.warning("Knowledge DB metadata not found at %s", self._metadata_path)
            self._components = []
            self._component_map = {}
            self._index_backend = "keyword"
            return 0

        try:
            data = json.loads(self._metadata_path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Unable to parse component metadata at %s", self._metadata_path, exc_info=True)
            self._components = []
            self._component_map = {}
            self._index_backend = "keyword"
            return 0

        raw_components = data.get("components", [])
        indexed_components: list[dict[str, Any]] = []

        for component in raw_components:
            component_type = str(component.get("tagName") or component.get("id") or "").strip()
            part_name = str(component.get("name") or component.get("id") or component_type)
            category = str(component.get("category") or "misc")
            tags = [str(tag) for tag in component.get("tags", []) if str(tag).strip()]
            properties = component.get("properties", [])
            property_names = [
                str(item.get("name"))
                for item in properties
                if isinstance(item, dict) and item.get("name")
            ]
            pin_count = int(component.get("pinCount") or 0)
            pins_data = component.get("pins", [])

            search_chunks = [
                component_type,
                part_name,
                category,
                " ".join(tags),
                " ".join(property_names),
            ]
            search_text = " ".join(chunk for chunk in search_chunks if chunk).lower()

            pin_names = []
            if pins_data and isinstance(pins_data, list):
                pin_names = [str(p.get("name")) for p in pins_data if p.get("name")]
                if pin_names:
                    pinout_info = f"Pins ({len(pin_names)}): " + ", ".join(pin_names)
                else:
                    pinout_info = f"Approx. {pin_count} exposed pins"
            elif pin_count > 0:
                pinout_info = f"Approx. {pin_count} exposed pins"
            else:
                pinout_info = "Pin details vary by board/component documentation"

            normalized = {
                "component_type": component_type,
                "part_name": part_name,
                "category": category,
                "tags": tags,
                "pin_count": pin_count,
                "pins": pin_names,
                "properties": property_names,
                "search_text": search_text,
                "why_good": f"Useful {category} component available in the Velxio Wokwi library",
                "pinout_info": pinout_info,
            }
            indexed_components.append(normalized)

        self._components = indexed_components
        self._component_map = {item["component_type"]: item for item in indexed_components}

        await self._initialize_vector_index()
        return len(self._components)

    async def _initialize_vector_index(self) -> None:
        """Attempt vector indexing; gracefully fallback to keyword search on failure."""
        if not self._components:
            self._index_backend = "keyword"
            return

        if chromadb is None or SentenceTransformer is None:
            self._index_backend = "keyword"
            logger.info("Knowledge DB running in keyword mode (optional deps unavailable)")
            return

        try:
            if self._model is None:
                self._model = SentenceTransformer(self._model_name)

            if self._chroma_client is None:
                self._chroma_persist_dir.mkdir(parents=True, exist_ok=True)
                self._chroma_client = chromadb.PersistentClient(path=str(self._chroma_persist_dir))

            if self._collection is None:
                self._collection = self._chroma_client.get_or_create_collection(
                    name="velxio_components",
                    metadata={"hnsw:space": "cosine"},
                )

            component_ids = [item["component_type"] or item["part_name"] for item in self._components]
            documents = [item["search_text"] for item in self._components]
            metadatas = [
                {
                    "component_type": item["component_type"],
                    "part_name": item["part_name"],
                    "category": item["category"],
                    "why_good": item["why_good"],
                    "pinout_info": item["pinout_info"],
                    "pins": json.dumps(item.get("pins", [])),
                    "tags": " ".join(item["tags"]),
                }
                for item in self._components
            ]

            embeddings = await asyncio.to_thread(
                self._model.encode,
                documents,
                normalize_embeddings=True,
            )
            if hasattr(embeddings, "tolist"):
                embeddings = embeddings.tolist()

            self._collection.upsert(
                ids=component_ids,
                documents=documents,
                metadatas=metadatas,
                embeddings=embeddings,
            )
            self._index_backend = "vector"
            logger.info("Knowledge DB indexed %s components using vector backend", len(self._components))
        except Exception:
            self._index_backend = "keyword"
            logger.warning("Knowledge DB vector indexing failed; falling back to keyword mode", exc_info=True)

    async def search_components(
        self,
        query_text: str,
        limit: int = 5,
        constraints: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Search components by natural language query and optional constraints."""
        if not self._initialized:
            await self.initialize()

        safe_limit = max(1, min(limit, 20))
        query = query_text.strip()
        if not query:
            return []

        normalized_constraints = constraints or {}

        if self._index_backend == "vector" and self._collection is not None and self._model is not None:
            try:
                query_embedding = await asyncio.to_thread(
                    self._model.encode,
                    [query],
                    normalize_embeddings=True,
                )
                if hasattr(query_embedding, "tolist"):
                    query_embedding = query_embedding.tolist()

                results = self._collection.query(
                    query_embeddings=query_embedding,
                    n_results=min(safe_limit * 3, 30),
                    include=["metadatas", "distances"],
                )

                vector_ranked = self._format_vector_results(results)
                filtered_vector = [
                    item for item in vector_ranked if self._matches_constraints(item, normalized_constraints)
                ]
                if filtered_vector:
                    return filtered_vector[:safe_limit]
            except Exception:
                logger.warning("Vector query failed; using keyword fallback", exc_info=True)

        return self._keyword_search(query, safe_limit, normalized_constraints)

    def _format_vector_results(self, results: dict[str, Any]) -> list[dict[str, Any]]:
        ranked: list[dict[str, Any]] = []
        metadatas = results.get("metadatas", [[]])
        distances = results.get("distances", [[]])

        metadata_rows = metadatas[0] if metadatas else []
        distance_rows = distances[0] if distances else []

        for index, metadata in enumerate(metadata_rows):
            if not isinstance(metadata, dict):
                continue

            distance = 0.0
            if index < len(distance_rows) and distance_rows[index] is not None:
                distance = float(distance_rows[index])

            relevance = max(0.0, min(1.0, 1.0 - distance))
            
            pins_val = metadata.get("pins", "[]")
            try:
                pins = json.loads(pins_val) if isinstance(pins_val, str) else pins_val
            except Exception:
                pins = []

            ranked.append(
                {
                    "component_type": metadata.get("component_type", ""),
                    "part_name": metadata.get("part_name", "Unknown component"),
                    "relevance_score": round(relevance, 4),
                    "why_good": metadata.get("why_good", "Matches the requested features"),
                    "pinout_info": metadata.get(
                        "pinout_info",
                        "Review component documentation for full pinout",
                    ),
                    "pins": pins,
                    "category": metadata.get("category", "misc"),
                    "tags": metadata.get("tags", "").split(),
                }
            )

        return ranked

    def _keyword_search(
        self,
        query: str,
        limit: int,
        constraints: dict[str, Any],
    ) -> list[dict[str, Any]]:
        tokens = [token for token in re.findall(r"[a-z0-9]+", query.lower()) if len(token) > 1]
        scored: list[dict[str, Any]] = []

        for component in self._components:
            if not self._matches_constraints(component, constraints):
                continue

            search_text = component.get("search_text", "")
            score = 0.0

            if query.lower() in search_text:
                score += 0.45

            for token in tokens:
                if token in search_text:
                    score += 0.12

            if component.get("category", "") in query.lower():
                score += 0.1

            if score <= 0:
                continue

            scored.append(
                {
                    "component_type": component.get("component_type", ""),
                    "part_name": component.get("part_name", "Unknown component"),
                    "relevance_score": round(min(1.0, score), 4),
                    "why_good": component.get("why_good", "Suitable match for your requirements"),
                    "pinout_info": component.get(
                        "pinout_info",
                        "Review component documentation for full pinout",
                    ),
                    "pins": component.get("pins", []),
                    "category": component.get("category", "misc"),
                    "tags": component.get("tags", []),
                }
            )

        scored.sort(key=lambda item: item["relevance_score"], reverse=True)
        return scored[:limit]

    def _matches_constraints(
        self,
        component: dict[str, Any],
        constraints: dict[str, Any],
    ) -> bool:
        if not constraints:
            return True

        tags = component.get("tags") or []
        if isinstance(tags, str):
            tags = tags.split()

        text_parts = [
            str(component.get("search_text") or ""),
            str(component.get("part_name") or ""),
            str(component.get("component_type") or ""),
            str(component.get("category") or ""),
            " ".join(str(tag) for tag in tags),
        ]
        search_text = " ".join(text_parts).lower()
        category = str(component.get("category") or "").lower()

        interface = str(constraints.get("interface") or "").strip().lower()
        if interface and interface not in search_text:
            return False

        category_filter = str(constraints.get("category") or "").strip().lower()
        if category_filter and category_filter != category:
            return False

        component_name = str(component.get("part_name") or "").lower()
        name_filter = str(constraints.get("name_contains") or "").strip().lower()
        if name_filter and name_filter not in component_name:
            return False

        return True

    async def get_component_details(self, component_type: str) -> dict[str, Any] | None:
        """Return full metadata for one component tag/type."""
        if not self._initialized:
            await self.initialize()

        return self._component_map.get(component_type)

    async def retrieve_example_circuit(self, pattern_name: str) -> dict[str, Any] | None:
        """Return a curated example circuit payload by pattern name."""
        if not self._initialized:
            await self.initialize()

        key = pattern_name.strip().lower()
        return self._example_circuits.get(key)

    async def index_error_patterns(self) -> int:
        """Index a small curated set of compiler/runtime error patterns."""
        self._error_patterns = [
            {
                "pattern": "was not declared in this scope",
                "fix": "Declare the variable before use or correct the variable name typo.",
            },
            {
                "pattern": "no such file or directory",
                "fix": "Install the missing library and add the correct #include line.",
            },
            {
                "pattern": "expected ';'",
                "fix": "Add a missing semicolon at the end of the reported statement.",
            },
            {
                "pattern": "nan",
                "fix": "Check sensor wiring, startup delays, and serial formatting.",
            },
        ]
        return len(self._error_patterns)

    async def search_error_patterns(self, query_text: str, limit: int = 3) -> list[dict[str, str]]:
        """Lookup likely fixes for common compile/runtime errors."""
        if not self._initialized:
            await self.initialize()

        query = query_text.strip().lower()
        if not query:
            return []

        ranked: list[dict[str, Any]] = []
        for item in self._error_patterns:
            pattern = item["pattern"]
            score = 1.0 if pattern in query else 0.0
            if score > 0:
                ranked.append({"score": score, **item})

        ranked.sort(key=lambda row: row["score"], reverse=True)
        return [
            {"pattern": row["pattern"], "fix": row["fix"]}
            for row in ranked[: max(1, min(limit, 10))]
        ]

    def _default_example_circuits(self) -> dict[str, dict[str, Any]]:
        """Minimal curated examples for retrieval fallback."""
        return {
            "blink": {
                "board_fqbn": "arduino:avr:uno",
                "components": [{"id": "led1", "type": "wokwi-led", "left": 160, "top": 70, "attrs": {}}],
                "connections": [],
            },
            "servo control": {
                "board_fqbn": "arduino:avr:uno",
                "components": [{"id": "servo1", "type": "wokwi-servo", "left": 210, "top": 120, "attrs": {}}],
                "connections": [],
            },
            "i2c communication": {
                "board_fqbn": "arduino:avr:uno",
                "components": [
                    {"id": "lcd1", "type": "wokwi-lcd1602", "left": 220, "top": 70, "attrs": {}},
                    {"id": "sensor1", "type": "wokwi-bmp280", "left": 220, "top": 150, "attrs": {}},
                ],
                "connections": [],
            },
        }


_knowledge_db: KnowledgeDBService | None = None
_knowledge_db_lock: asyncio.Lock | None = None


async def get_knowledge_db() -> KnowledgeDBService:
    """Return a lazily initialized singleton knowledge DB service."""
    global _knowledge_db, _knowledge_db_lock

    if _knowledge_db is not None and _knowledge_db.initialized:
        return _knowledge_db

    if _knowledge_db_lock is None:
        _knowledge_db_lock = asyncio.Lock()

    async with _knowledge_db_lock:
        if _knowledge_db is None:
            _knowledge_db = KnowledgeDBService()
        if not _knowledge_db.initialized:
            await _knowledge_db.initialize()

    return _knowledge_db


async def initialize_knowledge_db() -> KnowledgeDBService:
    """Initialize the singleton service and return it."""
    service = await get_knowledge_db()
    logger.info("Knowledge DB initialized with %s backend", service.index_backend)
    return service
