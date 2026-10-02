"""Weave evaluation vs simulator ground truth (SHRESTH 4, MASTER 10).

    python -m backend.evals.run_eval [--label "after PET fix"]

Runs a full investigation headless, scores it, writes data/ground_truth/eval_latest.json (served at /eval/latest)
and appends to eval_history.json so before/after can be shown.
"""
import argparse
import json
import statistics
from datetime import datetime, timezone

from backend import config as C
from backend.agents import llm
from backend.agents.recommend import URL_STATUS, candidates_for, catalog_by_id

MATCH_S = 1.5


def match(event, gt_rows):
    best = None
    for g in gt_rows:
        if g["camera_id"] != event["camera_id"] or abs(g["t"] - event["t_conflict"]) > MATCH_S:
            continue
        if {g["a_cls"], g["b_cls"]} != {event["a"]["cls"], event["b"]["cls"]}:
            continue
        if best is None or abs(g["t"] - event["t_conflict"]) < abs(best["t"] - event["t_conflict"]):
            best = g
    return best


@llm.op(name="score.detection")
def detection(events, gt_rows):
    matched_gt = {m["gt_id"] for e in events if (m := match(e, gt_rows))}
    tp = sum(1 for e in events if match(e, gt_rows))
    missed = [g["gt_id"] for g in gt_rows if g["gt_id"] not in matched_gt]
    return {"recall": len(matched_gt) / max(1, len(gt_rows)), "precision": tp / max(1, len(events)),
            "candidates": len(events), "ground_truth": len(gt_rows), "missed": missed}


@llm.op(name="score.pet_error")
def pet_error(events, gt_rows):
    errs = []
    for e in events:
        g = match(e, gt_rows)
        if g and g.get("true_pet_s") is not None:
            errs.append({"event_id": e["event_id"], "gt_id": g["gt_id"], "pet": e["pet_s"],
                         "true_pet": g["true_pet_s"], "abs_err": round(abs(e["pet_s"] - g["true_pet_s"]), 3)})
    a = [x["abs_err"] for x in errs]
    return {"mae_s": round(statistics.mean(a), 3) if a else None, "max_s": max(a) if a else None, "n": len(a),
            "pairs": errs}


@llm.op(name="score.verification_accuracy")
def verification_accuracy(events, gt_rows):
    rows = []
    for e in events:
        v = (e.get("verification") or {}).get("verdict")
        g = match(e, gt_rows)
        if not v or not g:
            continue
        ok = (v == "ACCEPT") if g["is_conflict"] else (v == "REJECT")
        rows.append({"event_id": e["event_id"], "verdict": v, "is_conflict": g["is_conflict"], "correct": ok})
    decoys = [r for r in rows if not r["is_conflict"]]
    return {"accuracy": sum(r["correct"] for r in rows) / max(1, len(rows)), "n": len(rows),
            "decoy_reject_rate": sum(r["correct"] for r in decoys) / max(1, len(decoys)) if decoys else None,
            "rows": rows}


@llm.op(name="score.pattern_purity")
def pattern_purity(patterns, events_by_id, gt_rows):
    per = []
    for p in patterns:
        hits = 0
        for eid in p["event_ids"]:
            g = match(events_by_id[eid], gt_rows)
            hits += bool(g and g["conflict_type"] == p["conflict_type"] and g["is_conflict"])
        per.append({"pattern_id": p["pattern_id"], "purity": hits / max(1, len(p["event_ids"]))})
    return {"mean_purity": statistics.mean(x["purity"] for x in per) if per else None, "patterns": per}


@llm.op(name="score.recommendation_validity")
def recommendation_validity(patterns, events_by_id):
    cat = catalog_by_id()
    total = in_cat = mapped = cites_ok = url_ok = 0
    issues = []
    for p in patterns:
        allowed = {c["id"] for c in candidates_for(p, [events_by_id[x] for x in p["event_ids"]])}
        for r in p["recommendations"]:
            total += 1
            c = cat.get(r["countermeasure_id"])
            if c and c.get("active", True) and r["url"] == c["url"] and r["name"] == c["name"]:
                in_cat += 1
            else:
                issues.append(f"{p['pattern_id']}: {r['countermeasure_id']} not from catalog")
            if r["countermeasure_id"] in allowed:
                mapped += 1
            else:
                issues.append(f"{p['pattern_id']}: {r['countermeasure_id']} not mapped to {p['conflict_type']}")
            ok = all(x in p["event_ids"] and events_by_id[x]["status"] == "verified" for x in r["cited_event_ids"])
            cites_ok += ok
            status = URL_STATUS.get(r["countermeasure_id"])
            url_ok += status in (200, 403)  # 403 = FHWA CDN blocks scripted clients; page exists
    pct = lambda n: n / total if total else None
    return {"from_catalog": pct(in_cat), "mapping_matches": pct(mapped), "citations_valid": pct(cites_ok),
            "url_reachable_or_cdn_blocked": pct(url_ok), "recommendations": total,
            "patterns_without_recommendation": [p["pattern_id"] for p in patterns if not p["recommendations"]],
            "issues": issues}


