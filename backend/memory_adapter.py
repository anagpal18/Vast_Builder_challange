"""Pick the memory backend (MASTER 5 API).

MEMORY_BACKEND=auto (default): Kenil's `memory/` package if importable → the VSS/GPU-backed memory when the team
stack is configured (/config/<team>.config) → the ground-truth mock. Force one with `memory`, `vss` or `mock`.
"""
import logging

from backend import config as C

log = logging.getLogger("almost.memory")
FNS = ("verify_event", "store_event", "store_track_summaries", "similar_events", "similar_chunks", "get_event",
       "list_events")


def _real():
    try:
        import memory as m  # Kenil's package at repo root
        for fn in FNS:
            getattr(m, fn)
        return m
    except (ImportError, AttributeError) as e:
        log.info("memory/: unavailable (%s)", e)
        return None


def _choose():
    mode = C.MEMORY_BACKEND
    if mode in ("auto", "memory"):
        m = _real()
        if m:
            return m, "vast"
    if mode == "vss" or (mode == "auto" and (C.GPU_BEARER_TOKEN or C.VSS_URL)):
        from backend import memory_vss
        return memory_vss, "vss"
    from backend import memory_mock
    return memory_mock, "mock"


memory, BACKEND_NAME = _choose()
log.info("memory backend: %s", BACKEND_NAME)
