"""Use Kenil's `memory/` package when it is importable, else the mock. MEMORY_BACKEND=mock forces the mock."""
import logging

from backend.config import MEMORY_BACKEND

log = logging.getLogger("almost.memory")

memory = None
if MEMORY_BACKEND != "mock":
    try:
        import memory as _real  # noqa: F401  (Kenil's package at repo root)
        for fn in ("verify_event", "store_event", "store_track_summaries", "similar_events",
                   "similar_chunks", "get_event", "list_events"):
            getattr(_real, fn)
        memory = _real
        log.info("memory: using real memory/ package")
    except (ImportError, AttributeError) as e:
        log.info("memory: real package unavailable (%s), using mock", e)
if memory is None:
    from backend import memory_mock as memory  # noqa: F811

BACKEND_NAME = "mock" if memory.__name__.endswith("memory_mock") else "vast"
