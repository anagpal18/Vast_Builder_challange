"""Real footage from the team's VSS archive → the same tracks the pipeline measures.

    python -m backend.perception.ingest_vss --cameras sf_streets_cam-1,sf_streets_cam-4 --chunks 4

Per VSS camera: find its chunks (search filtered by camera_id), take the longest run of consecutive chunks,
download every 5 s segment + its per-frame YOLO11 detections (VSS sidecar), stitch one web-sized video,
link detections into tracks (tracker.py), auto-calibrate the ground plane (autocal.py), register the camera
and site in data/config, then calibrate.py turns the raw tracks into ground tracks.
"""
import argparse
import json
import logging
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from backend.config import CACHE_DIR, CONFIG_DIR, FOOTAGE_DIR, MIN_TRACK_S
from backend.ffmpeg import FFMPEG
from backend.perception import autocal
from backend.perception.calibrate import calibrate_camera
from backend.perception.camera import get_camera
from backend.perception.track import RAW_COLS, drop_short_tracks, raw_path
from backend.perception.tracker import track
from backend.vss.client import client, pick, rows

log = logging.getLogger("almost.ingest")
STATUS = CACHE_DIR / "ingest_status.json"
SEG_DIR = CACHE_DIR / "vss_segments"

SHORT = {"sf_streets_cam-1": "SF1", "sf_streets_cam-2": "SF2", "sf_streets_cam-3": "SF3", "sf_streets_cam-4": "SF4",
         "neighborhood_cam-1": "NB1", "i24_cam-1": "I24", "pie_cam-3": "PIE3", "sdg_warehouse_cam-2": "WH2",
         "smartspace_cam-1": "SS1"}
SITES = {  # VSS location → (site_id, name, speed limit mph)
    "san_francisco": ("SITE_SF", "San Francisco streets", 25),
    "neighborhood": ("SITE_NB", "Residential street", 25),
    "nashville": ("SITE_I24", "I-24 Nashville", 65),
    "toronto": ("SITE_PIE", "Toronto drives", 30),
    "warehouse3": ("SITE_WH", "Warehouse 3", 8),
    "indoor": ("SITE_SS", "Indoor smart space", 5),
}


def pretty_label(vss_cam):
    m = re.match(r"sf_streets_cam-(\d+)", vss_cam)
    if m:
        return f"SF street cam {m.group(1)}"
    return {"neighborhood_cam-1": "Residential street cam", "i24_cam-1": "I-24 overhead cam",
            "sdg_warehouse_cam-2": "Warehouse aisle cam", "smartspace_cam-1": "Indoor smart-space cam",
            "pie_cam-3": "Toronto dashcam"}.get(vss_cam, vss_cam.replace("_", " "))
DEFAULT_CAMERAS = ["sf_streets_cam-1", "sf_streets_cam-2", "sf_streets_cam-3", "sf_streets_cam-4", "neighborhood_cam-1"]


def our_id(vss_cam):
    return "CAM_" + SHORT.get(vss_cam, re.sub(r"[^A-Za-z0-9]+", "", vss_cam).upper()[-16:])


def _status(cam, **kw):
    st = json.loads(STATUS.read_text()) if STATUS.exists() else {}
    cur = st.setdefault(cam, {})
    if kw.get("state") and kw["state"] != "error":
        cur.pop("error", None)
    cur.update(kw, updated=time.strftime("%H:%M:%S"))
    STATUS.write_text(json.dumps(st, indent=1))


def _chunk_index(name):
    m = re.search(r"chunk_(\d+)", name or "")
    return int(m.group(1)) if m else None


def find_chunks(vss, vss_cam, queries=("vehicles and people on the street", "traffic", "a person walking")):
    """Parent videos (chunks) recorded by this camera, with their location."""
    found = {}
    for q in queries:
        r = vss.search(q, top_k=100, min_similarity=0.0, llm_top_n=1, metadata_filters={"camera_id": vss_cam})
        for hit in rows(r, "results") + rows(r, "chunk_results"):
            ov = pick(hit, "original_video")
            if ov and ov not in found:
                found[ov] = {"original_video": ov, "location": pick(hit, "location"),
                             "chunk_duration_sec": pick(hit, "chunk_duration_sec", default=30.0)}
    return sorted(found.values(), key=lambda c: (_chunk_index(c["original_video"]) is None,
                                                 _chunk_index(c["original_video"]) or 0, c["original_video"]))


