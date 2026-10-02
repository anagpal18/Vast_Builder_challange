"""Clip cutting (ffmpeg) and image-space overlays for the event theater (SHRESTH 1.4 steps 8-9)."""
import logging
import shutil
import subprocess

from backend.config import CLIPS_DIR, FOOTAGE_DIR, THUMBS_DIR

log = logging.getLogger("almost.clips")
FFMPEG = shutil.which("ffmpeg")


def clip_paths(event_id):
    return CLIPS_DIR / f"{event_id}.mp4", THUMBS_DIR / f"{event_id}.jpg"


def cut_clip(event):
    """Cut data/clips/<id>.mp4 + thumb. Returns the clip path, or None when footage/ffmpeg is missing."""
    clip, thumb = clip_paths(event["event_id"])
    if clip.exists() and thumb.exists():
        return clip
    src = FOOTAGE_DIR / f"{event['camera_id']}.mp4"
    if not FFMPEG or not src.exists():
        log.warning("no footage for %s, clip skipped", event["camera_id"])
        return None
    t0, t1 = event["clip"]["t0"], event["clip"]["t1"]
    try:
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-ss", f"{t0:.4f}",
                        "-t", f"{t1 - t0:.4f}", "-c:v", "libx264", "-bf", "0", "-preset", "veryfast", "-crf", "26",
                        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(clip)],
                       check=True, timeout=60)
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{event['t_conflict']:.2f}", "-i", str(src),
                        "-frames:v", "1", "-q:v", "4", str(thumb)], check=True, timeout=30)
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("clip cut failed for %s: %s", event["event_id"], e)
        return None
    return clip


def overlay(event, store):
    """Image-space boxes of A and B over the clip window: {a: [[t,u,v,x1,y1,x2,y2]], b: [...]}."""
    df = store.frames(event["camera_id"])
    if df.empty:
        return {"a": [], "b": []}
    t0, t1 = event["clip"]["t0"], event["clip"]["t1"]
    w = df[(df.t >= t0) & (df.t <= t1)]
    out = {}
    for k in ("a", "b"):
        f = w[w.track_id == event[k]["track_id"]]
        out[k] = [[round(r.t, 3), round(r.u, 1), round(r.v, 1), round(r.x1, 1), round(r.y1, 1),
                   round(r.x2, 1), round(r.y2, 1)] for r in f.itertuples()]
    return out
