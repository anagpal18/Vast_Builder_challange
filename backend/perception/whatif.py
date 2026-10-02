"""WHAT-IF curves: slide the vehicle in time along its observed path, measure the gap (SHRESTH 1.5, MASTER 4.4)."""
import numpy as np

from backend import config as C
from backend.perception.camera import get_camera, h_inv


def _shape_circles(cls):
    """Approximate a road user as circles along its length: (offsets along heading, radius)."""
    if cls == "person":
        return np.array([0.0]), C.RADIUS_M["person"]
    L, W = C.DIMS_M.get(cls, (1.0, 1.0))
    n = max(1, int(round(L / W)))
    r = W / 2
    offs = np.linspace(-(L / 2 - r), L / 2 - r, n) if n > 1 else np.array([0.0])
    return offs, r


def _rect_distance(px, py, cx, cy, hd, L, W):
    """Signed distance from points to an oriented rectangle (negative inside). Arrays broadcast."""
    c, s = np.cos(hd), np.sin(hd)
    dx, dy = px - cx, py - cy
    lx = np.abs(dx * c + dy * s) - L / 2
    ly = np.abs(-dx * s + dy * c) - W / 2
    out = np.hypot(np.maximum(lx, 0), np.maximum(ly, 0))
    inside = np.minimum(np.maximum(lx, ly), 0)
    return out + inside


def _headings(vx, vy):
    hd = np.arctan2(vy, vx)
    moving = np.hypot(vx, vy) > 0.3
    if moving.any():  # hold last good heading when nearly stopped
        idx = np.where(moving, np.arange(len(hd)), 0)
        np.maximum.accumulate(idx, out=idx)
        first = int(np.argmax(moving))
        idx[:first] = first
        hd = hd[idx]
    return np.unwrap(hd)


def compute_whatif(event, store):
    cam = get_camera(event["camera_id"])
    trs = store.tracks(event["camera_id"])
    A, B = trs[event["a"]["track_id"]], trs[event["b"]["track_id"]]
    t0, t1 = event["clip"]["t0"], event["clip"]["t1"]
    step = C.WHATIF_STEP_S
    tt = np.round(np.arange(t0, t1 + 1e-9, step), 3)
    shifts = np.round(np.arange(-C.WHATIF_RANGE_S, C.WHATIF_RANGE_S + 1e-9, step), 3) + 0.0

    a_hd_full = _headings(A.vx, A.vy)
    L, W = C.DIMS_M.get(A.cls, (4.5, 1.8))
    offs, rb = _shape_circles(B.cls)
    b_hd_full = _headings(B.vx, B.vy)

    # B along the window (fixed)
    b_ok = (tt >= B.t[0]) & (tt <= B.t[-1])
    bx, by = np.interp(tt, B.t, B.gx), np.interp(tt, B.t, B.gy)
    bh = np.interp(tt, B.t, b_hd_full)
    cx = bx[None, :, None] + offs[None, None, :] * np.cos(bh)[None, :, None]  # (1, T, K)
    cy = by[None, :, None] + offs[None, None, :] * np.sin(bh)[None, :, None]

    # A shifted: A'(t) = A(t - s)  → grid (S, T)
    ts = tt[None, :] - shifts[:, None]
    a_ok = (ts >= A.t[0]) & (ts <= A.t[-1])
    ax, ay = np.interp(ts, A.t, A.gx), np.interp(ts, A.t, A.gy)
    ah = np.interp(ts, A.t, a_hd_full)
    d = _rect_distance(cx, cy, ax[..., None], ay[..., None], ah[..., None], L, W).min(axis=2) - rb
    valid = a_ok & b_ok[None, :]
    d = np.where(valid, d, np.inf)
    gap = d.min(axis=1)

    curve = [[float(s), round(float(g), 2) if np.isfinite(g) else None] for s, g in zip(shifts, gap)]
    contact = np.isfinite(gap) & (gap <= 0)
    ranges, start = [], None
    for s, c in zip(shifts, contact):
        if c and start is None:
            start = s
        if not c and start is not None:
            ranges.append([float(start), float(prev)]); start = None
        prev = s
    if start is not None:
        ranges.append([float(start), float(shifts[-1])])

    i0 = int(np.argmin(np.abs(shifts)))
    impact, first_contact = None, None
    if contact.any():
        ci = np.where(contact)[0]
        k = int(ci[np.argmin(np.abs(shifts[ci]))])
        first_contact = float(shifts[k]) + 0.0  # normalise -0.0
        # impact = just past first contact (0.15 s deeper, staying inside the contact range), so the slider's
        # snap point and the crash banner agree (frontend TEAM_NOTES 3)
        deeper = k + int(round(0.15 / step)) * (1 if shifts[k] >= 0 else -1)
        if 0 <= deeper < len(shifts) and contact[deeper]:
            k = deeper
        j = int(np.argmax(d[k] <= 0))
        sp = float(np.hypot(np.interp(ts[k, j], A.t, A.vx), np.interp(ts[k, j], A.t, A.vy)))
        impact = {"shift_s": float(shifts[k]) + 0.0, "t": float(tt[j]),
                  "point": [round(float(bx[j]), 2), round(float(by[j]), 2)], "speed_mps": round(sp, 2)}

    pad = C.WHATIF_RANGE_S
    ma = (A.t >= t0 - pad) & (A.t <= t1 + pad)
    mb = (B.t >= t0) & (B.t <= t1)
    frames = store.frames(event["camera_id"])

    def img_path(tid, lo, hi):
        f = frames[(frames.track_id == tid) & (frames.t >= lo) & (frames.t <= hi)]
        return [[round(t, 3), round(u, 1), round(v, 1)] for t, u, v in zip(f.t, f.u, f.v)]

    return {
        "event_id": event["event_id"],
        "shift_actor": "a",
        "a": {"cls": A.cls, "dims_m": [L, W],
              "path": [[round(float(t), 2), round(float(x), 2), round(float(y), 2), round(float(np.degrees(h)) % 360, 1)]
                       for t, x, y, h in zip(A.t[ma], A.gx[ma], A.gy[ma], a_hd_full[ma])]},
        "b": {"cls": B.cls, "radius_m": float(C.RADIUS_M.get(B.cls, rb)),
              "dims_m": list(C.DIMS_M.get(B.cls, (1.0, 1.0))),
              "path": [[round(float(t), 2), round(float(x), 2), round(float(y), 2), round(float(np.degrees(h)) % 360, 1)]
                       for t, x, y, h in zip(B.t[mb], B.gx[mb], B.gy[mb], b_hd_full[mb])]},
        "image_paths": {"a": img_path(A.track_id, t0 - pad, t1 + pad), "b": img_path(B.track_id, t0, t1)},
        "homography_inv": h_inv(cam["homography"]),
        "observed": {"pet_s": event["pet_s"],
                     "min_gap_m": round(float(gap[i0]), 2) if np.isfinite(gap[i0]) else None},
        "gap_curve": curve,
        "contact_ranges": ranges,
        "first_contact_shift_s": first_contact,
        "impact": impact,
        "disclaimer": C.WHATIF_DISCLAIMER,
    }
