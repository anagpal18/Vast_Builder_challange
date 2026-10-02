"""Deep test of the real-data path without the VM: a fake VSS serves a simulated camera exactly the way the
team's VSS does (30 s chunks → 5 s segment mp4s + per-frame YOLO sidecars, no track ids), then
ingest_vss → tracker → autocal → calibrate → conflicts must recover the ground-truth close calls."""
import json
import shutil
import subprocess

import pandas as pd
import pytest

from backend.config import CONFIG_DIR, FOOTAGE_DIR, GT_DIR, TRACKS_DIR
from backend.ffmpeg import FFMPEG

SIM = "CAM_A1"
VSS_CAM = "simtest_cam-1"


class FakeVSS:
    def __init__(self, workdir):
        self.dir = workdir
        cams = json.loads((CONFIG_DIR / "cameras.json").read_text())
        cam = next(c for c in cams if c["camera_id"] == SIM)
        self.w, self.h, self.fps = cam["width"], cam["height"], cam["fps"]
        self.raw = pd.read_parquet(TRACKS_DIR / f"{SIM}.raw.parquet")
        self.dur = float(self.raw.t.max())
        self.chunks = [f"s3://fake/team/20261001_000000_sim_chunk_{i:04d}.mp4" for i in range(int(self.dur // 30) + 1)]

    def search(self, query, **kw):
        assert kw["metadata_filters"] == {"camera_id": VSS_CAM}
        return {"results": [{"original_video": c, "location": "simtown"} for c in self.chunks[::-1]]}

    def segments(self, ov):
        i = self.chunks.index(ov)
        segs = []
        for k in range(6):
            t0 = i * 30 + k * 5
            if t0 >= self.dur:
                break
            segs.append({"source": f"s3://fake/segments/sim_chunk_{i:04d}_segment_{k + 1:03d}.mp4",
                         "segment_number": k + 1, "segment_start_sec": k * 5.0, "segment_end_sec": k * 5.0 + 5,
                         "location": "simtown", "camera_id": VSS_CAM, "_t0": t0})
        return {"segments": segs[::-1]}  # unordered on purpose

    def _t0(self, source):
        i = int(source.split("chunk_")[1][:4]); k = int(source.split("segment_")[1][:3]) - 1
        return i * 30 + k * 5

    def download(self, source, dest):
        t0 = self._t0(source)
        dest.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(FOOTAGE_DIR / f"{SIM}.mp4"), "-ss", str(t0),
                        "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-an", str(dest)], check=True)
        return dest

    def detections(self, source):
        t0 = self._t0(source)
        d = self.raw[(self.raw.t >= t0) & (self.raw.t < t0 + 5 - 1e-6)]
        frames = []
        for f, g in d.groupby("frame"):
            frames.append({"frame_index": int(f), "time_sec": float(g.t.iloc[0] - t0),
                           "detections": [{"label": r.cls, "confidence": float(r.conf),
                                           "bbox": [r.x1, r.y1, r.x2, r.y2]} for r in g.itertuples()]})
        return {"source": "yolo11_coco", "video_shape": [self.h, self.w], "fps": float(self.fps), "frames": frames}


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    if not (TRACKS_DIR / f"{SIM}.raw.parquet").exists() or not FFMPEG:
        pytest.skip("needs the simulated dataset (make data) and ffmpeg")
    saved = {p: p.read_text() for p in (CONFIG_DIR / "cameras.json", CONFIG_DIR / "sites.json")}
    from backend.perception import ingest_vss
    monkeypatch.setattr(ingest_vss, "SEG_DIR", tmp_path / "segs")
    monkeypatch.setattr(ingest_vss, "STATUS", tmp_path / "ingest_status.json")
    yield ingest_vss
    for p, s in saved.items():
        p.write_text(s)
    for f in (TRACKS_DIR / "CAM_SIMTESTCAM1.parquet", TRACKS_DIR / "CAM_SIMTESTCAM1.raw.parquet",
              FOOTAGE_DIR / "CAM_SIMTESTCAM1.mp4"):
        f.unlink(missing_ok=True)
    from backend.perception.camera import get_camera
    get_camera.cache_clear()


def test_ingest_vss_recovers_ground_truth(isolated_config, tmp_path):
    ingest_vss = isolated_config
    fake = FakeVSS(tmp_path)
    cid = ingest_vss.ingest_camera(VSS_CAM, n_chunks=10, out_width=640, out_fps=15, vss=fake)
    assert cid == "CAM_SIMTESTCAM1"
    cam = next(c for c in json.loads((CONFIG_DIR / "cameras.json").read_text()) if c["camera_id"] == cid)
    assert cam["calibrated"] is False and cam["width"] == 640 and cam["vss"]["camera_id"] == VSS_CAM
    assert (FOOTAGE_DIR / f"{cid}.mp4").stat().st_size > 10_000
    site = next(s for s in json.loads((CONFIG_DIR / "sites.json").read_text()) if cid in s["camera_ids"])

    from backend.perception.conflicts import measure_camera
    from backend.perception.summarize import TrackStore
    events, n = measure_camera(cid, TrackStore())
    gt = [g for g in json.loads((GT_DIR / "events.json").read_text()) if g["camera_id"] == SIM]
    hits = [g for g in gt if any(abs(e["t_conflict"] - g["t"]) <= 1.5 for e in events)]
    assert len(hits) == len(gt), f"missed {[g['gt_id'] for g in gt if g not in hits]}"
    errs = [min(abs(e["pet_s"] - g["true_pet_s"]) for e in events if abs(e["t_conflict"] - g["t"]) <= 1.5)
            for g in gt]
    assert max(errs) < 1.0, errs
    peds = [e for e in events if e["b"]["cls"] == "person"]
    assert peds and all(e["conflict_type"] in ("ped_vs_right_turn", "ped_vs_left_turn", "ped_vs_through")
                        for e in peds if e["a"]["movement"] in ("right_turn", "left_turn", "through"))
    print(site["site_id"], len(events), "events, PET errors", errs)
