"""Closeness math: crossing point, PET, min TTC, conflict type, candidates (SHRESTH 1.4, MASTER 4.3/4.6)."""
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points

from backend import config as C
from backend.perception.camera import camera_short, get_camera

VEH = C.VEHICLES


def _interp(tr, tt):
    return (np.interp(tt, tr.t, tr.gx), np.interp(tt, tr.t, tr.gy),
            np.interp(tt, tr.t, tr.vx), np.interp(tt, tr.t, tr.vy))


def _line(tr):
    xy = tr.xy
    if len(xy) < 2 or np.ptp(xy, axis=0).max() < 1e-6:
        return None
    return LineString(xy)


def _points(geom):
    if geom.is_empty:
        return []
    gt = geom.geom_type
    if gt == "Point":
        return [geom]
    if gt in ("MultiPoint", "GeometryCollection", "MultiLineString"):
        out = []
        for g in geom.geoms:
            out += _points(g)
        return out
    if gt == "LineString":  # collinear overlap: use its midpoint
        return [geom.interpolate(0.5, normalized=True)]
    return []


def _time_at(tr, p):
    d = np.hypot(tr.gx - p[0], tr.gy - p[1])
    i = int(np.argmin(d))
    return tr.t[i], d[i], i


def occupancy(tr, p, radius):
    """[t_enter, t_exit] of the contiguous stretch where tr's center is within radius+margin of p."""
    d = np.hypot(tr.gx - p[0], tr.gy - p[1])
    i0 = int(np.argmin(d))
    thr = max(radius + C.OCCUPANCY_MARGIN_M, d[i0] + 0.1)
    inside = d <= thr
    lo = i0
    while lo > 0 and inside[lo - 1]:
        lo -= 1
    hi = i0
    while hi < len(d) - 1 and inside[hi + 1]:
        hi += 1
    return float(tr.t[lo]), float(tr.t[hi]), i0


def min_ttc(a, b, t0, t1, ra, rb):
    tt = np.round(np.arange(np.ceil(t0 * 10), np.floor(t1 * 10) + 1) / 10, 3)
    if len(tt) == 0:
        return None, None
    ax, ay, avx, avy = _interp(a, tt)
    bx, by, bvx, bvy = _interp(b, tt)
    dpx, dpy, dvx, dvy = bx - ax, by - ay, bvx - avx, bvy - avy
    R = ra + rb
    qa = dvx ** 2 + dvy ** 2
    qb = 2 * (dpx * dvx + dpy * dvy)
    qc = dpx ** 2 + dpy ** 2 - R ** 2
    ttc = np.full(len(tt), np.inf)
    ttc[qc <= 0] = 0.0
    disc = qb ** 2 - 4 * qa * qc
    ok = (qc > 0) & (qb < 0) & (qa > 1e-9) & (disc >= 0)
    ttc[ok] = (-qb[ok] - np.sqrt(disc[ok])) / (2 * qa[ok])
    i = int(np.argmin(ttc))
    if not np.isfinite(ttc[i]):
        return None, None
    return float(ttc[i]), float(tt[i])


def _heading_at(tr, i):
    return np.degrees(np.arctan2(tr.vy[i], tr.vx[i])) % 360


def _angle_diff(h1, h2):
    d = abs(h1 - h2) % 360
    return min(d, 360 - d)


def conflict_type(a, b, sa, sb, heading_diff):
    ma = sa.get("movement")
    if b.cls in VEH:  # vehicle vs vehicle
        mb = sb.get("movement")
        if heading_diff < 20:
            return "veh_rear_end"
        if {ma, mb} == {"left_turn", "through"}:
            return "veh_left_turn_vs_through"
        if heading_diff > 45:
            return "veh_angle"
        return "other"
    if b.cls == "person":
        return {"right_turn": "ped_vs_right_turn", "left_turn": "ped_vs_left_turn",
                "through": "ped_vs_through"}.get(ma, "other")
    if b.cls == "bicycle":
        return {"right_turn": "bike_vs_right_turn", "through": "bike_vs_through"}.get(ma, "other")
    return "other"


def severity(pet):
    for lim, name in C.SEVERITY:
        if pet < lim:
            return name
    return "low"


def score(pet, ttc, vulnerable):
    p = 0.6 * (1 - min(pet if pet is not None else 3, 3) / 3)
    t = 0.3 * (1 - min(ttc if ttc is not None else 2, 2) / 2)
    return round(p + t + (0.1 if vulnerable else 0.0), 3)


def order_pair(t1, t2):
    """Return (a, b): a is the vehicle. Two vehicles: the left-turner (or the first) is a."""
    if t1.cls not in VEH and t2.cls in VEH:
        return t2, t1
    if t1.cls in VEH and t2.cls in VEH:
        if t2.summary.get("movement") == "left_turn" and t1.summary.get("movement") != "left_turn":
            return t2, t1
    return t1, t2


