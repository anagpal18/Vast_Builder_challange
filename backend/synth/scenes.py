"""Scenario + background traffic generation with controlled PET, and simulator ground truth."""
import numpy as np
from shapely.geometry import LineString

from backend.perception.conflicts import analyze_pair
from backend.perception.summarize import Ground, Track, summarize_track
from backend.synth.world import (BIKE, LANE, Actor, crosswalk_path, _line, vehicle_path)

DURATION_S = 180.0
CAR_COLORS = [(60, 60, 200), (200, 200, 200), (40, 40, 40), (150, 80, 30), (30, 120, 30),
              (190, 160, 40), (120, 120, 120), (230, 230, 230), (90, 30, 120), (20, 70, 160)]
SHIRTS = [(40, 40, 220), (220, 120, 30), (60, 180, 60), (200, 200, 40), (180, 60, 180), (30, 30, 30)]

# camera_id → scenario list. kind, Tc (s), target PET, who goes first through the conflict point.
SCENARIOS = {
    "CAM_A1": [("ped_rt", 22, 0.7, "b"), ("ped_rt", 64, 1.2, "b"), ("ped_rt_wait", 104, 1.8, "a"),
               ("ped_rt", 146, 0.9, "a")],
    "CAM_A2": [("ped_rt", 35, 1.5, "b"), ("ped_rt_wait", 85, 1.6, "a"), ("crash", 135, 0.0, "a")],
    "CAM_B1": [("lt_thru", 20, 0.9, "b"), ("lt_thru", 58, 1.3, "a"), ("lt_thru_gap", 95, 2.6, "b"),
               ("lt_thru", 128, 1.6, "b"), ("lt_thru", 160, 1.1, "b")],
    "CAM_C1": [("bike_rh", 25, 0.8, "a"), ("bike_rh", 70, 1.4, "a"), ("bike_wait", 112, 2.3, "a"),
               ("bike_rh", 150, 1.0, "b")],
    "CAM_D1": [("ped_mid", 20, 1.1, "b"), ("ped_mid", 58, 0.8, "b"), ("ped_mid_wait", 96, 1.7, "a"),
               ("ped_mid", 130, 1.5, "b"), ("ped_mid", 162, 1.3, "b")],
}
GT_TYPE = {"ped_rt": "ped_vs_right_turn", "ped_rt_wait": "ped_vs_right_turn", "crash": "ped_vs_right_turn",
           "lt_thru": "veh_left_turn_vs_through", "lt_thru_gap": "veh_left_turn_vs_through",
           "bike_rh": "bike_vs_right_turn", "bike_wait": "bike_vs_right_turn",
           "ped_mid": "ped_vs_through", "ped_mid_wait": "ped_vs_through"}
DECOYS = {"ped_rt_wait", "lt_thru_gap", "bike_wait", "ped_mid_wait"}
DECOY_NOTE = {"ped_rt_wait": "pedestrian waits at the curb ramp and yields; vehicle had cleared",
              "lt_thru_gap": "left-turning driver accepts an adequate gap after oncoming car passes",
              "bike_wait": "cyclist stops at the stop line and proceeds after the car has turned",
              "ped_mid_wait": "pedestrian waits at the curb until the car has passed"}


def truth_track(actor, ground, camera_id, hz=10):
    t0, t1 = actor.t_start, min(actor.t_end, DURATION_S)
    t = np.round(np.arange(np.ceil(t0 * hz), np.floor(t1 * hz) + 1) / hz, 3)
    if len(t) < 3:
        return None
    x, y, _ = actor.pose(t)
    tr = Track(camera_id, actor.track_id, actor.cls, t, x, y, np.gradient(x, t), np.gradient(y, t))
    tr.summary = summarize_track(tr, ground)
    return tr


def _cross_point(a, b):
    g = LineString(a.path).intersection(LineString(b.path))
    if g.is_empty:
        return None
    p = g if g.geom_type == "Point" else list(g.geoms)[0]
    return (p.x, p.y)