def longest_run(chunks, n):
    """Longest run of consecutive chunk numbers (same recording prefix), capped at n."""
    best, cur = [], []
    for c in chunks:  # already filtered to one camera; filenames carry a per-chunk timestamp, so use the index
        i = _chunk_index(c["original_video"])
        if cur and i is not None and _chunk_index(cur[-1]["original_video"]) == i - 1:
            cur.append(c)
        else:
            cur = [c]
        if len(cur) > len(best):
            best = list(cur)
    return (best or chunks)[:n]


def _segment_rows(vss, ov):
    segs = rows(vss.segments(ov), "segments")
    return sorted(segs, key=lambda s: pick(s, "segment_number", default=0))


def ingest_camera(vss_cam, n_chunks=4, out_width=960, out_fps=15, vss=None):
    vss = vss or client()
    cid = our_id(vss_cam)
    _status(cid, state="finding chunks", vss_camera_id=vss_cam)
    chunks = longest_run(find_chunks(vss, vss_cam), n_chunks)
    if not chunks:
        _status(cid, state="error", error="no chunks found for camera")
        raise RuntimeError(f"no chunks for {vss_cam}")
    plan, t_off = [], 0.0
    for ch in chunks:
        segs = _segment_rows(vss, ch["original_video"])
        for s in segs:
            plan.append({"source": s["source"], "t0": t_off + float(pick(s, "segment_start_sec", default=0.0)),
                         "location": pick(s, "location") or ch.get("location")})
        t_off += float(ch.get("chunk_duration_sec") or (len(segs) * 5.0))
    location = next((p["location"] for p in plan if p["location"]), "unknown")
    _status(cid, state="downloading", segments=len(plan), chunks=[c["original_video"] for c in chunks])

    def fetch(p):
        local = SEG_DIR / vss_cam / Path(p["source"]).name
        det_cache = local.with_suffix(".det.json")
        try:
            vss.download(p["source"], local)
            if det_cache.exists():
                det = json.loads(det_cache.read_text())
            else:
                det = vss.detections(p["source"])
                if det:
                    det_cache.write_text(json.dumps(det))
            return p, local, det
        except Exception as e:  # one bad segment must not sink the camera
            log.warning("%s: segment %s skipped: %s", vss_cam, Path(p["source"]).name, e)
            return None
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(fetch, plan))
    # keep the continuous prefix: a hole would shift the stitched video against the track times
    got = []
    for g in results:
        if g is None:
            break
        got.append(g)
    if len(got) < max(1, len(plan) // 2):
        _status(cid, state="error", error=f"only {len(got)}/{len(plan)} segments fetched")
        raise RuntimeError(f"{vss_cam}: only {len(got)}/{len(plan)} segments")
    _status(cid, state="downloaded", fetched=len(got))

    # frames for the tracker, in global camera time; boxes rescaled to the web video size
    src_w = src_h = None
    frames = []
    for p, _, det in got:
        if not det:
            continue
        shape = det.get("video_shape") or [1080, 1920]
        src_h, src_w = shape[0], shape[1]
        sc = out_width / src_w
        for fr in det.get("frames", []):
            t = p["t0"] + float(fr.get("time_sec", 0.0))
            frames.append((t, [(d["label"], float(d["confidence"]), [x * sc for x in d["bbox"][:4]])
                               for d in fr.get("detections", [])]))
    frames.sort(key=lambda f: f[0])
    if not frames:
        _status(cid, state="error", error="no detection sidecars")
        raise RuntimeError(f"{vss_cam}: no detections")
    out_w, out_h = out_width, int(round(src_h * out_width / src_w / 2) * 2)

    # one continuous web video
    _status(cid, state="stitching video")
    FOOTAGE_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as lst:
        for _, local, _ in got:
            lst.write(f"file '{local.resolve()}'\n")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst.name,
                    "-vf", f"scale={out_w}:{out_h},fps={out_fps}", "-c:v", "libx264", "-bf", "0", "-preset", "veryfast",
                    "-crf", "27", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
                    str(FOOTAGE_DIR / f"{cid}.mp4")], check=True, timeout=900)

    _status(cid, state="tracking", frames=len(frames))
    tracked = track((i, t, dets) for i, (t, dets) in enumerate(frames))
    df = pd.DataFrame(tracked, columns=["track_id", "cls", "frame", "t", "x1", "y1", "x2", "y2", "conf"])
    df["frame"] = (df["t"] * out_fps).round().astype(int)
    H, info = autocal.fit(df[["cls", "x1", "y1", "x2", "y2"]].itertuples(index=False), out_w, out_h)
    df["u"], df["v"] = (df.x1 + df.x2) / 2, df.y2
    df = df[autocal.valid_rows(df.v, info)]
    df.insert(0, "camera_id", cid)
    df = drop_short_tracks(df[RAW_COLS], MIN_TRACK_S)

    site_id, site_name, limit = SITES.get(location, ("SITE_" + re.sub(r"\W", "", location).upper()[:8],
                                                     f"{location} (VSS)", 25))
    register(cid, vss_cam, site_id, site_name, limit, location, H, info, out_w, out_h, out_fps,
             [c["original_video"] for c in chunks])
    df.to_parquet(raw_path(cid), index=False)
    calibrate_camera(cid)
    _status(cid, state="ready", tracks=int(df.track_id.nunique()), minutes=round(frames[-1][0] / 60, 2),
            autocal=info)
    log.info("%s (%s): %d tracks over %.1f min", cid, vss_cam, df.track_id.nunique(), frames[-1][0] / 60)
    return cid