def analyze_pair(t1, t2, thresholds=None):
    """Full measurement for one pair. Returns a dict of metrics (candidate or not) or None if not comparable."""
    th = thresholds or {"pet": C.PET_CANDIDATE_S, "ttc": C.TTC_CANDIDATE_S}
    if t1.cls not in VEH and t2.cls not in VEH:
        return None
    o0, o1 = max(t1.t[0], t2.t[0]), min(t1.t[-1], t2.t[-1])
    if o1 - o0 < C.MIN_OVERLAP_S:
        return None
    a, b = order_pair(t1, t2)
    for tr in (a, b):
        if tr.cls in VEH and tr.speed.max() < C.STATIONARY_SPEED_MPS:
            return None
    la, lb = _line(a), _line(b)
    if la is None or lb is None:
        return None
    if la.distance(lb) > C.CLOSEST_APPROACH_M:
        return None

    pts = _points(la.intersection(lb))
    if pts:
        best = min(pts, key=lambda p: abs(_time_at(a, (p.x, p.y))[0] - _time_at(b, (p.x, p.y))[0]))
        P = (best.x, best.y)
    else:
        pa, pb = nearest_points(la, lb)
        P = ((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)

    ra, rb = C.RADIUS_M.get(a.cls, 1.0), C.RADIUS_M.get(b.cls, 1.0)
    ea, xa, ia = occupancy(a, P, ra)
    eb, xb, ib = occupancy(b, P, rb)
    heading_diff = _angle_diff(_heading_at(a, ia), _heading_at(b, ib))
    rear_end = a.cls in VEH and b.cls in VEH and heading_diff < 20

    if ea <= eb:
        first, (e1, x1), (e2, x2) = "a", (ea, xa), (eb, xb)
    else:
        first, (e1, x1), (e2, x2) = "b", (eb, xb), (ea, xa)
    pet = 0.0 if e2 <= x1 else e2 - x1

    w0 = max(o0, min(ea, eb) - 5.0)
    w1 = min(o1, max(xa, xb) + 1.0)
    ttc, ttc_t = min_ttc(a, b, w0, w1, ra, rb) if w1 > w0 else (None, None)

    if rear_end:  # same direction: only a closing follower is a conflict; PET = time headway then
        if ttc is None or ttc_t is None:
            return None
        ax, ay, avx, avy = _interp(a, np.array([ttc_t]))
        bx, by, bvx, bvy = _interp(b, np.array([ttc_t]))
        gap = float(np.hypot(bx - ax, by - ay)[0])
        vf = max(float(np.hypot(avx, avy)[0]), float(np.hypot(bvx, bvy)[0]), 0.1)
        pet = gap / vf
        e2 = ttc_t

    is_cand = pet < th["pet"] or (ttc is not None and ttc < th["ttc"])
    ctype = conflict_type(a, b, a.summary, b.summary, heading_diff)
    return {
        "candidate": bool(is_cand),
        "a": a, "b": b, "P": P,
        "pet_s": round(float(pet), 2),
        "min_ttc_s": None if ttc is None else round(ttc, 2),
        "first_through": first,
        "t_conflict": round(float(e2), 2),
        "occupancy": {"a": [ea, xa], "b": [eb, xb]},
        "speed_a": float(a.speed[ia]), "speed_b": float(b.speed[ib]),
        "heading_diff": round(float(heading_diff), 1),
        "conflict_type": ctype,
        "severity": severity(pet),
        "score": score(pet, ttc, b.cls in C.VULNERABLE),
    }


def _actor(tr, speed):
    s = tr.summary
    return {"track_id": int(tr.track_id), "cls": tr.cls, "movement": s.get("movement"),
            "entry_leg": s.get("entry_leg"), "exit_leg": s.get("exit_leg"),
            "crosswalk": s.get("crosswalk"), "speed_mps": round(speed, 2)}


def to_event(m, camera_id, site_id, duration_s=None, fps=None):
    cs = camera_short(camera_id)
    tc = m["t_conflict"]
    t0 = max(0.0, tc - C.CLIP_PAD_S)
    t1 = tc + C.CLIP_PAD_S if duration_s is None else min(duration_s, tc + C.CLIP_PAD_S)
    if fps:  # cut on frame boundaries so camera time = clip.t0 + media time holds exactly
        t0, t1 = np.floor(t0 * fps) / fps, np.floor(t1 * fps) / fps
    eid = f"EV_{cs}_{int(tc * 10):04d}"
    return {
        "event_id": eid, "site_id": site_id, "camera_id": camera_id,
        "t_conflict": tc,
        "clip": {"t0": round(float(t0), 4), "t1": round(float(t1), 4),
                 "url": f"/media/clips/{eid}.mp4", "thumb": f"/media/thumbs/{eid}.jpg"},
        "a": _actor(m["a"], m["speed_a"]), "b": _actor(m["b"], m["speed_b"]),
        "conflict_type": m["conflict_type"],
        "conflict_point": [round(m["P"][0], 2), round(m["P"][1], 2)],
        "pet_s": m["pet_s"], "min_ttc_s": m["min_ttc_s"], "first_through": m["first_through"],
        "severity": m["severity"], "score": m["score"],
        "verification": None, "pattern_id": None, "status": "candidate",
    }


def measure_camera(camera_id, store, t_range=None, thresholds=None):
    """All pairs at one camera → (candidate events sorted by score, interactions measured)."""
    cam = get_camera(camera_id)
    entry = store.get(camera_id)
    trs = sorted(entry["tracks"].values(), key=lambda t: t.t[0])
    if t_range:
        trs = [t for t in trs if t.t[-1] >= t_range[0] and t.t[0] <= t_range[1]]
    events, seen, interactions = [], set(), 0
    for i, t1 in enumerate(trs):
        for t2 in trs[i + 1:]:
            if t2.t[0] > t1.t[-1] - C.MIN_OVERLAP_S:
                break
            if t1.cls not in VEH and t2.cls not in VEH:
                continue
            interactions += 1
            m = analyze_pair(t1, t2, thresholds)
            if not m or not m["candidate"]:
                continue
            ev = to_event(m, camera_id, cam["site_id"], entry["duration_s"], cam.get("fps"))
            base, k = ev["event_id"], 1
            while ev["event_id"] in seen:
                k += 1
                ev["event_id"] = f"{base}_{k}"
                ev["clip"]["url"] = f"/media/clips/{ev['event_id']}.mp4"
                ev["clip"]["thumb"] = f"/media/thumbs/{ev['event_id']}.jpg"
            seen.add(ev["event_id"])
            events.append(ev)
    events.sort(key=lambda e: -e["score"])
    return events, interactions
