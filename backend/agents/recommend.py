"""Recommendation agent: FHWA Proven Safety Countermeasures ONLY, validated (SHRESTH 2.3, MASTER 7)."""
import json
import logging
import threading

from backend import config as C
from backend.agents import llm
from backend.agents.patterns import COLLISION_RE, EV_RE, _event_lines
from backend.agents.prompts import RECOMMEND_SYSTEM, RECOMMEND_USER

log = logging.getLogger("almost.recommend")
CATALOG_PATH = C.CONFIG_DIR / "fhwa_countermeasures.json"
URL_STATUS = {}


def load_catalog(active_only=True):
    cat = json.loads(CATALOG_PATH.read_text())
    return [c for c in cat if c.get("active", True) or not active_only]


def catalog_by_id():
    return {c["id"]: c for c in load_catalog(active_only=False)}


def check_catalog_urls():
    """Startup check (runs in a thread). FHWA's CDN answers scripted clients with 403, so 403 is logged as
    'blocked', not 'missing'; 404 means a wrong slug."""
    import httpx

    def run():
        with httpx.Client(follow_redirects=True, timeout=10,
                          headers={"User-Agent": "Mozilla/5.0 (Macintosh) AlmostCatalogCheck"}) as cl:
            for c in load_catalog(active_only=False):
                try:
                    code = cl.get(c["url"]).status_code
                except Exception as e:
                    code = f"error: {type(e).__name__}"
                URL_STATUS[c["id"]] = code
                if code != 200:
                    level = log.info if code == 403 else log.warning
                    level("catalog url %s → %s %s", c["id"], code,
                          "(CDN blocks bots; open in a browser to confirm)" if code == 403 else "")
    threading.Thread(target=run, daemon=True).start()


def condition_keys(pattern):
    f = pattern.get("facts", {})
    keys = {pattern["conflict_type"]}
    if f.get("night"):
        keys.add("night")
    if f.get("visibility_issue"):
        keys.add("visibility_issue")
    if f.get("speeding"):
        keys.add("high_speed")
    if f.get("red_light"):
        keys.add("red_light")
    return keys


def candidates_for(pattern, events=None):
    """Catalog entries for the pattern's conflict type and conditions; if none targets this exact conflict,
    a broad match on the road users involved (still catalog-only, flagged as broad in the result)."""
    keys = condition_keys(pattern)
    exact = [c for c in load_catalog() if keys & set(c["addresses"])]
    if any(pattern["conflict_type"] in c["addresses"] for c in exact):
        return exact
    users = {e["b"]["cls"] for e in (events or [])} | {e["a"]["cls"] for e in (events or [])}
    broad = set()
    if "person" in users or pattern["conflict_type"].startswith("ped"):
        broad |= {"ped_vs_through", "ped_vs_right_turn"}
    if "bicycle" in users or pattern["conflict_type"].startswith("bike"):
        broad |= {"veh_angle", "ped_vs_right_turn"}  # turn lanes separate turning cars; crosswalk visibility
    if not broad:
        broad |= {"veh_angle"}
    fallback = [c for c in load_catalog() if broad & set(c["addresses"]) and c not in exact]
    for c in fallback:
        c["_broad"] = True
    return exact + fallback


def _facts_text(p):
    f = p["facts"]
    lines = [f"- {f['count']} verified events; worst PET {p['worst_pet_s']} s; median PET {p['median_pet_s']} s"]
    if p["conflict_type"].startswith(("ped", "bike")):
        lines.append(f"- vulnerable road user went through first in {f['b_first']} of {f['count']}")
    if f["night"]:
        lines.append(f"- {f['night']} of {f['count']} at night")
    if f.get("visibility_issue"):
        lines.append(f"- visibility issue in {f['visibility_issue']} of {f['count']}")
    if f["speeding"]:
        lines.append(f"- vehicle above the {f['speed_limit_mph']} mph limit in {f['speeding']} of {f['count']} (max {f['max_speed_mph']} mph)")
    for k, v in f.get("factors", {}).items():
        lines.append(f"- '{k}' in {v} of {f['count']}")
    return "\n".join(lines)