@llm.op(name="almost.evaluate")
def evaluate(run_events, patterns, gt_rows):
    events_by_id = {e["event_id"]: e for e in run_events}
    return {
        "detection": detection(run_events, gt_rows),
        "pet_error": pet_error(run_events, gt_rows),
        "verification": verification_accuracy(run_events, gt_rows),
        "patterns": pattern_purity(patterns, events_by_id, gt_rows),
        "recommendations": recommendation_validity(patterns, events_by_id),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    import time
    from backend.agents.orchestrator import Run
    from backend.agents.recommend import check_catalog_urls

    llm.init()
    check_catalog_urls()
    gt_rows = json.loads((C.GT_DIR / "events.json").read_text())
    if llm._weave is not None:
        try:
            llm._weave.publish(llm._weave.Dataset(name="almost_ground_truth", rows=gt_rows))
        except Exception as e:
            print("dataset publish skipped:", e)
    from backend.perception.camera import load_cameras, load_sites
    sim_cams = {c["camera_id"] for c in load_cameras() if "sim" in c}
    sim_sites = [s["site_id"] for s in load_sites() if set(s["camera_ids"]) & sim_cams]
    run = Run(f"eval-{int(time.time())}", sim_sites, lambda m: None)  # ground truth exists only for these
    run.go()
    time.sleep(3)  # let the URL check finish
    res = evaluate(list(run.events.values()), run.patterns, gt_rows)
    metrics = {
        "detection_recall": res["detection"]["recall"], "detection_precision": res["detection"]["precision"],
        "pet_mae_s": res["pet_error"]["mae_s"], "pet_max_err_s": res["pet_error"]["max_s"],
        "verification_accuracy": res["verification"]["accuracy"],
        "decoy_reject_rate": res["verification"]["decoy_reject_rate"],
        "pattern_purity": res["patterns"]["mean_purity"],
        "recs_from_catalog": res["recommendations"]["from_catalog"],
        "recs_mapping_matches": res["recommendations"]["mapping_matches"],
        "recs_citations_valid": res["recommendations"]["citations_valid"],
        "run_seconds": run.rec.get("elapsed_s"),
    }
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    ver = res["verification"]
    decoys = [r for r in ver["rows"] if not r["is_conflict"]]
    rec = res["recommendations"]
    out = {
        # frontend EvalResult (frontend/src/types.ts)
        "detection": {"recall": res["detection"]["recall"], "precision": res["detection"]["precision"]},
        "measurement": {"pet_mae_s": res["pet_error"]["mae_s"]},
        "verification": {"accuracy": ver["accuracy"],
                         "decoys_rejected": f"{sum(r['correct'] for r in decoys)}/{len(decoys)}"},
        "patterns": {"purity": res["patterns"]["mean_purity"]},
        "recommendations": {"from_catalog": rec["from_catalog"], "urls_valid": rec["url_reachable_or_cdn_blocked"],
                            "claims_cited": rec["citations_valid"]},
        "weave_url": llm.WEAVE_URL, "run_at": now,
        # full detail
        "label": args.label, "generated_at": now, "memory_backend": run.rec["memory_backend"], "llm": run.rec["llm"],
        "metrics": metrics, "details": res}
    (C.GT_DIR / "eval_latest.json").write_text(json.dumps(out, indent=2))
    hist_p = C.GT_DIR / "eval_history.json"
    hist = json.loads(hist_p.read_text()) if hist_p.exists() else []
    hist.append({k: out[k] for k in ("label", "generated_at", "llm", "metrics")})
    hist_p.write_text(json.dumps(hist, indent=2))
    print(json.dumps(metrics, indent=2))
    if res["detection"]["missed"]:
        print("missed:", res["detection"]["missed"])
    if res["recommendations"]["issues"]:
        print("rec issues:", res["recommendations"]["issues"])
    print("weave:", llm.WEAVE_URL)


if __name__ == "__main__":
    main()
