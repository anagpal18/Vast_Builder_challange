"""Pattern agent: deterministic grouping + W&B model writes the signature/summary, validated (SHRESTH 2.2)."""
import logging
import re
import statistics
from collections import defaultdict

from backend import config as C
from backend.agents import llm
from backend.agents.prompts import PATTERN_SYSTEM, PATTERN_USER

log = logging.getLogger("almost.patterns")
EV_RE = re.compile(r"EV_[A-Z0-9]+_\d{4}(?:_\d+)?")
MPS_PER_MPH = 0.44704

MOVE_WORDS = {"right_turn": "right-turning", "left_turn": "left-turning", "through": "through",
              "u_turn": "U-turning", "unknown": "unclassified"}
B_WORDS = {"ped_vs_right_turn": "pedestrians", "ped_vs_left_turn": "pedestrians", "ped_vs_through": "pedestrians",
           "bike_vs_right_turn": "cyclists", "bike_vs_through": "cyclists",
           "veh_left_turn_vs_through": "oncoming through traffic", "veh_angle": "crossing traffic",
           "veh_rear_end": "vehicles ahead", "other": "other road users"}
LEG_WORDS = {"N": "north", "S": "south", "E": "east", "W": "west"}


def facts_for(events, site):
    limit = site.get("speed_limit_mph", 25) * MPS_PER_MPH
    n = len(events)
    f = {
        "count": n,
        "night": sum(1 for e in events if (e.get("verification") or {}).get("conditions", {}).get("lighting") == "night"),
        "visibility_issue": sum(1 for e in events if (e.get("verification") or {}).get("conditions", {}).get("visibility_issue")),
        "speeding": sum(1 for e in events if e["a"].get("speed_mps", 0) > limit),
        "b_first": sum(1 for e in events if e.get("first_through") == "b"),
        "red_light": sum(1 for e in events if any("red" in x.lower() for x in (e.get("verification") or {}).get("contributing_factors", []))),
        "speed_limit_mph": site.get("speed_limit_mph"),
        "max_speed_mph": round(max(e["a"].get("speed_mps", 0) for e in events) / MPS_PER_MPH, 1),
    }
    factors = defaultdict(int)
    for e in events:
        for x in (e.get("verification") or {}).get("contributing_factors", []):
            factors[x] += 1
    f["factors"] = dict(factors)
    return f


def _event_lines(events):
    out = []
    for i, e in enumerate(sorted(events, key=lambda e: (e["camera_id"], e["t_conflict"])), 1):
        v = e.get("verification") or {}
        cond = v.get("conditions", {})
        out.append(f"{i}. {e['event_id']} camera {e['camera_id']} at t={e['t_conflict']:.1f}s: "
                   f"{e['a']['cls']} {e['a'].get('movement')} at {e['a'].get('speed_mps', 0):.1f} m/s vs "
                   f"{e['b']['cls']} {e['b'].get('movement')}; PET {e['pet_s']:.1f}s, "
                   f"first through: {'the ' + e['b']['cls'] if e['first_through'] == 'b' else 'the ' + e['a']['cls']}; "
                   f"lighting {cond.get('lighting', '?')}; factors: {', '.join(v.get('contributing_factors', [])) or 'none'}")
    return "\n".join(out)


def group_events(verified, similar_map=None, all_events=None):
    groups = defaultdict(list)
    key_of = {}
    for e in verified:
        k = (e["site_id"], e["conflict_type"], e["a"].get("movement"), e["a"].get("entry_leg"))
        groups[k].append(e)
        key_of[e["event_id"]] = k
    # VAST recall: a strongly similar verified event (same site + type) that ended up alone in its own
    # group (e.g. a different approach leg) joins the group of the event that recalled it.
    for e in verified:
        for s in (similar_map or {}).get(e["event_id"], []):
            oid = s["event_id"]
            if s["score"] <= C.SIMILAR_MERGE_SCORE or oid not in key_of:
                continue
            ok, k = key_of[oid], key_of[e["event_id"]]
            if ok == k or ok[:2] != k[:2] or len(groups[ok]) != 1:
                continue
            groups[k].append(groups.pop(ok)[0])
            key_of[oid] = k
    return {k: v for k, v in groups.items() if len(v) >= C.MIN_PATTERN_EVENTS}


def _template(key, events, facts, site):
    site_id, ctype, mv, leg = key
    ids = [e["event_id"] for e in events]
    sig = f"{MOVE_WORDS.get(mv, mv)} vehicles from the {LEG_WORDS.get(leg, leg or '?')} leg vs {B_WORDS.get(ctype, 'road users')}"
    worst = min(events, key=lambda e: e["pet_s"])
    parts = [f"{len(events)} verified close calls ({', '.join(ids)})."]
    parts.append(f"Closest margin {worst['pet_s']:.1f} s ({worst['event_id']}).")
    if facts["b_first"] and ctype.startswith(("ped", "bike")):
        cited = [e["event_id"] for e in events if e["first_through"] == "b"]
        parts.append(f"In {facts['b_first']} of {len(events)} the {B_WORDS[ctype].rstrip('s')} was already in the conflict area ({', '.join(cited)}).")
    if facts["night"]:
        cited = [e["event_id"] for e in events if (e.get("verification") or {}).get("conditions", {}).get("lighting") == "night"]
        parts.append(f"{facts['night']} at night ({', '.join(cited)}).")
    if facts["speeding"]:
        cited = [e["event_id"] for e in events if e["a"].get("speed_mps", 0) > site.get("speed_limit_mph", 25) * MPS_PER_MPH]
        parts.append(f"{facts['speeding']} with the vehicle above the {site.get('speed_limit_mph')} mph limit ({', '.join(cited)}).")
    return sig, " ".join(parts)


