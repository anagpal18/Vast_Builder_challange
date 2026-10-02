"""Simulated world: road geometry, actor paths with speed/stop profiles, site + camera layout.

Ground frame: meters, intersection center at (0, 0), +x east, +y north. Drive on the right.
"""
from dataclasses import dataclass, field

import numpy as np

LANE = 1.75          # lane center offset
BIKE = 4.5           # bike lane center offset
ROAD = 6.0           # road half width (curb)
CW_IN, CW_OUT = 7.0, 10.0  # crosswalk band distance from center
REACH = 70.0         # how far paths extend along each leg

ROT = {"S": 0, "E": 90, "N": 180, "W": 270}  # canonical approach is from S heading north


def rot(pts, leg):
    a = np.radians(ROT[leg])
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return np.asarray(pts, float) @ R.T


def _arc(c, r, a0, a1, n=24):
    a = np.radians(np.linspace(a0, a1, n))
    return np.column_stack([c[0] + r * np.cos(a), c[1] + r * np.sin(a)])


def _line(p0, p1, step=1.0):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    n = max(2, int(np.linalg.norm(p1 - p0) / step) + 1)
    return np.linspace(p0, p1, n)


def _join(*parts):
    out = [parts[0]]
    for p in parts[1:]:
        out.append(p[1:] if np.allclose(out[-1][-1], p[0]) else p)
    return np.vstack(out)


def vehicle_path(entry, movement, lane=LANE, reach=REACH):
    if movement == "through":
        pts = _line((lane, -reach), (lane, reach))
    elif movement == "right_turn":
        r = ROAD - lane
        pts = _join(_line((lane, -reach), (lane, -ROAD)), _arc((ROAD, -ROAD), r, 180, 90),
                    _line((ROAD, -lane), (reach, -lane)))
    elif movement == "left_turn":
        r = ROAD + lane
        pts = _join(_line((lane, -reach), (lane, -ROAD)), _arc((-ROAD, -ROAD), r, 0, 90),
                    _line((-ROAD, lane), (-reach, lane)))
    else:
        raise ValueError(movement)
    return rot(pts, entry)


def crosswalk_path(side, direction=1, extra=3.0):
    """Pedestrian path across crosswalk on `side` (N/S/E/W). direction=+1 walks counter-clockwise."""
    mid = (CW_IN + CW_OUT) / 2
    half = ROAD + extra
    pts = _line((-half * direction, -mid), (half * direction, -mid), 0.5)  # canonical = south crosswalk
    return rot(pts, side)


def crosswalk_polygon(side):
    poly = np.array([[-ROAD, -CW_OUT], [ROAD, -CW_OUT], [ROAD, -CW_IN], [-ROAD, -CW_IN]])
    return rot(poly, side)


def intersection_ground():
    legs = {}
    for leg in "NSEW":
        legs[leg] = rot([[-ROAD, -REACH - 20], [ROAD, -REACH - 20], [ROAD, -ROAD], [-ROAD, -ROAD]], leg).round(2).tolist()
    cws = [{"id": f"CW_{s}", "polygon": crosswalk_polygon(s).round(2).tolist()} for s in "NSEW"]
    box = [[-ROAD, -ROAD], [ROAD, -ROAD], [ROAD, ROAD], [-ROAD, ROAD]]
    return {"legs": legs, "crosswalks": cws, "box": box}


def midblock_ground():
    L = REACH + 20
    return {"legs": {"W": [[-L, -ROAD], [0, -ROAD], [0, ROAD], [-L, ROAD]],
                     "E": [[0, -ROAD], [L, -ROAD], [L, ROAD], [0, ROAD]]},
            "crosswalks": [{"id": "CW_MID", "polygon": [[-1.5, -ROAD], [1.5, -ROAD], [1.5, ROAD], [-1.5, ROAD]]}],
            "box": []}


# --- Actors ---------------------------------------------------------------------------------

DIMS3 = {"person": (0.5, 0.5, 1.75), "bicycle": (1.8, 0.6, 1.7), "car": (4.5, 1.8, 1.5),
         "truck": (8.0, 2.5, 3.0), "bus": (12.0, 2.5, 3.2), "motorcycle": (2.2, 0.8, 1.5)}


@dataclass
class Actor:
    cls: str
    path: np.ndarray
    speed: float
    t_start: float = 0.0
    stops: list = field(default_factory=list)   # [(s_at, duration_s)]
    color: tuple = (180, 180, 180)
    tag: str = "bg"
    parked_until: float = None                  # stationary actor: sits at path[0] for the whole clip
    track_id: int = -1

    def __post_init__(self):
        seg = np.linalg.norm(np.diff(self.path, axis=0), axis=1)
        self.cum = np.concatenate([[0], np.cumsum(seg)])
        self.length = float(self.cum[-1])
        self.stops = sorted(self.stops)

    @property
    def t_end(self):
        if self.parked_until is not None:
            return self.parked_until
        return self.t_start + self.length / self.speed + sum(d for _, d in self.stops)

    def s_at(self, t):
        t = np.asarray(t, float)
        if self.parked_until is not None:
            return np.zeros_like(t)
        rel = t - self.t_start
        v = self.speed
        s = rel * v
        off = 0.0
        for s_stop, dur in self.stops:  # hold at s_stop for dur, then continue
            ta = s_stop / v + off
            s = np.where(rel >= ta + dur, (rel - off - dur) * v, np.where(rel >= ta, s_stop, s))
            off += dur
        return np.clip(s, 0, self.length)

    def pose(self, t):
        s = self.s_at(t)
        x = np.interp(s, self.cum, self.path[:, 0])
        y = np.interp(s, self.cum, self.path[:, 1])
        ds = 0.5
        x2 = np.interp(np.minimum(s + ds, self.length), self.cum, self.path[:, 0])
        y2 = np.interp(np.minimum(s + ds, self.length), self.cum, self.path[:, 1])
        x1 = np.interp(np.maximum(s - ds, 0), self.cum, self.path[:, 0])
        y1 = np.interp(np.maximum(s - ds, 0), self.cum, self.path[:, 1])
        hd = np.arctan2(y2 - y1, x2 - x1)
        return x, y, hd

    def active(self, t):
        t = np.asarray(t, float)
        return (t >= self.t_start) & (t <= self.t_end)

    def s_of_point(self, p):
        d = np.hypot(self.path[:, 0] - p[0], self.path[:, 1] - p[1])
        return float(self.cum[int(np.argmin(d))])

    def start_for_arrival(self, s_target, t_arrive):
        """t_start so the actor reaches arc length s_target at t_arrive (counting stops before it)."""
        wait = sum(d for ss, d in self.stops if ss < s_target)
        return t_arrive - s_target / self.speed - wait
