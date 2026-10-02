"""Generate the simulated dataset: configs, footage, raw detections, ground-plane tracks, ground truth.

    python -m backend.synth.make_all [--no-video] [--cameras CAM_A1,CAM_B1]

Camera homographies come from the simulator's pinhole parameters (SHRESTH 1.2: more accurate than clicking).
"""
import argparse
import json
from concurrent.futures import ProcessPoolExecutor

import pandas as pd

from backend.config import CONFIG_DIR, FOOTAGE_DIR, GT_DIR
from backend.perception.camera import homography_from_pinhole
from backend.synth.scenes import DURATION_S, build_camera
from backend.synth.world import intersection_ground, midblock_ground

W, H, FPS, F = 1280, 720, 15, 900.0

SITES = [
    {"site_id": "SITE_A", "name": "5th & Market (simulated)", "camera_ids": ["CAM_A1", "CAM_A2"],
     "speed_limit_mph": 25, "signalized": True, "kind": "intersection"},
    {"site_id": "SITE_B", "name": "Oak Ave & 12th St (simulated)", "camera_ids": ["CAM_B1"],
     "speed_limit_mph": 35, "signalized": True, "kind": "intersection"},
    {"site_id": "SITE_C", "name": "Bayshore Blvd & Pine St (simulated)", "camera_ids": ["CAM_C1"],
     "speed_limit_mph": 30, "signalized": True, "kind": "intersection", "bike_lanes": True},
    {"site_id": "SITE_D", "name": "Alameda midblock crossing (simulated)", "camera_ids": ["CAM_D1"],
     "speed_limit_mph": 25, "signalized": False, "kind": "midblock"},
]
CAMS = [
    # camera_id, site, label, position (m), look-at, lighting
    ("CAM_A1", "SITE_A", "NE corner looking SW", (26, 24, 12), (-1, -3, 0), "day"),
    ("CAM_A2", "SITE_A", "SW corner looking NE", (-26, -25, 12), (3, 1, 0), "day"),
    ("CAM_B1", "SITE_B", "SE corner looking NW", (26, -26, 12), (-2, 2, 0), "day"),
    ("CAM_C1", "SITE_C", "NW corner looking SE", (-24, 26, 12), (3, -3, 0), "day"),
    ("CAM_D1", "SITE_D", "South sidewalk pole looking NE", (-16, -20, 9), (6, 1, 0), "night"),
]


def camera_configs():
    out = []
    for cid, sid, label, pos, look, lighting in CAMS:
        site = next(s for s in SITES if s["site_id"] == sid)
        I2G, G2I, P = homography_from_pinhole(pos, look, F, F, W / 2, H / 2)
        ground = intersection_ground() if site["kind"] == "intersection" else midblock_ground()
        out.append({"camera_id": cid, "site_id": sid, "label": label, "video_url": f"/media/footage/{cid}.mp4",
                    "fps": FPS, "width": W, "height": H, "homography": I2G, "ground": ground,
                    "lighting": lighting, "sim": {"position": pos, "look_at": list(look), "f": F, "P": P.tolist(),
                                                  "ground_to_image": G2I}})
    return out


def build_one(args):
    cam, site, seed, video = args
    from backend.synth.render import Camera, render_camera
    actors, gt = build_camera(cam["camera_id"], site["kind"], cam["ground"], seed)
    rc = Camera(cam["sim"]["P"], cam["sim"]["ground_to_image"], cam["homography"], W, H)
    out = FOOTAGE_DIR / f"{cam['camera_id']}.mp4"
    rows = render_camera(rc, actors, DURATION_S, FPS, out, site["kind"], night=cam["lighting"] == "night",
                         bike_lanes=site.get("bike_lanes", False), label=cam["camera_id"], seed=seed)
    if not video:
        out.unlink(missing_ok=True)
    return cam["camera_id"], rows, gt, len(actors)


def _clear_caches(camera_ids):
    """Event ids are recycled across regenerations; drop anything derived from the old footage."""
    from backend.config import CACHE_DIR, CLIPS_DIR, THUMBS_DIR
    prefixes = tuple(f"EV_{c.removeprefix('CAM_')}_" for c in camera_ids)
    for d in [CLIPS_DIR, THUMBS_DIR, *(CACHE_DIR / "verify").glob("*")]:
        for f in d.glob("EV_*"):
            if f.name.startswith(prefixes):
                f.unlink()
    for f in ("state.json", "mock_events.json"):
        (CACHE_DIR / f).unlink(missing_ok=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--cameras", default="")
    args = ap.parse_args(argv)

    cams = camera_configs()
    # merge: replace simulated sites/cameras, keep real ones added by the calibration tool
    sim_sites = {s["site_id"] for s in SITES}
    sim_cams = {c["camera_id"] for c in cams}
    old_sites = json.loads((CONFIG_DIR / "sites.json").read_text()) if (CONFIG_DIR / "sites.json").exists() else []
    old_cams = json.loads((CONFIG_DIR / "cameras.json").read_text()) if (CONFIG_DIR / "cameras.json").exists() else []
    sites_out = [{k: v for k, v in s.items() if k not in ("kind", "bike_lanes")} for s in SITES]
    sites_out += [s for s in old_sites if s["site_id"] not in sim_sites]
    cams_out = cams + [c for c in old_cams if c["camera_id"] not in sim_cams and "sim" not in c]
    (CONFIG_DIR / "sites.json").write_text(json.dumps(sites_out, indent=2))
    (CONFIG_DIR / "cameras.json").write_text(json.dumps(cams_out, indent=2))
    from backend.perception.camera import get_camera
    get_camera.cache_clear()

    wanted = set(filter(None, args.cameras.split(","))) or {c["camera_id"] for c in cams}
    jobs = [(c, next(s for s in SITES if s["site_id"] == c["site_id"]), 1000 + i, not args.no_video)
            for i, c in enumerate(cams) if c["camera_id"] in wanted]

    _clear_caches(wanted)
    gt_path = GT_DIR / "events.json"
    gt_all = [g for g in (json.loads(gt_path.read_text()) if gt_path.exists() else []) if g["camera_id"] not in wanted]
    from backend.perception.calibrate import calibrate_camera
    from backend.perception.track import RAW_COLS, drop_short_tracks, raw_path
    with ProcessPoolExecutor(max_workers=len(jobs)) as ex:
        for cid, rows, gt, n in ex.map(build_one, jobs):
            df = pd.DataFrame(rows)
            df.insert(0, "camera_id", cid)
            df = drop_short_tracks(df[RAW_COLS])
            df.to_parquet(raw_path(cid), index=False)
            calibrate_camera(cid)
            gt_all += gt
            print(f"{cid}: {n} actors, {df.track_id.nunique()} tracks, {len(df)} detections, {len(gt)} gt events")
    gt_all.sort(key=lambda g: (g["camera_id"], g["t"]))
    gt_path.write_text(json.dumps(gt_all, indent=2))


if __name__ == "__main__":
    main()