def _template(pattern, events, cands):
    """Deterministic pick: conflict-type mapping first, then condition-driven ones."""
    f, ids = pattern["facts"], pattern["event_ids"]
    primary = [c for c in cands if pattern["conflict_type"] in c["addresses"]] or [c for c in cands if c.get("_broad")]
    secondary = [c for c in cands if c not in primary]
    picks = (primary[:2] + secondary[:1]) if secondary else primary[:3]
    out = []
    for c in picks:
        if "night" in c["addresses"] or "visibility_issue" in c["addresses"]:
            cited = [e["event_id"] for e in events if (e.get("verification") or {}).get("conditions", {}).get("lighting") == "night"
                     or (e.get("verification") or {}).get("conditions", {}).get("visibility_issue")]
            why = f"{len(cited)} of {f['count']} events happened at night or with a visibility issue."
        elif c["id"] == "leading_pedestrian_interval":
            cited = [e["event_id"] for e in events if e["first_through"] == "b"] or ids
            why = (f"In {f['b_first']} of {f['count']} events the pedestrian had already started crossing "
                   f"when the turning vehicle arrived.")
        elif "high_speed" in c["addresses"]:
            cited = ids
            why = f"Vehicles exceeded the {f['speed_limit_mph']} mph limit in {f['speeding']} of {f['count']} events."
        else:
            cited = ids
            why = (f"{f['count']} {pattern['conflict_type'].replace('_', ' ')} close calls, worst margin "
                   f"{pattern['worst_pet_s']} s; this countermeasure targets that conflict.")
        out.append({"countermeasure_id": c["id"], "why": why, "cited_event_ids": cited})
    return out


def validate(recs, pattern, cats, events=()):
    """Keep only catalog ids with citations inside the pattern; name + url always copied from the catalog."""
    ids, good, notes = set(pattern["event_ids"]), [], []
    crash_ids = {e["event_id"] for e in events if e["pet_s"] == 0}
    for r in recs:
        if len(good) == 3:
            break
        cid = r.get("countermeasure_id")
        c = cats.get(cid)
        cited = list(dict.fromkeys((r.get("cited_event_ids") or []) + EV_RE.findall(r.get("why", ""))))
        if not c or not c.get("active", True):
            notes.append(f"dropped {cid}: not an active catalog entry"); continue
        if not cited or not set(cited) <= ids:
            notes.append(f"dropped {cid}: citations outside pattern"); continue
        if any(g["countermeasure_id"] == cid for g in good):
            continue
        if COLLISION_RE.search(r.get("why", "")) and not crash_ids & set(cited):
            notes.append(f"dropped {cid}: describes a collision for near-miss events"); continue
        good.append({"countermeasure_id": cid, "name": c["name"], "source": "FHWA Proven Safety Countermeasures",
                     "url": c["url"], "focus_area": c.get("focus_area"), "why": r.get("why", "").strip(),
                     "cited_event_ids": cited, "review_note": C.REVIEW_NOTE})
    return good, notes


@llm.op(name="recommend.agent")
def recommend(pattern, events, site):
    cands = candidates_for(pattern, events)
    cats = catalog_by_id()
    broad_ids = {c["id"] for c in cands if c.get("_broad")}
    if not cands:
        return [], "no active FHWA catalog entry addresses this conflict type"
    allowed = {c["id"]: c for c in cands}
    recs, gen, notes = None, "template", []
    if llm.enabled():
        user = RECOMMEND_USER.format(
            pattern_id=pattern["pattern_id"], site_name=site["name"], signature=pattern["signature"],
            summary=pattern["summary"], facts=_facts_text(pattern), events=_event_lines(events),
            candidates="\n".join(f'- id "{c["id"]}": {c["name"]}. {c["summary_in_our_words"]}' for c in cands))
        try:
            out = llm.chat_json(RECOMMEND_SYSTEM, user)
            raw = out.get("recommendations") or []
            raw = [r for r in raw if r.get("countermeasure_id") in allowed] or []
            recs, notes = validate(raw, pattern, cats, events)
            gen = C.LLM_MODEL if recs else "template"
        except Exception as e:
            notes = [f"llm error: {e}"]
    if not recs:
        recs, more = validate(_template(pattern, events, cands), pattern, cats, events)
        notes += more
    for r in recs:
        r["generated_by"] = gen
        if r["countermeasure_id"] in broad_ids:
            r["match"] = "broad"
            r["review_note"] = ("Broad match on the road users involved: no FHWA catalog entry targets this exact "
                                "conflict type. " + r["review_note"])
        else:
            r["match"] = "exact"
    if notes:
        log.info("recommend %s: %s", pattern["pattern_id"], "; ".join(notes))
    return recs, "; ".join(notes) or None
