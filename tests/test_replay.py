"""Record/replay: a dropped connection is answered from the last identical successful call, with the recorded
latency capped at REPLAY_MAX_S."""
import time

import pytest

from backend import replay


@pytest.fixture
def rp(tmp_path, monkeypatch):
    monkeypatch.setattr(replay, "DIR", tmp_path)
    monkeypatch.setattr(replay, "MODE", "auto")
    monkeypatch.setattr(replay, "REPLAY_MAX_S", 0.3)
    replay._down.clear()
    return replay


def test_record_then_replay_on_failure(rp):
    def slow_ok():
        time.sleep(0.5)
        return {"verdict": "ACCEPT"}
    assert rp.call("svc", ["k"], slow_ok) == {"verdict": "ACCEPT"}

    def broken():
        raise ConnectionError("tunnel down")
    t = time.time()
    assert rp.call("svc", ["k"], broken) == {"verdict": "ACCEPT"}
    assert 0.25 <= time.time() - t < 0.5  # recorded 0.5 s, capped at 0.3 s
    # service now marked down: next call skips the live attempt entirely
    calls = []
    assert rp.call("svc", ["k"], lambda: calls.append(1)) == {"verdict": "ACCEPT"}
    assert not calls


def test_miss_raises_and_keys_differ(rp):
    rp.call("svc", ["a"], lambda: 1)
    with pytest.raises(ConnectionError):
        rp.call("svc", ["b"], lambda: (_ for _ in ()).throw(ConnectionError()))


def test_offline_mode_uses_recording_first(rp, monkeypatch):
    rp.call("svc", ["x"], lambda: "recorded")
    monkeypatch.setattr(rp, "MODE", "offline")
    assert rp.call("svc", ["x"], lambda: "live") == "recorded"