NUM_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
             "eight": "8", "nine": "9", "ten": "10", "all": None, "both": "2"}
COLLISION_RE = re.compile(r"\b(struck|strik\w*|hit|hits|hitting|collid\w*|collision|crash\w*|impact\w*)\b", re.I)


def _numbers_ok(text, source):
    allowed = set(re.findall(r"\d+(?:\.\d+)?", source))
    words = [NUM_WORDS[w.lower()] for w in re.findall(r"\b(" + "|".join(NUM_WORDS) + r")\b", text, re.I)
             if NUM_WORDS[w.lower()]]
    for n in words + re.findall(r"(?<![A-Z_\d])\d+(?:\.\d+)?", EV_RE.sub("", text)):
        if n not in allowed and str(float(n)).rstrip("0").rstrip(".") not in allowed:
            return False
    return True


@llm.op(name="pattern.write")
def write_pattern(key, events, facts, site, span_min):
    ids = {e["event_id"] for e in events}
    sig, summ = _template(key, events, facts, site)
    gen, problem = "template", None
    if llm.enabled():
        from backend.agents.recommend import _facts_text
        fake = {"facts": facts, "worst_pet_s": min(e["pet_s"] for e in events),
                "median_pet_s": statistics.median(e["pet_s"] for e in events), "conflict_type": key[1]}
        user = PATTERN_USER.format(site_name=site["name"], site_id=site["site_id"], speed_limit=site.get("speed_limit_mph"),
                                   conflict_type=key[1], movement=key[2], leg=key[3], span_min=span_min,
                                   facts=_facts_text(fake), events=_event_lines(events))
        crash = any(e["pet_s"] == 0 for e in events)
        for attempt in range(2):
            try:
                out = llm.chat_json(PATTERN_SYSTEM, user if attempt == 0 else
                                    user + f"\n\nYour previous answer was rejected: {problem}. Fix it.")
                s_sig, s_sum = str(out.get("signature", "")).strip(), str(out.get("summary", "")).strip()
                cited = set(EV_RE.findall(s_sum))
                if not s_sig or not s_sum:
                    problem = "empty signature or summary"
                elif not cited:
                    problem = "summary cites no event ids"
                elif not cited <= ids:
                    problem = f"cited ids outside the group: {sorted(cited - ids)}"
                elif len(s_sum.split()) > 75:
                    problem = "summary longer than 60 words"
                elif "_" in s_sig:
                    problem = "signature uses internal codes"
                elif not crash and COLLISION_RE.search(s_sum + " " + s_sig):
                    problem = "describes a collision but these are near misses"
                elif not _numbers_ok(s_sum + " " + s_sig, user + f" {len(events)}"):
                    problem = "uses a number not in the data"
                else:
                    sig, summ, gen, problem = s_sig, s_sum, C.LLM_MODEL, None
                    break
            except Exception as e:
                problem = f"llm error: {e}"
    if problem:
        log.warning("pattern %s fell back to template: %s", key, problem)
    return {"signature": sig, "summary": summ, "generated_by": gen, "validator_note": problem}


def _span_minutes(events):
    ts = [e["t_conflict"] for e in events]
    return max(1, round((max(ts) - min(ts)) / 60 + 0.5)) if ts else 0


@llm.op(name="pattern.agent")
def find_patterns(verified, sites_by_id, similar_map=None, all_events=None):
    groups = group_events(verified, similar_map, all_events)
    patterns, counters, jobs = [], defaultdict(int), []
    for key, evs in sorted(groups.items(), key=lambda kv: (kv[0][0], -len(kv[1]))):
        counters[key[0]] += 1
        jobs.append((f"PAT_{key[0].removeprefix('SITE_')}_{counters[key[0]]:02d}", key, evs,
                     facts_for(evs, sites_by_id[key[0]])))
    texts = llm.pmap(lambda j: write_pattern(j[1], j[2], j[3], sites_by_id[j[1][0]], _span_minutes(j[2])), jobs)
    for (pid, key, evs, facts), text in zip(jobs, texts):
        pets = [e["pet_s"] for e in evs]
        conds = defaultdict(int)
        for e in evs:
            conds[(e.get("verification") or {}).get("conditions", {}).get("lighting", "unknown")] += 1
        patterns.append({
            "pattern_id": pid, "site_id": key[0], "conflict_type": key[1],
            "movement": key[2], "entry_leg": key[3],
            "signature": text["signature"],
            "event_ids": [e["event_id"] for e in sorted(evs, key=lambda e: e["pet_s"])],
            "count": len(evs), "worst_pet_s": min(pets), "median_pet_s": round(statistics.median(pets), 2),
            "conditions": dict(conds), "facts": facts,
            "summary": text["summary"], "generated_by": text["generated_by"],
            "validator_note": text["validator_note"], "recommendations": [],
        })
    return patterns
