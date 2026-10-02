"""Memory backed by the team's real stack (same API as Kenil's `memory/`, MASTER 5).

- verify_event: NVIDIA Cosmos3-Reason watches the event clip with the measured facts → ACCEPT/REJECT/UNSURE.
  Simulated cameras keep the ground-truth verifier so the Weave eval stays meaningful.
- similar_events: cosine over NVIDIA Cosmos Embed1 vectors of the verified descriptions.
- similar_chunks: VSS hybrid search over the whole indexed archive (VastDB), mapped back onto our cameras.
- store_*/get/list: local JSON (VastDB writes are Kenil's package; this keeps the API working without it).
"""
import json
import logging
import threading

import numpy as np

from backend import memory_mock as _local
from backend.config import CACHE_DIR
from backend.perception.camera import get_camera, load_cameras
from backend.vss import gpu
from backend.vss.client import client, pick, rows

log = logging.getLogger("almost.memory.vss")
_VEC_PATH = CACHE_DIR / "vss_vectors.json"
_VECS: dict = json.loads(_VEC_PATH.read_text()) if _VEC_PATH.exists() else {}
_LOCK = threading.Lock()

MODEL_NAME = "cosmos3-reason"
VERIFY_PROMPT = """You are verifying a possible traffic near miss in this street-camera clip for a road-safety review.
Our trajectory measurement says: a {a_cls} ({a_mv}, about {a_speed:.1f} m/s) and a {b_cls} ({b_mv}) pass through the
same spot {pet:.1f} s apart (post-encroachment time) at about {tc:.1f} s into the clip; the {first} goes through first.

Decide from the video whether this is a genuine conflict (one road user had to brake, swerve, stop, hurry, or came
dangerously close), NOT a conflict (normal passing, someone waiting at the curb, clearly separated, tracking error),
or UNSURE (occluded, too far, cannot tell).

Answer with JSON only:
{{"verdict": "ACCEPT" | "REJECT" | "UNSURE",
  "reason": "<one sentence>",
  "description": "<2 sentences describing the interaction>",
  "contributing_factors": ["<short phrase>", ...],
  "conditions": {{"lighting": "day" | "night" | "dusk", "weather": "<word>", "visibility_issue": true | false}},
  "evasive_action": "<short phrase or null>",
  "confidence": <0..1>}}"""


def _is_sim(camera_id):
    try:
        return "sim" in get_camera(camera_id)
    except KeyError:
        return False


def _normalize(v, cam):
    verdict = str(v.get("verdict", "UNSURE")).upper().strip()
    verdict = verdict if verdict in ("ACCEPT", "REJECT", "UNSURE") else "UNSURE"
    cond = v.get("conditions") if isinstance(v.get("conditions"), dict) else {}
    lighting = str(cond.get("lighting") or cam.get("lighting") or "day").lower()
    try:
        conf = float(v.get("confidence", 0.5))
    except (TypeError, ValueError):
        conf = 0.5
    return {"verdict": verdict, "reason": str(v.get("reason") or "")[:400],
            "description": str(v.get("description") or "")[:800],
            "contributing_factors": [str(x)[:120] for x in (v.get("contributing_factors") or [])][:6],
            "conditions": {"lighting": lighting if lighting in ("day", "night", "dusk") else "day",
                           "weather": str(cond.get("weather") or "clear"),
                           "visibility_issue": bool(cond.get("visibility_issue", False))},
            "evasive_action": v.get("evasive_action") or None, "model": MODEL_NAME,
            "confidence": max(0.0, min(1.0, conf))}


def verify_event(event: dict, clip_path: str) -> dict:
    if _is_sim(event["camera_id"]):
        return _local.verify_event(event, clip_path)
    cam = get_camera(event["camera_id"])
    if not clip_path or not gpu.available():
        why = "no clip" if not clip_path else "GPU_BEARER_TOKEN not set"
        return _normalize({"verdict": "UNSURE", "reason": f"Not verified: {why}.", "confidence": 0.0}, cam)
    first = event["a"]["cls"] if event["first_through"] == "a" else event["b"]["cls"]
    prompt = VERIFY_PROMPT.format(a_cls=event["a"]["cls"], a_mv=(event["a"].get("movement") or "").replace("_", " "),
                                  a_speed=event["a"].get("speed_mps", 0), b_cls=event["b"]["cls"],
                                  b_mv=(event["b"].get("movement") or "").replace("_", " "), pet=event["pet_s"],
                                  tc=event["t_conflict"] - event["clip"]["t0"], first=first)
    try:
        return _normalize(gpu.cosmos_video_json(prompt, clip_path), cam)
    except Exception as e:
        log.warning("cosmos verify %s failed: %s", event["event_id"], e)
        return _normalize({"verdict": "UNSURE", "reason": f"Cosmos3-Reason call failed: {type(e).__name__}.",
                           "confidence": 0.0}, cam)


