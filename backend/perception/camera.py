"""Camera + site config and homography helpers."""
import json
from functools import lru_cache

import numpy as np

from backend.config import CONFIG_DIR


def _read(name):
    p = CONFIG_DIR / name
    return json.loads(p.read_text()) if p.exists() else []


def load_sites():
    return _read("sites.json")


def load_cameras():
    return _read("cameras.json")


def _is_sim(cam):
    return "sim" in cam


def visible_cameras():
    """Cameras for the UI and default investigations (DATA_MODE). Real ones appear once their footage exists."""
    from backend.config import DATA_MODE, FOOTAGE_DIR
    out = []
    for c in load_cameras():
        if DATA_MODE == "sim" and not _is_sim(c):
            continue
        if DATA_MODE == "real" and _is_sim(c):
            continue
        if not _is_sim(c) and not (FOOTAGE_DIR / f"{c['camera_id']}.mp4").exists():
            continue
        out.append(c)
    return out


def visible_sites():
    cams = {c["camera_id"] for c in visible_cameras()}
    out = []
    for s in load_sites():
        ids = [i for i in s["camera_ids"] if i in cams]
        if ids:
            out.append({**s, "camera_ids": ids})
    return out


def save_cameras(cameras):
    (CONFIG_DIR / "cameras.json").write_text(json.dumps(cameras, indent=2))
    get_camera.cache_clear()


@lru_cache(maxsize=None)
def get_camera(camera_id):
    for c in load_cameras():
        if c["camera_id"] == camera_id:
            return c
    raise KeyError(camera_id)


def get_site(site_id):
    for s in load_sites():
        if s["site_id"] == site_id:
            return s
    raise KeyError(site_id)


def camera_short(camera_id):
    return camera_id.removeprefix("CAM_")


def apply_h(H, pts):
    """Apply a 3x3 homography to an (N, 2) array."""
    pts = np.asarray(pts, dtype=float).reshape(-1, 2)
    hom = np.hstack([pts, np.ones((len(pts), 1))]) @ np.asarray(H, dtype=float).T
    return hom[:, :2] / hom[:, 2:3]


def h_inv(H):
    """Inverse homography, scaled by its largest entry (H[2,2] can be 0, e.g. auto-calibrated cameras)."""
    Hi = np.linalg.inv(np.asarray(H, dtype=float))
    return (Hi / np.abs(Hi).max()).tolist()


def homography_from_points(points):
    """points: [{"u","v","gx","gy"}, ...] (>= 4) from the calibration tool → image→ground H."""
    import cv2
    src = np.array([[p["u"], p["v"]] for p in points], dtype=np.float32)
    dst = np.array([[p["gx"], p["gy"]] for p in points], dtype=np.float32)
    H, _ = cv2.findHomography(src, dst, 0 if len(points) == 4 else cv2.RANSAC)
    if H is None:
        raise ValueError("could not fit homography")
    return (H / H[2, 2]).tolist()


def homography_from_pinhole(cam_pos, look_at, fx, fy, cx, cy):
    """Ground (z=0) → image H for a simulated pinhole camera; returns (image→ground, ground→image)."""
    C = np.asarray(cam_pos, dtype=float)
    f = np.asarray(look_at, dtype=float) - C
    f /= np.linalg.norm(f)
    r = np.cross(f, [0, 0, 1.0]); r /= np.linalg.norm(r)
    d = np.cross(f, r)                       # image "down"
    R = np.vstack([r, d, f])                 # world → camera rows
    t = -R @ C
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]])
    P = K @ np.hstack([R, t[:, None]])
    G2I = P[:, [0, 1, 3]]
    G2I = G2I / G2I[2, 2]
    I2G = np.linalg.inv(G2I)
    I2G = I2G / I2G[2, 2]
    return I2G.tolist(), G2I.tolist(), P
