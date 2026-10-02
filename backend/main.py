"""ALMOST API (MASTER 5).  uvicorn backend.main:app --reload --port 8000"""
import asyncio
import json
import logging
import os
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config as C
from backend.agents import llm
from backend.agents.orchestrator import ReplayRun, Run, has_recording
from backend.agents.recommend import URL_STATUS, check_catalog_urls, load_catalog
from backend.memory_adapter import BACKEND_NAME, memory
from backend.perception.calibrate import calibrate_camera
from backend.perception.camera import (homography_from_points, load_cameras, load_sites, save_cameras,
                                       visible_cameras, visible_sites)
from backend.perception.clips import overlay
from backend.perception.summarize import STORE
from backend.perception.track import raw_path
from backend.perception.whatif import compute_whatif
from backend.state import STATE

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("almost.api")
STATIC = Path(__file__).parent / "static"
FRONTEND_DIST = C.ROOT / "frontend" / "dist"


class Hub:
    """WebSocket broadcast. Thread-safe `emit` feeds one ordered queue."""

    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.queue: asyncio.Queue | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    def emit(self, msg):
        """Serialize now: the run thread keeps mutating these dicts after emitting."""
        if self.loop and self.queue:
            try:
                data = json.dumps(msg, default=str)
            except Exception as e:  # never let one message break the stream
                log.warning("unserializable ws message %s: %s", msg.get("type"), e)
                return
            self.loop.call_soon_threadsafe(self.queue.put_nowait, data)

    async def pump(self):
        while True:
            data = await self.queue.get()
            for ws in list(self.clients):
                try:
                    await ws.send_text(data)
                except Exception:
                    self.clients.discard(ws)


HUB = Hub()


@asynccontextmanager
async def lifespan(app):
    HUB.loop, HUB.queue = asyncio.get_running_loop(), asyncio.Queue()
    pump = asyncio.create_task(HUB.pump())
    threading.Thread(target=llm.init, daemon=True).start()
    if C.CHECK_CATALOG_URLS:
        check_catalog_urls()
    log.info("memory backend: %s · llm: %s", BACKEND_NAME, C.LLM_MODEL if C.WANDB_API_KEY else "templates")
    yield
    pump.cancel()


