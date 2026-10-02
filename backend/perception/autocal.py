"""Approximate ground-plane homography for an uncalibrated fixed camera, from the detections themselves.

Pinhole camera over a flat road, small roll: an object of real height h standing at image row v appears
h_px = (h / H) * (v - v_h) tall, where v_h is the horizon row and H the camera height. A robust line fit of
h_px / h against v gives v_h and H. With focal length f (from an assumed horizontal FOV) the ground is
    X = H (u - cx) / (v - v_h),   Y = f H / (v - v_h)        (meters; X right, Y away from the camera)
which is exactly a homography. Good enough for PET in seconds and speeds; the calibration tool replaces it.
"""
import logging

import numpy as np

log = logging.getLogger("almost.autocal")

NOMINAL_HEIGHT_M = {"person": 1.7, "car": 1.5, "truck": 3.0, "bus": 3.2, "bicycle": 1.7, "motorcycle": 1.5}


def fit(rows, width, height, hfov_deg=60.0):
    """rows: iterable of (cls, x1, y1, x2, y2). Returns (homography image→ground, info dict)."""
    v, s = [], []
    margin = 4
    for cls, x1, y1, x2, y2 in rows:
        if cls not in NOMINAL_HEIGHT_M or y1 <= margin or y2 >= height - margin or x1 <= margin or x2 >= width - margin:
            continue  # truncated boxes lie about height
        v.append(y2)
        s.append((y2 - y1) / NOMINAL_HEIGHT_M[cls])
    v, s = np.asarray(v, float), np.asarray(s, float)
    cx = width / 2
    f = (width / 2) / np.tan(np.radians(hfov_deg / 2))
    info = {"method": "autocal-object-heights", "samples": int(len(v)), "hfov_deg": hfov_deg, "calibrated": False}
    a = b = None
    if len(v) >= 30:
        # robust: fit on per-row-bin medians, then one round of outlier rejection
        bins = np.quantile(v, np.linspace(0, 1, 13))
        bv, bs = [], []
        for lo, hi in zip(bins[:-1], bins[1:]):
            m = (v >= lo) & (v <= hi)
            if m.sum() >= 3:
                bv.append(np.median(v[m])); bs.append(np.median(s[m]))
        if len(bv) >= 4:
            a, b = np.polyfit(bv, bs, 1)
    if a is None or a <= 1e-4:
        # fallback: constant scale from the median object (orthographic-ish), horizon far above the frame
        med = float(np.median(s)) if len(s) else 60.0 / 1.5
        v_h = -4.0 * height
        a = med / (np.median(v) - v_h if len(v) else height - v_h)
        info["fallback"] = True
    else:
        v_h = -b / a
        if v_h > 0.6 * height:  # horizon inside the lower frame is not physical for a traffic cam
            v_h = -2.0 * height
            a = float(np.median(s / (v - v_h)))
            info["fallback"] = True
    cam_h = 1.0 / a
    H = np.array([[cam_h, 0.0, -cam_h * cx], [0.0, 0.0, f * cam_h], [0.0, 1.0, -v_h]])
    H = H / H[2, 1] if abs(H[2, 2]) < 1e-12 else H / H[2, 2]
    info.update({"horizon_row": round(float(v_h), 1), "camera_height_m": round(float(cam_h), 2),
                 "focal_px": round(float(f), 1)})
    log.info("autocal: %s", info)
    return H.tolist(), info


def valid_rows(v_bottom, info, min_px=6):
    """Rows too close to the horizon map to absurd distances; drop them."""
    return np.asarray(v_bottom) > info["horizon_row"] + min_px
