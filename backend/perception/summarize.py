"""Track summaries: entry/exit leg, movement, 10 Hz ground path (SHRESTH 1.3, MASTER 4.2).

Also hosts the in-process track cache every later stage reads from.
"""
import threading
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from shapely.geometry import Point, Polygon
from shapely.prepared import prep

from backend.config import DIMS_M, VEHICLES
from backend.perception.calibrate import resample, tracks_path
from backend.perception.camera import get_camera

RIGHT_OF = {"S": "E", "N": "W", "E": "N", "W": "S"}
LEFT_OF = {"S": "W", "N": "E", "E": "S", "W": "N"}
OPPOSITE = {"S": "N", "N": "S", "E": "W", "W": "E"}


def movement_for(entry, exit_):
    if not entry or not exit_:
        return "unknown"
    if entry == exit_:
        return "u_turn"
    if OPPOSITE.get(entry) == exit_:
        return "through"
    if RIGHT_OF.get(entry) == exit_:
        return "right_turn"
    if LEFT_OF.get(entry) == exit_:
        return "left_turn"
    return "unknown"


@dataclass
class Track:
    camera_id: str
    track_id: int
    cls: str
    t: np.ndarray
    gx: np.ndarray
    gy: np.ndarray
    vx: np.ndarray
    vy: np.ndarray
    summary: dict = field(default_factory=dict)

    @property
    def speed(self):
        return np.hypot(self.vx, self.vy)

    @property
    def xy(self):
        return np.column_stack([self.gx, self.gy])


class Ground:
    """Prepared leg / crosswalk polygons for one camera."""

    def __init__(self, cam):
        g = cam.get("ground", {})
        self.legs = {k: Polygon(v) for k, v in g.get("legs", {}).items() if len(v) >= 3}
        self._legs_p = {k: prep(p) for k, p in self.legs.items()}
        self.crosswalks = {c["id"]: Polygon(c["polygon"]) for c in g.get("crosswalks", []) if len(c["polygon"]) >= 3}
        self._cw_p = {k: prep(p) for k, p in self.crosswalks.items()}

    def leg_of(self, x, y):
        pt = Point(x, y)
        for k, p in self._legs_p.items():
            if p.contains(pt):
                return k
        return None

    def nearest_leg(self, x, y, max_d=8.0):
        if not self.legs:
            return None
        pt = Point(x, y)
        k, d = min(((k, p.distance(pt)) for k, p in self.legs.items()), key=lambda kv: kv[1])
        return k if d <= max_d else None

    def crosswalk_of(self, x, y):
        pt = Point(x, y)
        for k, p in self._cw_p.items():
            if p.contains(pt):
                return k
        return None


def movement_from_heading(tr: Track, min_travel_m=6.0):
    """No leg polygons (uncalibrated camera): classify by net heading change. X right, Y away from the
    camera is right-handed, so a left turn is a counter-clockwise (positive) change."""
    n = len(tr.t)
    if n < 6:
        return "unknown"
    k = max(2, n // 4)
    d0 = np.array([tr.gx[k] - tr.gx[0], tr.gy[k] - tr.gy[0]])
    d1 = np.array([tr.gx[-1] - tr.gx[-1 - k], tr.gy[-1] - tr.gy[-1 - k]])
    if np.hypot(*d0) < 1.0 or np.hypot(*d1) < 1.0 or np.hypot(tr.gx[-1] - tr.gx[0], tr.gy[-1] - tr.gy[0]) < min_travel_m:
        return "unknown"
    turn = np.degrees(np.arctan2(d0[0] * d1[1] - d0[1] * d1[0], d0 @ d1))
    if abs(turn) < 30:
        return "through"
    if abs(turn) > 150:
        return "u_turn"
    if 50 <= turn <= 150:
        return "left_turn"
    if -150 <= turn <= -50:
        return "right_turn"
    return "unknown"


def summarize_track(tr: Track, ground: Ground):
    entry = ground.leg_of(tr.gx[0], tr.gy[0]) or ground.nearest_leg(tr.gx[0], tr.gy[0])
    exit_ = ground.leg_of(tr.gx[-1], tr.gy[-1]) or ground.nearest_leg(tr.gx[-1], tr.gy[-1])
    in_cw = next((cw for x, y in zip(tr.gx[::3], tr.gy[::3]) if (cw := ground.crosswalk_of(x, y))), None)
    if tr.cls in VEHICLES:
        mv = movement_for(entry, exit_)
        if mv == "unknown" and not ground.legs:
            mv = movement_from_heading(tr)
    elif tr.cls == "bicycle" and movement_for(entry, exit_) not in ("unknown", "u_turn"):
        mv = movement_for(entry, exit_)
    elif tr.cls == "bicycle" and not ground.legs:
        mv = movement_from_heading(tr)
    elif not ground.crosswalks and tr.cls == "person":
        mv = "crossing"  # no crosswalk polygons drawn yet: treat people on the road as crossing
    else:
        mv = "crossing" if in_cw else "unknown"
    return {
        "camera_id": tr.camera_id, "track_id": int(tr.track_id), "cls": tr.cls,
        "t_in": round(float(tr.t[0]), 2), "t_out": round(float(tr.t[-1]), 2),
        "entry_leg": entry, "exit_leg": exit_, "movement": mv, "crosswalk": in_cw,
        "path": [[round(float(a), 2), round(float(b), 2), round(float(c), 2)] for a, b, c in zip(tr.t, tr.gx, tr.gy)],
        "max_speed_mps": round(float(tr.speed.max()), 2),
        "dims_m": list(DIMS_M.get(tr.cls, (1.0, 1.0))),
    }


class TrackStore:
    """Per-camera cache: raw per-frame rows + 10 Hz Track objects with summaries. Reloads on file change."""

    def __init__(self):
        self._lock = threading.Lock()
        self._cache = {}

    def _load(self, camera_id):
        p = tracks_path(camera_id)
        mtime = p.stat().st_mtime if p.exists() else None
        hit = self._cache.get(camera_id)
        if hit and hit[0] == mtime:
            return hit[1]
        if mtime is None:
            entry = {"df": pd.DataFrame(), "tracks": {}, "duration_s": 0.0}
        else:
            df = pd.read_parquet(p)
            ground = Ground(get_camera(camera_id))
            tracks = {}
            for tid, d in df.groupby("track_id"):
                t, gx, gy, vx, vy = resample(d)
                tr = Track(camera_id, int(tid), d["cls"].mode().iloc[0], t, gx, gy, vx, vy)
                tr.summary = summarize_track(tr, ground)
                tracks[int(tid)] = tr
            entry = {"df": df, "tracks": tracks, "duration_s": float(df["t"].max()) if len(df) else 0.0}
        self._cache[camera_id] = (mtime, entry)
        return entry

    def get(self, camera_id):
        with self._lock:
            return self._load(camera_id)

    def tracks(self, camera_id):
        return self.get(camera_id)["tracks"]

    def frames(self, camera_id):
        return self.get(camera_id)["df"]

    def summaries(self, camera_id):
        return [tr.summary for tr in self.tracks(camera_id).values()]

    def invalidate(self, camera_id=None):
        with self._lock:
            if camera_id:
                self._cache.pop(camera_id, None)
            else:
                self._cache.clear()


STORE = TrackStore()
