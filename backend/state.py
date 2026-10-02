"""Latest investigation results, kept in memory and mirrored to disk so the API survives restarts."""
import json
import threading

from backend.config import CACHE_DIR

_PATH = CACHE_DIR / "state.json"


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.runs, self.events, self.patterns, self.reports = {}, {}, {}, {}
        if _PATH.exists():
            try:
                d = json.loads(_PATH.read_text())
                self.events, self.patterns, self.reports = d["events"], d["patterns"], d["reports"]
                self.runs = {k: {**v, "status": v.get("status", "done")} for k, v in d.get("runs", {}).items()}
            except (json.JSONDecodeError, KeyError):
                pass

    def save(self):
        with self.lock:
            _PATH.write_text(json.dumps({"events": self.events, "patterns": self.patterns,
                                         "reports": self.reports, "runs": self.runs}))


STATE = State()
