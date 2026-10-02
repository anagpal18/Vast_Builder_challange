"""YOLO + ByteTrack over a camera video → raw image-space tracks (precompute, SHRESTH 1.1).

    python -m backend.perception.track CAM_A1 [CAM_A2 ...]

Writes data/tracks/<camera>.raw.parquet, then calibrate.py turns it into data/tracks/<camera>.parquet.
"""
import os
import sys

import pandas as pd

from backend.config import FOOTAGE_DIR, MIN_TRACK_S, TRACKS_DIR, YOLO_CLASSES, YOLO_MODEL
from backend.perception.camera import get_camera

RAW_COLS = ["camera_id", "track_id", "cls", "frame", "t", "x1", "y1", "x2", "y2", "conf", "u", "v"]


def raw_path(camera_id):
    return TRACKS_DIR / f"{camera_id}.raw.parquet"


def drop_short_tracks(df, min_s=MIN_TRACK_S):
    span = df.groupby("track_id")["t"].agg(lambda s: s.max() - s.min())
    keep = span[span >= min_s].index
    return df[df["track_id"].isin(keep)].reset_index(drop=True)


def run_yolo(camera_id, video=None, device=None):
    from ultralytics import YOLO  # heavy import, only when actually tracking

    cam = get_camera(camera_id)
    video = video or FOOTAGE_DIR / f"{camera_id}.mp4"
    fps = cam.get("fps", 30)
    model = YOLO(YOLO_MODEL)
    rows = []
    for frame, r in enumerate(model.track(source=str(video), tracker="bytetrack.yaml", persist=True,
                                          stream=True, classes=list(YOLO_CLASSES), conf=0.3, iou=0.5,
                                          device=device, verbose=False)):
        b = r.boxes
        if b is None or b.id is None:
            continue
        for tid, c, (x1, y1, x2, y2), conf in zip(b.id.int().tolist(), b.cls.int().tolist(),
                                                  b.xyxy.tolist(), b.conf.tolist()):
            rows.append((camera_id, tid, YOLO_CLASSES[c], frame, frame / fps,
                         x1, y1, x2, y2, conf, (x1 + x2) / 2, y2))
    df = drop_short_tracks(pd.DataFrame(rows, columns=RAW_COLS))
    df.to_parquet(raw_path(camera_id), index=False)
    return df


if __name__ == "__main__":
    from backend.perception.calibrate import calibrate_camera
    for cid in sys.argv[1:]:
        d = run_yolo(cid, device=os.environ.get("YOLO_DEVICE") or None)
        print(cid, len(d), "rows,", d["track_id"].nunique(), "tracks")
        calibrate_camera(cid)