def register(cid, vss_cam, site_id, site_name, limit, location, H, info, w, h, fps, chunks):
    cams_p, sites_p = CONFIG_DIR / "cameras.json", CONFIG_DIR / "sites.json"
    cams = json.loads(cams_p.read_text()) if cams_p.exists() else []
    sites = json.loads(sites_p.read_text()) if sites_p.exists() else []
    old = next((c for c in cams if c["camera_id"] == cid), {})
    keep_cal = old.get("calibrated")  # a human calibration (PUT /cameras/.../calibration) wins over autocal
    cam = {"camera_id": cid, "site_id": site_id, "label": pretty_label(vss_cam),
           "video_url": f"/media/footage/{cid}.mp4", "fps": fps, "width": w, "height": h,
           "homography": old["homography"] if keep_cal else H,
           "ground": old.get("ground") if keep_cal else {"legs": {}, "crosswalks": [], "box": []},
           "camera_ground_xy": old.get("camera_ground_xy", [0.0, 0.0]) if keep_cal else [0.0, 0.0],
           "lighting": old.get("lighting", "day"), "calibrated": bool(keep_cal), "autocal": info,
           "vss": {"camera_id": vss_cam, "location": location, "chunks": chunks}}
    cams = [c for c in cams if c["camera_id"] != cid] + [cam]
    site = next((s for s in sites if s["site_id"] == site_id), None)
    if site is None:
        sites.append({"site_id": site_id, "name": site_name, "camera_ids": [cid], "speed_limit_mph": limit,
                      "signalized": True, "source": "vss"})
    else:
        site["name"] = site_name
        if cid not in site["camera_ids"]:
            site["camera_ids"].append(cid)
    cams_p.write_text(json.dumps(cams, indent=2))
    sites_p.write_text(json.dumps(sites, indent=2))
    get_camera.cache_clear()


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", default=",".join(DEFAULT_CAMERAS))
    ap.add_argument("--chunks", type=int, default=4, help="30 s chunks per camera")
    args = ap.parse_args(argv)
    ok = []
    for cam in [c for c in args.cameras.split(",") if c]:
        try:
            ok.append(ingest_camera(cam, args.chunks))
        except Exception as e:
            log.exception("ingest %s failed: %s", cam, e)
            _status(our_id(cam), state="error", error=str(e)[:300])
    log.info("ingested: %s", ok)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