def store_event(event: dict) -> None:
    _local.store_event(event)
    desc = (event.get("verification") or {}).get("description")
    if desc and gpu.available() and event["event_id"] not in _VECS:
        try:
            vec = gpu.embed_text(f"{event['conflict_type'].replace('_', ' ')}. {desc}")[0]
            with _LOCK:
                _VECS[event["event_id"]] = vec
                _VEC_PATH.write_text(json.dumps(_VECS))
        except Exception as e:
            log.warning("embed %s failed: %s", event["event_id"], e)


def store_track_summaries(rows_: list) -> None:
    _local.store_track_summaries(rows_)


def similar_events(event_id: str, k: int = 8, exclude_ids: list = []) -> list:
    ev = _local.get_event(event_id)
    if not ev or event_id not in _VECS:
        return _local.similar_events(event_id, k, exclude_ids)
    q = np.asarray(_VECS[event_id], float)
    q /= np.linalg.norm(q) + 1e-9
    out = []
    for oid, vec in _VECS.items():
        e = _local.get_event(oid)
        if oid == event_id or oid in exclude_ids or not e or e.get("status") != "verified":
            continue
        v = np.asarray(vec, float)
        s = float(q @ (v / (np.linalg.norm(v) + 1e-9)))
        if e["conflict_type"] == ev["conflict_type"]:
            s = min(1.0, s + 0.1)  # same mechanism matters more than wording
        out.append({"event": e, "score": round(s, 3)})
    return sorted(out, key=lambda r: -r["score"])[:k]


def _vss_to_ours():
    """VSS camera_id → (our camera_id, {original_video: offset_s})."""
    m = {}
    for c in load_cameras():
        v = c.get("vss")
        if v:
            m[v["camera_id"]] = (c["camera_id"], {ov: i * 30.0 for i, ov in enumerate(v.get("chunks", []))})
    return m


def similar_chunks(text: str, k: int = 10, site_id=None) -> list:
    vss = client()
    if not vss.configured:
        return []
    mapping = _vss_to_ours()
    cams = [c for c in load_cameras() if c.get("vss") and (site_id is None or c["site_id"] == site_id)]

    def one(cam):  # cameras searched in parallel: each search is a round trip through the tunnel
        vid = cam["vss"]["camera_id"]
        try:
            r = vss.search(text, top_k=k, min_similarity=0.25, llm_top_n=1, metadata_filters={"camera_id": vid},
                           retries=2)
        except Exception as e:
            log.warning("vss search failed: %s", e)
            return []
        ours, offsets = mapping.get(vid, (cam["camera_id"], {}))
        hits = []
        for hit in rows(r, "results"):
            ov = pick(hit, "original_video")
            if ov not in offsets:
                continue  # outside the window we ingested
            t0 = offsets[ov] + float(pick(hit, "segment_start_sec", "best_match_start_sec", default=0.0))
            t1 = offsets[ov] + float(pick(hit, "segment_end_sec", "best_match_end_sec", default=t0 - offsets[ov] + 5))
            hits.append({"chunk": {"chunk_id": pick(hit, "source"), "camera_id": ours, "site_id": cam["site_id"],
                                   "t_start": t0, "t_end": t1, "caption": pick(hit, "reasoning_content", default=""),
                                   "clip_url": None, "thumb_url": None},
                         "score": float(pick(hit, "similarity_score", default=0.0))})
        return hits
    import contextvars
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max(1, len(cams))) as ex:
        out = [h for hs in ex.map(lambda c: contextvars.copy_context().run(one, c), cams) for h in hs]
    return sorted(out, key=lambda r: -r["score"])[:k]


def index_footage(camera_id: str) -> int:
    return 0  # the VSS pipeline already indexed the archive


def get_event(event_id):
    return _local.get_event(event_id)


def list_events(site_id=None, status=None):
    return _local.list_events(site_id, status)
