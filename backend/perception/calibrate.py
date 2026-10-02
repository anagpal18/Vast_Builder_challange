"""Image foot points → ground meters, smoothing, speed + heading (SHRESTH 1.2)."""
import sys

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter

from backend.config import DIMS_M, RESAMPLE_HZ, SAVGOL_ORDER, SAVGOL_WINDOW, TRACKS_DIR
from backend.perception.camera import apply_h, get_camera
from backend.perception.track import raw_path


def tracks_path(camera_id):
    return TRACKS_DIR / f"{camera_id}.parquet"


def _smooth(x):
    if len(x) < SAVGOL_WINDOW:
        return x
    return savgol_filter(x, SAVGOL_WINDOW, SAVGOL_ORDER)


def _kinematics(gx, gy, t):
    if len(t) > 1:
        return np.gradient(gx, t), np.gradient(gy, t)
    return np.zeros(len(t)), np.zeros(len(t))


def _footprint_offset(cls, gx, gy, vx, vy, cam_xy):
    """The box bottom-center lands on the footprint edge nearest the camera, not the center.
    Push it away from the camera by the footprint's half-extent along the line of sight."""
    L, W = DIMS_M.get(cls, (0.5, 0.5))
    if cls == "person":
        return gx, gy
    rx, ry = gx - cam_xy[0], gy - cam_xy[1]
    rn = np.hypot(rx, ry) + 1e-9
    rx, ry = rx / rn, ry / rn
    sp = np.hypot(vx, vy)
    hx, hy = np.where(sp > 0.5, vx / (sp + 1e-9), rx), np.where(sp > 0.5, vy / (sp + 1e-9), ry)
    cos_t = np.abs(rx * hx + ry * hy)
    sin_t = np.sqrt(np.clip(1 - cos_t ** 2, 0, 1))
    d = L / 2 * cos_t + W / 2 * sin_t
    return gx + d * rx, gy + d * ry


def camera_ground_xy(cam):
    """Camera nadir on the ground: from simulator params / calibration tool, else approximated."""
    if cam.get("camera_ground_xy"):
        return cam["camera_ground_xy"]
    if cam.get("sim", {}).get("position"):
        return cam["sim"]["position"][:2]
    w, h = cam.get("width", 1920), cam.get("height", 1080)
    near, mid = apply_h(cam["homography"], [[w / 2, h], [w / 2, h / 2]])
    return (near - (mid - near) * 0.5).tolist()


def to_ground(raw, H, cam_xy=None):
    """raw: image-space track rows (MASTER 4.1 minus ground cols) → adds gx, gy, speed_mps, heading_deg."""
    df = raw.sort_values(["track_id", "frame"]).reset_index(drop=True)
    g = apply_h(H, df[["u", "v"]].to_numpy())
    df["gx"], df["gy"] = g[:, 0], g[:, 1]
    out = []
    for _, d in df.groupby("track_id", sort=False):
        d = d.copy()
        t = d["t"].to_numpy()
        gx, gy = _smooth(d["gx"].to_numpy()), _smooth(d["gy"].to_numpy())
        if cam_xy is not None:
            vx, vy = _kinematics(gx, gy, t)
            gx, gy = _footprint_offset(d["cls"].iloc[0], gx, gy, vx, vy, cam_xy)
            gx, gy = _smooth(gx), _smooth(gy)
        vx, vy = _kinematics(gx, gy, t)
        d["gx"], d["gy"] = gx, gy
        d["speed_mps"] = np.hypot(vx, vy)
        d["heading_deg"] = np.degrees(np.arctan2(vy, vx)) % 360
        out.append(d)
    return pd.concat(out, ignore_index=True) if out else df.assign(speed_mps=[], heading_deg=[])


def calibrate_camera(camera_id):
    cam = get_camera(camera_id)
    raw = pd.read_parquet(raw_path(camera_id))
    df = to_ground(raw, cam["homography"], camera_ground_xy(cam))
    df.to_parquet(tracks_path(camera_id), index=False)
    return df


def resample(d, hz=RESAMPLE_HZ):
    """One track's rows → arrays at `hz`: t, gx, gy, vx, vy (velocity from the smoothed path)."""
    t = d["t"].to_numpy()
    tt = np.round(np.arange(np.ceil(t[0] * hz), np.floor(t[-1] * hz) + 1) / hz, 3)
    if len(tt) < 2:
        tt = np.array([t[0], t[-1]])
    gx = np.interp(tt, t, d["gx"].to_numpy())
    gy = np.interp(tt, t, d["gy"].to_numpy())
    vx = np.gradient(gx, tt) if len(tt) > 1 else np.zeros_like(tt)
    vy = np.gradient(gy, tt) if len(tt) > 1 else np.zeros_like(tt)
    return tt, gx, gy, vx, vy


if __name__ == "__main__":
    for cid in sys.argv[1:]:
        print(cid, len(calibrate_camera(cid)), "rows")