def _solve(a, b, target, first, ground, cam, Tc):
    """Shift a.t_start so the measured (truth) PET hits `target` with the requested order."""
    P = _cross_point(a, b)
    b.t_start = b.start_for_arrival(b.s_of_point(P), Tc)
    tb = truth_track(b, ground, cam)
    base = a.start_for_arrival(a.s_of_point(P), Tc)

    def evaluate(dt):
        a.t_start = base + dt
        m = analyze_pair(truth_track(a, ground, cam), tb, {"pet": 99, "ttc": 99})
        if not m:
            return 1e9
        penalty = 0 if (m["first_through"] == first or target == 0) else 50
        return abs(m["pet_s"] - target) + penalty

    grid = np.arange(-6, 6, 0.1)
    best = min(grid, key=evaluate)
    fine = np.arange(best - 0.12, best + 0.12, 0.01)
    best = min(fine, key=evaluate)
    a.t_start = base + best
    return a, b


def build_scenario(kind, Tc, pet, first, ground, cam, rng):
    car = lambda p, v, **kw: Actor("car", p, v, color=CAR_COLORS[rng.integers(len(CAR_COLORS))], tag=kind, **kw)
    ped = lambda p, v, **kw: Actor("person", p, v, color=SHIRTS[rng.integers(len(SHIRTS))], tag=kind, **kw)
    if kind in ("ped_rt", "ped_rt_wait", "crash"):
        a = car(vehicle_path("S", "right_turn"), rng.uniform(5.5, 6.5))
        direction = 1 if (kind != "ped_rt" or rng.random() < 0.5) else -1
        b = ped(crosswalk_path("E", direction), rng.uniform(1.25, 1.5))
        if kind == "ped_rt_wait":
            b.stops = [(4.4, 5.0)]
            b.__post_init__()
        if kind == "crash":
            P = _cross_point(a, b)
            b.t_start = b.start_for_arrival(b.s_of_point(P), Tc)
            a.t_start = a.start_for_arrival(a.s_of_point(P), Tc)
            a.stops = [(a.s_of_point(P) + 2.5, 999)]
            b.stops = [(b.s_of_point(P) + 0.3, 999)]
            a.__post_init__(); b.__post_init__()
            return [a, b]
    elif kind in ("lt_thru", "lt_thru_gap"):
        a = car(vehicle_path("S", "left_turn"), rng.uniform(6.5, 7.5))
        b = car(vehicle_path("N", "through"), rng.uniform(10.5, 12.5))
    elif kind in ("bike_rh", "bike_wait"):
        a = car(vehicle_path("S", "right_turn"), rng.uniform(5.5, 6.5))
        b = Actor("bicycle", vehicle_path("S", "through", lane=BIKE), rng.uniform(4.5, 5.5),
                  color=(30, 30, 30), tag=kind)
        if kind == "bike_wait":
            b.stops = [(59.0, 5.0)]
            b.__post_init__()
    elif kind in ("ped_mid", "ped_mid_wait"):
        a = car(vehicle_path("W", "through"), rng.uniform(15.0, 16.5))
        b = ped(_line((0, -9), (0, 9), 0.5), rng.uniform(1.3, 1.5))
        if kind == "ped_mid_wait":
            b.stops = [(3.8, 6.0)]
            b.__post_init__()
    else:
        raise ValueError(kind)
    return list(_solve(a, b, pet, first, ground, cam, Tc))


