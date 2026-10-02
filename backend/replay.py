"""Record / replay for every external call (Cosmos3-Reason, Embed1, W&B Inference, VSS search).

Every successful live call is stored under data/cache/replay/<service>/<key>.json with its latency. When a
service fails (tunnel drop, Wi-Fi, GPU host down) the same request is answered from the recording, after
sleeping the recorded latency capped at REPLAY_MAX_S (5 s), so a demo behaves like the live one. A failed service
is marked down for DOWN_FOR_S so later calls go straight to the recording instead of waiting on timeouts.

REPLAY_MODE: auto (live first, fall back; default) · offline (recording first, live only on a miss) · live (never).
"""
import hashlib
import json
import logging
import os
import threading
import time

from backend.config import CACHE_DIR

log = logging.getLogger("almost.replay")
DIR = CACHE_DIR / "replay"
MODE = os.environ.get("REPLAY_MODE", "auto")
REPLAY_MAX_S = float(os.environ.get("REPLAY_MAX_S", "5"))
DOWN_FOR_S = 60.0
_down: dict = {}
_lock = threading.Lock()
STATS = {"live": 0, "replayed": 0, "recorded": 0}


def _key(parts):
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:24]


def _is_down(service):
    return _down.get(service, 0) > time.time()


def mark_down(service):
    with _lock:
        _down[service] = time.time() + DOWN_FOR_S


def status():
    now = time.time()
    return {"mode": MODE, "down": {k: round(v - now) for k, v in _down.items() if v > now}, **STATS,
            "recordings": sum(1 for _ in DIR.rglob("*.json")) if DIR.exists() else 0}


def _replay(service, rec):
    time.sleep(min(float(rec.get("elapsed_s", 0.0)), REPLAY_MAX_S))
    STATS["replayed"] += 1
    log.info("%s: replayed recording (%.1fs)", service, rec.get("elapsed_s", 0.0))
    return rec["result"]


def call(service, key_parts, fn):
    """Run fn() live and record it, or replay the recording for the same key when the service is unavailable."""
    if MODE == "live":
        return fn()
    path = DIR / service / f"{_key(key_parts)}.json"
    rec = None
    if path.exists():
        try:
            rec = json.loads(path.read_text())
        except ValueError:
            rec = None
    if rec is not None and (MODE == "offline" or _is_down(service)):
        return _replay(service, rec)
    t0 = time.time()
    try:
        result = fn()
    except Exception as e:
        mark_down(service)
        if rec is not None:
            log.warning("%s live call failed (%s): using recording", service, type(e).__name__)
            return _replay(service, rec)
        raise
    STATS["live"] += 1
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"result": result, "elapsed_s": round(time.time() - t0, 3),
                                   "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "service": service}))
        tmp.replace(path)
        STATS["recorded"] += 1
    except (TypeError, ValueError, OSError) as e:
        log.warning("%s: could not record (%s)", service, e)
    return result
