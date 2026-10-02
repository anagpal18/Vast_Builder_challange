"""Stand-in for Kenil's `memory/` package (MASTER 5). Same function signatures.

verify_event: ACCEPT when the candidate matches a real ground-truth scenario, REJECT for decoys,
UNSURE otherwise. similar_*: same conflict type. Store is in-process + JSON on disk.
"""
import json
import threading

from backend.config import CACHE_DIR, GT_DIR
from backend.perception.camera import get_camera

_LOCK = threading.Lock()
_EVENTS_PATH = CACHE_DIR / "mock_events.json"
_EVENTS: dict = json.loads(_EVENTS_PATH.read_text()) if _EVENTS_PATH.exists() else {}
_TRACKS: dict = {}

MODEL = "mock-from-ground-truth"


def _gt():
    p = GT_DIR / "events.json"
    return json.loads(p.read_text()) if p.exists() else []


def _match(event):
    best = None
    for g in _gt():
        if g["camera_id"] != event["camera_id"] or abs(g["t"] - event["t_conflict"]) > 1.5:
            continue
        if {g["a_cls"], g["b_cls"]} != {event["a"]["cls"], event["b"]["cls"]}:
            continue
        if best is None or abs(g["t"] - event["t_conflict"]) < abs(best["t"] - event["t_conflict"]):
            best = g
    return best


def _describe(event, g):
    a, b = event["a"], event["b"]
    mv = (a.get("movement") or "").replace("_", " ")
    who = {"person": "pedestrian", "bicycle": "cyclist"}.get(b["cls"], f"oncoming {b['cls']}")
    first = "the " + who if event["first_through"] == "b" else f"the {a['cls']}"
    return (f"A {a['cls']} making a {mv} and a {who} cross paths at the conflict point; "
            f"{first} goes through first with {event['pet_s']:.1f} s to spare.")


def verify_event(event: dict, clip_path: str) -> dict:
    cam = get_camera(event["camera_id"])
    night = cam.get("lighting") == "night"
    g = _match(event)
    cond = {"lighting": "night" if night else "day", "weather": "clear", "visibility_issue": night}
    base = {"model": MODEL, "conditions": cond}
    if g is None:
        return {**base, "verdict": "UNSURE", "confidence": 0.4,
                "reason": "Geometry flags a close pass but the interaction is not clearly a conflict in the clip.",
                "description": _describe(event, {}), "contributing_factors": [], "evasive_action": None}
    if not g["is_conflict"]:
        return {**base, "verdict": "REJECT", "confidence": 0.86,
                "reason": f"Not a conflict: {g['note']}.", "description": _describe(event, g),
                "contributing_factors": [], "evasive_action": None}
    factors, evasive = [], None
    if g["conflict_type"].startswith("ped_vs_right") or g["conflict_type"].startswith("bike_vs_right"):
        factors.append("driver did not yield while turning right")
    if g["conflict_type"] == "veh_left_turn_vs_through":
        factors.append("left-turning driver misjudged the oncoming gap")
    if g["conflict_type"] == "ped_vs_through":
        factors.append("vehicle approaching above the speed limit")
    if night:
        factors.append("poor lighting at the crossing")
    if event["camera_id"] == "CAM_A1":
        factors.append("pedestrian partly hidden by parked van")
        cond["visibility_issue"] = True
    if g.get("crash"):
        reason = "Vehicle strikes the pedestrian in the crosswalk; both stop after contact."
        evasive = "none, contact occurred"
    else:
        evasive = "pedestrian stepped back" if b_is(event, "person") else "braking"
        reason = (f"{event['a']['cls'].capitalize()} and {event['b']['cls']} paths cross within "
                  f"{event['pet_s']:.1f} s; the encounter is a genuine near miss.")
    return {**base, "verdict": "ACCEPT", "confidence": 0.82, "reason": reason,
            "description": _describe(event, g), "contributing_factors": factors, "evasive_action": evasive}


def b_is(event, cls):
    return event["b"]["cls"] == cls


def store_event(event: dict) -> None:
    with _LOCK:
        _EVENTS[event["event_id"]] = event
        _EVENTS_PATH.write_text(json.dumps(_EVENTS))


def store_track_summaries(rows: list) -> None:
    for r in rows:
        _TRACKS[(r["camera_id"], r["track_id"])] = r


def similar_events(event_id: str, k: int = 8, exclude_ids: list = []) -> list:
    ev = _EVENTS.get(event_id)
    if not ev:
        return []
    out = []
    for e in _EVENTS.values():
        if e["event_id"] == event_id or e["event_id"] in exclude_ids or e["conflict_type"] != ev["conflict_type"]:
            continue
        if e.get("status") != "verified":
            continue
        s = 0.9 if e["site_id"] == ev["site_id"] else 0.6
        if e["a"].get("movement") == ev["a"].get("movement"):
            s += 0.05
        out.append({"event": e, "score": round(s, 2)})
    return sorted(out, key=lambda r: -r["score"])[:k]


def similar_chunks(text: str, k: int = 10, site_id=None) -> list:
    return []  # no chunk index in the mock


def index_footage(camera_id: str) -> int:
    return 0


def get_event(event_id):
    return _EVENTS.get(event_id)


def list_events(site_id=None, status=None):
    return [e for e in _EVENTS.values()
            if (site_id is None or e["site_id"] == site_id) and (status is None or e.get("status") == status)]