def _random_actor(site_kind, t, rng):
    if site_kind == "midblock":
        if rng.random() < 0.8:
            leg = "W" if rng.random() < 0.5 else "E"
            return Actor("car" if rng.random() < 0.9 else "truck", vehicle_path(leg, "through"),
                         rng.uniform(9, 13), t, color=CAR_COLORS[rng.integers(len(CAR_COLORS))])
        return Actor("person", _line((0, -9), (0, 9), 0.5) * (1 if rng.random() < 0.5 else -1),
                     rng.uniform(1.2, 1.6), t, color=SHIRTS[rng.integers(len(SHIRTS))])
    r = rng.random()
    if r < 0.72:
        leg = "NSEW"[rng.integers(4)]
        mv = rng.choice(["through", "through", "through", "right_turn", "left_turn"])
        cls = rng.choice(["car"] * 12 + ["truck", "bus"])
        v = rng.uniform(9, 12.5) if mv == "through" else rng.uniform(5, 7)
        return Actor(str(cls), vehicle_path(leg, mv), v, t, color=CAR_COLORS[rng.integers(len(CAR_COLORS))])
    if r < 0.8:
        leg = "NSEW"[rng.integers(4)]
        return Actor("bicycle", vehicle_path(leg, "through", lane=BIKE), rng.uniform(4, 6), t, color=(30, 30, 30))
    side = "NSEW"[rng.integers(4)]
    return Actor("person", crosswalk_path(side, 1 if rng.random() < 0.5 else -1), rng.uniform(1.2, 1.6), t,
                 color=SHIRTS[rng.integers(len(SHIRTS))])


def _min_dist(a, b):
    t0, t1 = max(a.t_start, b.t_start), min(a.t_end, b.t_end)
    if t1 <= t0:
        return np.inf
    tt = np.arange(t0, t1, 0.2)
    if len(tt) == 0:
        return np.inf
    ax, ay, _ = a.pose(tt)
    bx, by, _ = b.pose(tt)
    return float(np.min(np.hypot(ax - bx, ay - by)))


def build_camera(camera_id, site_kind, ground_cfg, seed):
    """All actors for one camera + ground-truth rows."""
    rng = np.random.default_rng(seed)
    ground = Ground({"ground": ground_cfg})
    actors, gt = [], []
    if camera_id == "CAM_A1":  # parked van partly blocking the view of the east crosswalk
        van = Actor("truck", np.array([[15.5, -4.4], [16.5, -4.4]]), 1.0, 0.0, color=(235, 235, 235),
                    tag="parked", parked_until=DURATION_S)
        actors.append(van)
    for i, (kind, Tc, pet, first) in enumerate(SCENARIOS[camera_id]):
        pair = build_scenario(kind, Tc, pet, first, ground, camera_id, rng)
        actors += pair
    nid = 1
    for a in actors:
        a.track_id = nid; nid += 1
    # truth for scenarios
    scen = [x for x in actors if x.tag != "parked"]
    for k, (kind, Tc, pet, first) in enumerate(SCENARIOS[camera_id]):
        a, b = scen[2 * k], scen[2 * k + 1]
        m = analyze_pair(truth_track(a, ground, camera_id), truth_track(b, ground, camera_id), {"pet": 99, "ttc": 99})
        gt.append({"gt_id": f"GT_{camera_id.removeprefix('CAM_')}_{k + 1:02d}", "camera_id": camera_id,
                   "t": m["t_conflict"], "a_cls": a.cls, "b_cls": b.cls, "conflict_type": GT_TYPE[kind],
                   "true_pet_s": m["pet_s"], "is_conflict": kind not in DECOYS, "crash": kind == "crash",
                   "scenario": kind, "note": DECOY_NOTE.get(kind, ""),
                   "a_track_id": a.track_id, "b_track_id": b.track_id})

    truths = {a.track_id: truth_track(a, ground, camera_id) for a in actors}
    movers = [a for a in actors if a.parked_until is None]
    # background traffic with rejection: no extra close calls, no overlapping bodies
    t = 0.0
    while t < DURATION_S - 2:
        t += rng.exponential(1.3)
        cand = _random_actor(site_kind, t - rng.uniform(0, 4), rng)
        if cand.t_start < -8:
            continue
        cand.track_id = nid
        tc = truth_track(cand, ground, camera_id)
        if tc is None:
            continue
        ok = True
        for o in movers:
            if o.t_end < cand.t_start or o.t_start > cand.t_end:
                continue
            if _min_dist(cand, o) < 4.0:
                ok = False; break
            to = truths.get(o.track_id)
            if to is None:
                continue
            m = analyze_pair(tc, to, {"pet": 3.6, "ttc": 2.4})
            if m and m["candidate"]:
                ok = False; break
        if ok:
            actors.append(cand); movers.append(cand); truths[nid] = tc; nid += 1
    return actors, gt

