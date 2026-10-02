"""Core math + validators + API smoke. Run: .venv/bin/pytest -q"""
import numpy as np
import pytest

from backend.perception.conflicts import analyze_pair, score, severity
from backend.perception.summarize import Track, movement_for


def straight(tid, cls, p0, p1, speed, t0, movement):
    p0, p1 = np.array(p0, float), np.array(p1, float)
    L = np.linalg.norm(p1 - p0)
    t = np.round(np.arange(t0, t0 + L / speed, 0.1), 3)
    d = (p1 - p0) / L
    xy = p0 + np.outer((t - t0) * speed, d)
    tr = Track("CAM_T", tid, cls, t, xy[:, 0], xy[:, 1], np.full(len(t), d[0] * speed), np.full(len(t), d[1] * speed))
    tr.summary = {"movement": movement}
    return tr


def test_movement_lookup():
    assert movement_for("S", "N") == "through"
    assert movement_for("S", "E") == "right_turn"
    assert movement_for("S", "W") == "left_turn"
    assert movement_for("E", "N") == "right_turn"
    assert movement_for("N", "N") == "u_turn"
    assert movement_for(None, "N") == "unknown"


def test_pet_ped_first():
    # pedestrian crosses x=0 line at t=10; car passes (0,0) at t=11.5 → PET ≈ 1.5 - occupancy margins
    ped = straight(1, "person", (0, -7), (0, 7), 1.4, 5.0, "crossing")
    car = straight(2, "car", (-60, 0), (60, 0), 10.0, 5.5, "through")
    m = analyze_pair(ped, car)
    assert m["a"].cls == "car" and m["b"].cls == "person"
    assert m["first_through"] == "b"
    assert 0.0 < m["pet_s"] < 1.5
    assert m["conflict_type"] == "ped_vs_through"
    assert abs(m["P"][0]) < 0.2 and abs(m["P"][1]) < 0.2


def test_far_apart_not_candidate():
    ped = straight(1, "person", (0, -7), (0, 7), 1.4, 5.0, "crossing")
    car = straight(2, "car", (-60, 0), (60, 0), 10.0, 20.0, "through")
    assert analyze_pair(ped, car) is None or not analyze_pair(ped, car)["candidate"]


def test_parked_vehicle_ignored():
    ped = straight(1, "person", (0, -7), (0, 7), 1.4, 5.0, "crossing")
    van = straight(2, "truck", (0, 0), (0.05, 0), 0.01, 0.0, "unknown")
    assert analyze_pair(ped, van) is None


def test_score_and_severity():
    assert severity(0.5) == "severe" and severity(1.5) == "moderate" and severity(2.5) == "low"
    assert score(0.0, 0.0, True) == pytest.approx(1.0)
    assert score(3.0, None, False) == 0.0


def test_recommend_validator_rejects_non_catalog_and_bad_citations():
    from backend.agents.recommend import catalog_by_id, validate
    p = {"pattern_id": "P", "event_ids": ["EV_X_0001", "EV_X_0002"], "conflict_type": "ped_vs_right_turn"}
    recs = [{"countermeasure_id": "made_up", "why": "x", "cited_event_ids": ["EV_X_0001"]},
            {"countermeasure_id": "bicycle_lanes", "why": "x", "cited_event_ids": ["EV_X_0001"]},   # retired
            {"countermeasure_id": "lighting", "why": "x", "cited_event_ids": ["EV_Y_0009"]},        # outside pattern
            {"countermeasure_id": "leading_pedestrian_interval", "why": "see EV_X_0002",
             "cited_event_ids": ["EV_X_0001"], "name": "WRONG", "url": "http://evil"}]
    good, notes = validate(recs, p, catalog_by_id())
    assert [g["countermeasure_id"] for g in good] == ["leading_pedestrian_interval"]
    cat = catalog_by_id()["leading_pedestrian_interval"]
    assert good[0]["url"] == cat["url"] and good[0]["name"] == cat["name"]
    assert set(good[0]["cited_event_ids"]) == {"EV_X_0001", "EV_X_0002"}
    assert len(notes) == 3


def test_numbers_check():
    from backend.agents.patterns import _numbers_ok
    assert _numbers_ok("3 events, worst PET 0.8 s (EV_A1_0231)", "count 3 PET 0.8")
    assert not _numbers_ok("seven events", "count 3 PET 0.8")
    assert not _numbers_ok("PET 0.4 s", "count 3 PET 0.8")


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from backend.config import TRACKS_DIR
    if not list(TRACKS_DIR.glob("*.parquet")):
        pytest.skip("no tracks: run python -m backend.synth.make_all")
    from backend.main import app
    with TestClient(app) as c:
        yield c


def test_api_end_to_end(client, monkeypatch):
    import time
    from backend.agents import llm
    monkeypatch.setattr(llm, "_client", None)  # templates: deterministic, offline
    assert client.get("/health").json()["ok"]
    with client.websocket_connect("/ws") as ws:
        rid = client.post("/investigate", json={"site_ids": ["SITE_A"]}).json()["run_id"]
        types = set()
        while True:
            m = ws.receive_json()
            types.add(m["type"])
            if m["type"] == "run.done":
                break
    assert {"run.stage", "run.candidate", "run.verified", "run.pattern", "run.recommendation"} <= types
    assert client.get(f"/runs/{rid}").json()["status"] == "done"
    evs = client.get("/events?site_id=SITE_A&status=verified").json()
    assert evs
    e = client.get(f"/events/{evs[0]['event_id']}").json()
    assert e["overlay"]["a"] and e["overlay"]["b"]
    w = client.get(f"/events/{evs[0]['event_id']}/whatif").json()
    assert len(w["gap_curve"]) == 121 and w["disclaimer"]
    pats = client.get("/patterns?site_id=SITE_A").json()
    assert pats and pats[0]["recommendations"]
    assert all(r["url"].startswith("https://highways.dot.gov/") for r in pats[0]["recommendations"])
    md = client.get("/report/SITE_A.md").text
    assert "traffic engineer review" in md
