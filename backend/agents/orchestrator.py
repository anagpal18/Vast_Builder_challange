"""The investigation: scan → measure → verify → remember → recall → pattern → recommend → report (SHRESTH 2.1).

Every stage streams over the WebSocket (MASTER 5). Each run is one Weave trace tree.
"""
import contextvars
import copy
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from backend import config as C
from backend.agents import llm
from backend.agents.patterns import find_patterns
from backend.agents.recommend import recommend
from backend.memory_adapter import BACKEND_NAME, memory
from backend.perception.camera import get_camera, load_cameras, load_sites, visible_sites
from backend.perception.clips import cut_clip
from backend.perception.conflicts import measure_camera
from backend.perception.summarize import STORE
from backend.state import STATE

log = logging.getLogger("almost.run")
VERIFY_CACHE = C.CACHE_DIR / "verify" / BACKEND_NAME
VERIFY_CACHE.mkdir(parents=True, exist_ok=True)
STAGES = ["scan", "measure", "verify", "remember", "recall", "pattern", "recommend", "report"]
_POOL = ThreadPoolExecutor(max_workers=8)


class Run:
    """Runs synchronously in a worker thread (one Weave trace tree); `emit` must be thread-safe."""

    def __init__(self, run_id, site_ids, emit):
        self.run_id, self.emit = run_id, emit
        sites = load_sites() if site_ids else visible_sites()  # explicit ids (eval) may name hidden sites
        self.sites = {s["site_id"]: s for s in sites if not site_ids or s["site_id"] in site_ids}
        cam_ids = {i for s in self.sites.values() for i in s["camera_ids"]}
        self.cameras = [c for c in load_cameras() if c["camera_id"] in cam_ids]
        self.counts = {"video_minutes": 0, "road_users": 0, "interactions": 0, "candidates": 0,
                       "verified": 0, "rejected": 0, "unsure": 0, "similar_links": 0, "patterns": 0,
                       "recommendations": 0}
        self.events, self.patterns = {}, []
        self.rec = {"run_id": run_id, "status": "running", "site_ids": list(self.sites),
                    "stages": {s: {"status": "pending"} for s in STAGES}, "counts": self.counts,
                    "event_ids": [], "pattern_ids": [], "started_at": _now(), "memory_backend": BACKEND_NAME,
                    "llm": None}
        STATE.runs[run_id] = self.rec

    def stage(self, name, status, progress=None):
        st = self.rec["stages"][name]
        st["status"] = status
        if status == "start":
            st["t0"] = time.time()
        if status == "done":
            st["elapsed_s"] = round(time.time() - st.get("t0", time.time()), 2)
        if progress is not None:
            st["progress"] = round(progress, 3)
        self.emit({"type": "run.stage", "run_id": self.run_id, "stage": name, "status": status,
                   "progress": progress if progress is not None else (1.0 if status == "done" else 0.0),
                   "counts": dict(self.counts)})

    def go(self):
        try:
            llm.init()
            self.rec["llm"] = C.LLM_MODEL if llm.enabled() else "template (no WANDB_API_KEY)"
            self.rec["weave_url"] = llm.WEAVE_URL
            investigate(self, list(self.sites))
            self.rec["status"] = "done"
        except Exception as e:
            log.exception("run %s failed", self.run_id)
            self.rec["status"] = "error"
            self.rec["error"] = str(e)
            self.emit({"type": "run.error", "run_id": self.run_id, "error": str(e)})
        finally:
            self.rec["finished_at"] = _now()
            self.rec["elapsed_s"] = round(sum(s.get("elapsed_s", 0) for s in self.rec["stages"].values()), 2)
            STATE.save()
            self.emit({"type": "run.done", "run_id": self.run_id, "status": self.rec["status"]})

    def ranked(self):
        return sorted(self.events.values(), key=lambda e: -e["score"])

    def to_verify(self):
        """Top N overall, plus the top few per site so no site goes unexamined."""
        ranked = self.ranked()
        pick = {e["event_id"]: e for e in ranked[:C.TOP_VERIFY]}
        for sid in self.sites:
            for e in [x for x in ranked if x["site_id"] == sid][:C.MIN_VERIFY_PER_SITE]:
                pick.setdefault(e["event_id"], e)
        return sorted(pick.values(), key=lambda e: -e["score"])

    # --- stages ------------------------------------------------------------------------------
    def scan(self):
        self.stage("scan", "start")
        for i, cam in enumerate(self.cameras):
            entry = STORE.get(cam["camera_id"])
            self.counts["video_minutes"] = round(self.counts["video_minutes"] + entry["duration_s"] / 60, 1)
            self.counts["road_users"] += len(entry["tracks"])
            memory.store_track_summaries(STORE.summaries(cam["camera_id"]))
            self.stage("scan", "progress", (i + 1) / max(1, len(self.cameras)))
        self.stage("scan", "done")
        return {k: self.counts[k] for k in ("video_minutes", "road_users")}

    def measure(self):
        self.stage("measure", "start")
        for i, cam in enumerate(self.cameras):
            evs, n = measure_camera(cam["camera_id"], STORE)
            self.counts["interactions"] += n
            for e in evs:
                self.events[e["event_id"]] = e
            self.counts["candidates"] = len(self.events)
            self.stage("measure", "progress", (i + 1) / max(1, len(self.cameras)))
        top = self.ranked()[:C.TOP_CANDIDATES_EMIT]
        list(_POOL.map(cut_clip, top))  # cached on disk; every emitted candidate has a working clip + thumb
        for e in top:
            self.emit({"type": "run.candidate", "event": e})
        self.stage("measure", "done")
        return {"interactions": self.counts["interactions"], "candidates": self.counts["candidates"]}

    def _verify_one(self, ev, live):
        cache = VERIFY_CACHE / f"{ev['event_id']}.json"
        if not live and cache.exists():
            return ev, json.loads(cache.read_text())
        clip = cut_clip(ev)
        v = verify_op(ev, str(clip) if clip else "")
        cache.write_text(json.dumps(v))
        return ev, v

    def verify(self, events=None):
        first = events is None
        top = events or self.to_verify()
        if first:
            self.stage("verify", "start")
        futs = [_POOL.submit(contextvars.copy_context().run, self._verify_one, e, first and i == 0)
                for i, e in enumerate(top)]
        for k, fut in enumerate(as_completed(futs), 1):
            e, v = fut.result()
            e["verification"] = v
            e["status"] = {"ACCEPT": "verified", "REJECT": "rejected"}.get(v["verdict"], "unsure")
            self.counts[e["status"]] += 1
            self.emit({"type": "run.verified", "event_id": e["event_id"], "verdict": v["verdict"],
                       "reason": v.get("reason", ""), "status": e["status"]})
            if first:
                self.stage("verify", "progress", k / len(top))
        if first:
            self.stage("verify", "done")
        return {e["event_id"]: e["status"] for e in top}

    def remember(self):
        self.stage("remember", "start")
        for e in self.events.values():
            memory.store_event(e)
        self.stage("remember", "done")
        return len(self.events)

    def recall(self):
        self.stage("recall", "start")
        verified = [e for e in self.events.values() if e["status"] == "verified"]
        for i, e in enumerate(verified):
            sims = memory.similar_events(e["event_id"], 8, [e["event_id"]])
            e["similar"] = [{"event_id": s["event"]["event_id"], "score": s["score"]} for s in sims]
            ids = [s["event_id"] for s in e["similar"] if s["score"] > C.SIMILAR_MERGE_SCORE]
            self.counts["similar_links"] += len(ids)
            self.emit({"type": "run.similar", "event_id": e["event_id"], "similar_ids": ids})
            self.stage("recall", "progress", (i + 1) / max(1, len(verified)))
        new = self._recall_chunks(verified)
        self.stage("recall", "done")
        return {"links": self.counts["similar_links"], "new_from_chunks": new}

    def _recall_chunks(self, verified):
        """Footage chunks that read like a verified event but hold no candidate: re-measure that window with
        relaxed thresholds; anything new goes through verification."""
        cams, new = {c["camera_id"] for c in self.cameras}, []
        for e in verified:
            desc = (e.get("verification") or {}).get("description") or e["conflict_type"]
            for r in memory.similar_chunks(desc, 5, e["site_id"]):
                ch = r["chunk"]
                if ch["camera_id"] not in cams or any(
                        x["camera_id"] == ch["camera_id"] and ch["t_start"] <= x["t_conflict"] <= ch["t_end"]
                        for x in self.events.values()):
                    continue
                evs, _ = measure_camera(ch["camera_id"], STORE, (ch["t_start"], ch["t_end"]),
                                        {"pet": C.PET_CANDIDATE_S * 1.3, "ttc": C.TTC_CANDIDATE_S * 1.3})
                for x in evs:
                    if x["event_id"] not in self.events:
                        x["found_by"] = "vast_recall"
                        self.events[x["event_id"]] = x
                        new.append(x)
                        self.emit({"type": "run.candidate", "event": x})
        if new:
            self.counts["candidates"] = len(self.events)
            self.verify(new)
            for x in new:
                memory.store_event(x)
        return len(new)

    def pattern(self):
        self.stage("pattern", "start")
        verified = [e for e in self.events.values() if e["status"] == "verified"]
        sim = {e["event_id"]: e.get("similar", []) for e in verified}
        self.patterns = find_patterns(verified, self.sites, sim, self.events)
        for p in self.patterns:
            for eid in p["event_ids"]:
                self.events[eid]["pattern_id"] = p["pattern_id"]
            self.counts["patterns"] += 1
            self.emit({"type": "run.pattern", "pattern": p})
        self.stage("pattern", "done")
        return [p["pattern_id"] for p in self.patterns]

    def recommend(self):
        self.stage("recommend", "start")
        done = [0]

        def one(p):
            recs, note = recommend(p, [self.events[x] for x in p["event_ids"]], self.sites[p["site_id"]])
            p["recommendations"], p["recommendation_note"] = recs, note
            for r in recs:
                self.counts["recommendations"] += 1
                self.emit({"type": "run.recommendation", "pattern_id": p["pattern_id"], "recommendation": r})
            done[0] += 1
            self.stage("recommend", "progress", done[0] / len(self.patterns))
        llm.pmap(one, self.patterns)
        self.stage("recommend", "done")
        return self.counts["recommendations"]

    def report(self):
        self.stage("report", "start")
        with STATE.lock:
            cams = {c["camera_id"] for c in self.cameras}
            STATE.events = {k: v for k, v in STATE.events.items() if v["camera_id"] not in cams}
            STATE.patterns = {k: v for k, v in STATE.patterns.items() if v["site_id"] not in self.sites}
            STATE.events.update(self.events)
            STATE.patterns.update({p["pattern_id"]: p for p in self.patterns})
            for sid, site in self.sites.items():
                STATE.reports[sid] = build_report(site, list(STATE.patterns.values()), list(STATE.events.values()))
        self.rec["event_ids"] = [e["event_id"] for e in self.ranked()]
        self.rec["pattern_ids"] = [p["pattern_id"] for p in self.patterns]
        self.stage("report", "done")
        return list(self.sites)


@llm.op(name="memory.verify_event")
def verify_op(event, clip_path):
    return memory.verify_event(copy.deepcopy(event), clip_path)


@llm.op(name="investigate")
def investigate(run, site_ids):
    out = {}
    for name in STAGES:
        out[name] = llm.op(name=f"stage.{name}")(getattr(run, name))()
    return {"counts": dict(run.counts), "stages": out}


def build_report(site, patterns, events):
    ps = [p for p in patterns if p["site_id"] == site["site_id"]]
    evs = sorted((e for e in events if e["site_id"] == site["site_id"] and e["status"] == "verified"),
                 key=lambda e: -e["score"])
    return {"site": site, "patterns": ps,
            "recommendations": [{**r, "pattern_id": p["pattern_id"]} for p in ps for r in p["recommendations"]],
            "top_events": evs[:5], "generated_at": _now(), "disclaimer": C.REPORT_DISCLAIMER}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