app = FastAPI(title="LOOKOUT", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/media", StaticFiles(directory=C.DATA), name="media")


@app.get("/console", include_in_schema=False)
def test_console():
    return FileResponse(STATIC / "mock.html")


_STATUS = {"at": 0.0, "data": None}


def _probe_all():
    """Probe every external service in parallel; 'cached' = down but recordings exist (replay available)."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    import httpx

    from backend import replay
    gpu_h = {"Authorization": f"Bearer {C.GPU_BEARER_TOKEN}"} if C.GPU_BEARER_TOKEN else {}

    def get(url, headers=None):
        try:
            r = httpx.get(url, headers=headers or {}, timeout=4)
            return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else None)
        except Exception:
            return None, None

    def model_of(js):
        try:
            return js["data"][0]["id"]
        except Exception:
            return None

    probes = {
        "vast_vss": ("VAST video archive (VSS)", lambda: get(f"{C.VSS_URL}/api/v1/metadata/ingest-config") if C.VSS_URL else (None, None), "vss_search"),
        "cosmos3_reason": ("NVIDIA Cosmos3-Reason", lambda: get(f"{C.COSMOS3_REASON_URL}/v1/models", gpu_h), "cosmos3_reason"),
        "embed1": ("NVIDIA Cosmos Embed1", lambda: get(f"{C.COSMOS_EMBED1_URL}/v1/models", gpu_h), "embed1"),
        "yolo11": ("YOLO11 detector", lambda: get(f"{C.YOLO_URL}/healthz", gpu_h), None),
        "wandb_llm": ("W&B Inference · " + C.LLM_MODEL.split("/")[-1],
                      lambda: get(f"{C.WANDB_BASE_URL}/models", {"Authorization": f"Bearer {C.WANDB_API_KEY}"})
                      if C.WANDB_API_KEY else (None, None), "wandb_llm"),
    }
    with ThreadPoolExecutor(max_workers=len(probes)) as ex:
        results = dict(zip(probes, ex.map(lambda k: probes[k][1](), probes)))
    out = []
    for key, (name, _, rec_dir) in probes.items():
        code, js = results[key]
        n_rec = sum(1 for _ in (replay.DIR / rec_dir).glob("*.json")) if rec_dir and (replay.DIR / rec_dir).exists() else 0
        state = "live" if code == 200 else ("cached" if n_rec else "down")
        detail = model_of(js) if key in ("cosmos3_reason", "embed1") else None
        if key == "yolo11" and code == 200:
            detail = "yolo11 · per-frame sidecars"
        out.append({"key": key, "name": name, "state": state, "http": code, "detail": detail, "recordings": n_rec})
    out.append({"key": "weave", "name": "W&B Weave tracing", "state": "live" if llm.WEAVE_URL else "down",
                "detail": llm.WEAVE_URL, "recordings": 0})
    return {"services": out, "replay": replay.status(), "memory_backend": BACKEND_NAME, "data_mode": C.DATA_MODE,
            "checked_at": time.strftime("%H:%M:%S")}


@app.get("/status")
def status():
    import time
    if time.time() - _STATUS["at"] > 15 or _STATUS["data"] is None:
        _STATUS["data"], _STATUS["at"] = _probe_all(), time.time()
    return _STATUS["data"]


def _replay_status():
    from backend import replay
    return replay.status()


@app.get("/health")
def health():
    ingest = C.CACHE_DIR / "ingest_status.json"
    return {"ok": True, "memory_backend": BACKEND_NAME, "llm": C.LLM_MODEL if llm.enabled() else "template",
            "vss": bool(C.VSS_URL), "gpu": bool(C.GPU_BEARER_TOKEN), "replay": _replay_status(),
            "ingest": json.loads(ingest.read_text()) if ingest.exists() else None,
            "weave_url": llm.WEAVE_URL, "data_mode": C.DATA_MODE, "cameras": len(visible_cameras()),
            "tracks_ready": [c["camera_id"] for c in load_cameras() if (C.TRACKS_DIR / f"{c['camera_id']}.parquet").exists()]}


@app.get("/config")
def get_config():
    cams = []
    for c in visible_cameras():
        c = {k: v for k, v in c.items() if k != "sim"}
        try:
            c["duration_s"] = round(STORE.get(c["camera_id"])["duration_s"], 1)
        except Exception:
            c["duration_s"] = None
        cams.append(c)
    return {"sites": visible_sites(), "cameras": cams, "data_mode": C.DATA_MODE}


class InvestigateBody(BaseModel):
    site_ids: list[str] | None = None


@app.post("/investigate")
def investigate(body: InvestigateBody | None = None, live: bool = False):
    """Default: replay the last successful live run (smooth, works offline). ?live=1 runs the pipeline for real
    (and records it). REPLAY_RUNS=0 makes live the default."""
    if any(r.get("status") == "running" for r in STATE.runs.values()):
        raise HTTPException(409, "an investigation is already running")
    known = {x["site_id"] for x in load_sites()}
    bad = [x for x in (body.site_ids or []) if x not in known] if body else []
    if bad:
        raise HTTPException(400, f"unknown site ids: {bad}")
    run_id = f"r{uuid.uuid4().hex[:6]}"
    explicit = bool(body and body.site_ids)
    if not live and not explicit and os.environ.get("REPLAY_RUNS", "1") == "1" and has_recording():
        run = ReplayRun(run_id, HUB.emit)
        threading.Thread(target=run.go, daemon=True, name=f"replay-{run_id}").start()
        return {"run_id": run_id, "mode": "replay"}
    run = Run(run_id, body.site_ids if body else None, HUB.emit)
    threading.Thread(target=run.go, daemon=True, name=f"run-{run_id}").start()
    return {"run_id": run_id}


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    if run_id not in STATE.runs:
        raise HTTPException(404, "unknown run")
    return STATE.runs[run_id]


@app.get("/runs")
def list_runs():
    return sorted(STATE.runs.values(), key=lambda r: r.get("started_at", ""), reverse=True)


def _event(eid):
    e = STATE.events.get(eid) or memory.get_event(eid)
    if not e:
        raise HTTPException(404, "unknown event")
    return e


def _shown_sites():
    return {s["site_id"] for s in visible_sites()}


@app.get("/events")
def list_events(site_id: str | None = None, status: str | None = None):
    shown = _shown_sites()
    evs = list(STATE.events.values()) or memory.list_events(site_id, status)
    evs = [e for e in evs if (not site_id or e["site_id"] == site_id) and (not status or e["status"] == status)
           and (site_id or e["site_id"] in shown)]
    return sorted(evs, key=lambda e: -e["score"])


@app.get("/events/{eid}")
def get_event(eid: str):
    e = _event(eid)
    return {**e, "overlay": overlay(e, STORE)}


_WHATIF = {}


@app.get("/events/{eid}/whatif")
def get_whatif(eid: str):
    e = _event(eid)
    key = (eid, e["t_conflict"], e["a"]["track_id"], e["b"]["track_id"])
    if key not in _WHATIF:
        _WHATIF[key] = compute_whatif(e, STORE)
    return _WHATIF[key]


@app.get("/events/{eid}/similar")
def get_similar(eid: str):
    _event(eid)
    return [{"event": s["event"], "score": s["score"]} for s in memory.similar_events(eid, 8, [eid])]


@app.get("/patterns")
def list_patterns(site_id: str | None = None):
    shown = _shown_sites()
    return [p for p in STATE.patterns.values() if (p["site_id"] == site_id if site_id else p["site_id"] in shown)]


@app.get("/patterns/{pid}")
def get_pattern(pid: str):
    if pid not in STATE.patterns:
        raise HTTPException(404, "unknown pattern")
    return STATE.patterns[pid]


@app.get("/report/{site_id}.md", response_class=PlainTextResponse)
def report_md(site_id: str):
    return PlainTextResponse(_report_md(site_id), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="almost-{site_id}.md"'})


def _report_md(site_id):
    r = _report(site_id)
    s = r["site"]
    L = [f"# Near-miss report: {s['name']}", "",
         f"Site `{s['site_id']}` · speed limit {s.get('speed_limit_mph')} mph · generated {r['generated_at']}", "",
         f"> {r['disclaimer']}", ""]
    if not r["patterns"]:
        L += ["No recurring pattern was found at this site.", ""]
    evs = {e["event_id"]: e for e in STATE.events.values()}
    for p in r["patterns"]:
        L += [f"## {p['pattern_id']}: {p['signature']}", "",
              f"{p['count']} verified close calls · worst PET {p['worst_pet_s']} s · median PET {p['median_pet_s']} s", "",
              p["summary"], "", "### Recommendations (FHWA Proven Safety Countermeasures)", ""]
        if not p["recommendations"]:
            L += [f"_None: {p.get('recommendation_note') or 'no catalog entry matched'}._", ""]
        for rec in p["recommendations"]:
            L += [f"- **[{rec['name']}]({rec['url']})**: {rec['why']}"]
            for eid in rec["cited_event_ids"]:
                e = evs.get(eid)
                if e:
                    L += [f"  - `{eid}`: {e['camera_id']} at {_ts(e['t_conflict'])}, PET {e['pet_s']} s, "
                          f"{e['conflict_type'].replace('_', ' ')}"]
            L += [f"  - _{rec['review_note']}_"]
        L += [""]
    L += ["## Top verified events", ""]
    for e in r["top_events"]:
        L += [f"- `{e['event_id']}` {e['camera_id']} {_ts(e['t_conflict'])} · {e['conflict_type']} · "
              f"PET {e['pet_s']} s · {e['severity']}: {(e.get('verification') or {}).get('reason', '')}"]
    return "\n".join(L) + "\n"


@app.get("/report/{site_id}")
def report(site_id: str):
    return _report(site_id)


def _report(site_id):
    if site_id not in STATE.reports:
        try:
            site = next(s for s in load_sites() if s["site_id"] == site_id)
        except StopIteration:
            raise HTTPException(404, "unknown site")
        from backend.agents.orchestrator import build_report
        return build_report(site, list(STATE.patterns.values()), list(STATE.events.values()))
    return STATE.reports[site_id]


def _ts(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


@app.get("/eval/latest")
def eval_latest():
    p = C.GT_DIR / "eval_latest.json"
    if not p.exists():
        raise HTTPException(404, "no eval yet: python -m backend.evals.run_eval")
    return json.loads(p.read_text())


@app.get("/catalog")
def catalog():
    return [{**c, "url_status": URL_STATUS.get(c["id"])} for c in load_catalog(active_only=False)]


class CalibrationBody(BaseModel):
    homography: list[list[float]] | None = None
    points: list[dict] | None = None          # [{"u","v","gx","gy"}] ≥ 4 → homography is fitted
    ground: dict | None = None
    camera_ground_xy: list[float] | None = None


@app.put("/cameras/{camera_id}/calibration")
def put_calibration(camera_id: str, body: CalibrationBody):
    cams = load_cameras()
    cam = next((c for c in cams if c["camera_id"] == camera_id), None)
    if not cam:
        raise HTTPException(404, "unknown camera")
    if body.points:
        if len(body.points) < 4:
            raise HTTPException(422, "need at least 4 points")
        cam["homography"] = homography_from_points(body.points)
    elif body.homography:
        cam["homography"] = body.homography
    if body.ground is not None:
        cam["ground"] = body.ground
    if body.camera_ground_xy is not None:
        cam["camera_ground_xy"] = body.camera_ground_xy
    if body.points or body.homography:
        cam["calibrated"] = True  # a human calibration now outranks autocal on re-ingest
    save_cameras(cams)
    recalibrated = False
    if raw_path(camera_id).exists():
        calibrate_camera(camera_id)
        recalibrated = True
    STORE.invalidate(camera_id)
    _WHATIF.clear()
    return {"camera_id": camera_id, "homography": cam["homography"], "recalibrated_tracks": recalibrated}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    HUB.clients.add(sock)
    try:
        while True:
            await sock.receive_text()  # keepalive / ignore
    except WebSocketDisconnect:
        HUB.clients.discard(sock)


# The frontend build (frontend/dist, built with VITE_API_BASE=same-origin) is served at /. Mounted last so every
# API route above wins; unknown paths fall back to index.html (hash router).
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    @app.get("/", include_in_schema=False)
    def no_frontend():
        return FileResponse(STATIC / "mock.html")
