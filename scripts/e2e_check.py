#!/usr/bin/env python3
"""End-to-end check of a running ALMOST server (local, on the VM, or the k8s /app URL).

    .venv/bin/python scripts/e2e_check.py --base http://127.0.0.1:8765
    .venv/bin/python scripts/e2e_check.py --base http://video-lab-team-28.cosmos.vastdata.com/app

Drives a full investigation over REST + WebSocket and checks every page and endpoint the frontend uses.
Prints one JSON report with PASS/FAIL per check (no secrets).
"""
import argparse
import asyncio
import collections
import json
import sys
import time

import httpx
import websockets

R = {"checks": {}, "facts": {}}


def check(name, ok, **facts):
    R["checks"][name] = "PASS" if ok else "FAIL"
    if facts:
        R["facts"][name] = facts
    return ok


async def run_investigation(base, client, timeout):
    ws_url = base.replace("http", "ws", 1) + "/ws"
    types, stages, verdicts = collections.Counter(), {}, collections.Counter()
    t0 = time.time()
    async with websockets.connect(ws_url, max_size=50_000_000, open_timeout=30) as ws:
        r = client.post("/investigate", json={})
        if r.status_code != 200:
            return check("investigate_post", False, status=r.status_code, body=r.text[:300]), None
        run_id = r.json()["run_id"]
        while time.time() - t0 < timeout:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            types[m["type"]] += 1
            if m["type"] == "run.stage" and m["status"] == "done":
                stages[m["stage"]] = round(time.time() - t0, 1)
            if m["type"] == "run.verified":
                verdicts[m["verdict"]] += 1
            if m["type"] in ("run.done", "run.error") and m.get("run_id") == run_id:
                break
    check("websocket_stream", types["run.done"] == 1 and len(stages) == 8,
          message_types=dict(types), stage_done_at_s=stages, verdicts=dict(verdicts),
          elapsed_s=round(time.time() - t0, 1))
    return True, run_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--timeout", type=float, default=1500)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    c = httpx.Client(base_url=base, timeout=120, follow_redirects=True)

    h = c.get("/health").json()
    check("health", h.get("ok") is True, data_mode=h.get("data_mode"), memory=h.get("memory_backend"),
          llm=h.get("llm"), vss=h.get("vss"), gpu=h.get("gpu"), cameras=h.get("cameras"),
          ingest={k: v.get("state") for k, v in (h.get("ingest") or {}).items()})
    cfg = c.get("/config").json()
    cams = cfg["cameras"]
    real = [x for x in cams if x.get("vss")]
    check("config_real_cameras", bool(real) if cfg.get("data_mode") == "real" else bool(cams),
          data_mode=cfg.get("data_mode"), sites=[s["site_id"] for s in cfg["sites"]],
          cameras=[f"{x['camera_id']}<-{(x.get('vss') or {}).get('camera_id', 'sim')}" for x in cams])
    feeds = {x["camera_id"]: c.head("/media" + x["video_url"].removeprefix("/media")).status_code for x in cams}
    check("feeds_playable", all(v == 200 for v in feeds.values()), status=feeds)

    ok, run_id = asyncio.run(run_investigation(base, c, args.timeout))
    if run_id:
        run = c.get(f"/runs/{run_id}").json()
        check("run_done", run["status"] == "done", status=run["status"], error=run.get("error"),
              counts=run["counts"], llm=run.get("llm"), memory=run.get("memory_backend"),
              stage_seconds={k: v.get("elapsed_s") for k, v in run["stages"].items()})

    evs = c.get("/events").json()
    by_cam = collections.Counter(e["camera_id"] for e in evs)
    by_status = collections.Counter(e["status"] for e in evs)
    models = collections.Counter((e.get("verification") or {}).get("model") for e in evs if e.get("verification"))
    check("events", len(evs) > 0, total=len(evs), by_camera=dict(by_cam), by_status=dict(by_status),
          verifier_models=dict(models))
    verified = [e for e in evs if e.get("verification")]
    R["facts"]["sample_verdicts"] = [
        {"event": e["event_id"], "type": e["conflict_type"], "pet_s": e["pet_s"], "a": e["a"]["cls"], "b": e["b"]["cls"],
         "verdict": e["verification"]["verdict"], "reason": e["verification"]["reason"][:200]}
        for e in verified[:6]]

    if evs:
        top = verified[0] if verified else evs[0]
        eid = top["event_id"]
        d = c.get(f"/events/{eid}").json()
        check("event_detail_overlay", bool(d["overlay"]["a"]) and bool(d["overlay"]["b"]),
              event=eid, overlay_rows=[len(d["overlay"]["a"]), len(d["overlay"]["b"])])
        w = c.get(f"/events/{eid}/whatif").json()
        check("whatif", len(w["gap_curve"]) == 121 and "homography_inv" in w,
              first_contact_shift_s=w["first_contact_shift_s"], observed=w["observed"], impact=w["impact"])
        clip = c.head("/media" + top["clip"]["url"].removeprefix("/media"))
        thumb = c.head("/media" + top["clip"]["thumb"].removeprefix("/media"))
        check("clip_and_thumb", clip.status_code == 200 and thumb.status_code == 200,
              clip=clip.status_code, thumb=thumb.status_code)
        sim = c.get(f"/events/{eid}/similar")
        check("similar", sim.status_code == 200, n=len(sim.json()) if sim.status_code == 200 else sim.text[:200])

    pats = c.get("/patterns").json()
    check("patterns", True, n=len(pats), items=[
        {"id": p["pattern_id"], "signature": p["signature"], "count": p["count"], "by": p.get("generated_by"),
         "recs": [r["name"] for r in p["recommendations"]], "note": p.get("recommendation_note")} for p in pats])
    for s in cfg["sites"][:3]:
        md = c.get(f"/report/{s['site_id']}.md")
        check(f"report_md_{s['site_id']}", md.status_code == 200 and "traffic engineer review" in md.text,
              disposition=md.headers.get("content-disposition"), first_line=md.text.splitlines()[0] if md.text else "")
    idx = c.get("/")
    asset = next((p for p in idx.text.split('"') if p.startswith("./assets/") and p.endswith(".js")), None)
    js = c.get("/" + asset.removeprefix("./")) if asset else None
    check("frontend", idx.status_code == 200 and 'id="root"' in idx.text and js is not None and js.status_code == 200,
          index=idx.status_code, asset=asset, asset_status=js.status_code if js else None)
    check("console", c.get("/console").status_code == 200)
    R["summary"] = {"pass": sum(v == "PASS" for v in R["checks"].values()),
                    "fail": [k for k, v in R["checks"].items() if v != "PASS"]}
    print(json.dumps(R, indent=1, default=str))
    return 0 if not R["summary"]["fail"] else 1


if __name__ == "__main__":
    sys.exit(main())
