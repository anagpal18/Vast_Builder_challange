"""Project-wide settings. Thresholds are OUR project choices (MASTER 4.6), not an official standard."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path=ROOT / ".env"):
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def _load_team_config():
    """On the workshop VM every team credential lives in /config/<team>.config (KEY=VALUE). .env wins."""
    cfg_dir = Path(os.environ.get("TEAM_CONFIG_DIR", "/config"))
    files = sorted(cfg_dir.glob("*.config")) if cfg_dir.is_dir() else []
    if len(files) == 1:
        _load_dotenv(files[0])
    return files[0] if len(files) == 1 else None


_load_dotenv()
TEAM_CONFIG = _load_team_config()
DATA = ROOT / "data"
CONFIG_DIR = DATA / "config"
FOOTAGE_DIR = DATA / "footage"
TRACKS_DIR = DATA / "tracks"
CLIPS_DIR = DATA / "clips"
THUMBS_DIR = DATA / "thumbs"
GT_DIR = DATA / "ground_truth"
CACHE_DIR = DATA / "cache"

for _d in (FOOTAGE_DIR, TRACKS_DIR, CLIPS_DIR, THUMBS_DIR, GT_DIR, CACHE_DIR, CONFIG_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- Perception --------------------------------------------------------------
YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolo11m.pt")
YOLO_CLASSES = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
MIN_TRACK_S = 1.0
SAVGOL_WINDOW = 9
SAVGOL_ORDER = 2
RESAMPLE_HZ = 10

VEHICLES = {"car", "motorcycle", "bus", "truck"}
VULNERABLE = {"person", "bicycle"}

# Occupancy radius in meters (SHRESTH 1.4)
RADIUS_M = {"person": 0.35, "bicycle": 0.8, "motorcycle": 0.8, "car": 2.3, "bus": 4.0, "truck": 4.0}
# Footprint (length, width) for WHAT-IF rectangles
DIMS_M = {"person": (0.5, 0.5), "bicycle": (1.8, 0.6), "motorcycle": (2.2, 0.8),
          "car": (4.5, 1.8), "bus": (12.0, 2.5), "truck": (8.0, 2.5)}

# --- Closeness math (MASTER 4.6) ----------------------------------------------
MIN_OVERLAP_S = 0.5
CLOSEST_APPROACH_M = 2.0
OCCUPANCY_MARGIN_M = 0.5
STATIONARY_SPEED_MPS = 1.0       # vehicles never faster than this are parked; ignored
PET_CANDIDATE_S = 3.0
# Uncalibrated (auto-calibrated) cameras: lanes are unknown and far-field depth is unreliable, so only pairs with
# a vulnerable road user are measured, and detections beyond this ground range are dropped.
UNCALIBRATED_VULNERABLE_ONLY = os.environ.get("UNCALIBRATED_VULNERABLE_ONLY", "1") == "1"
UNCALIBRATED_MAX_RANGE_M = float(os.environ.get("UNCALIBRATED_MAX_RANGE_M", "45"))
TTC_CANDIDATE_S = 2.0
# Physically plausible speed ceilings (m/s); faster readings are detection/depth noise
MAX_SPEED_MPS = {"person": 4.0, "bicycle": 14.0, "motorcycle": 40.0, "car": 40.0, "bus": 30.0, "truck": 35.0}
SEVERITY = [(1.0, "severe"), (2.0, "moderate"), (3.0, "low")]
CLIP_PAD_S = 6.0

# --- Investigation -------------------------------------------------------------
TOP_CANDIDATES_EMIT = 30
TOP_VERIFY = 15
MIN_VERIFY_PER_SITE = 4
SIMILAR_MERGE_SCORE = 0.8
MIN_PATTERN_EVENTS = 2

# --- WHAT-IF --------------------------------------------------------------------
WHATIF_RANGE_S = 3.0
WHATIF_STEP_S = 0.05
WHATIF_DISCLAIMER = "Simulation along observed paths only. Real crash dynamics differ."

REPORT_DISCLAIMER = ("Generated from simulated footage for demonstration. "
                     "Recommendations are for traffic engineer review.")
REVIEW_NOTE = "Suggested for traffic engineer review; not a verified design decision."

# --- W&B ------------------------------------------------------------------------
WANDB_API_KEY = os.environ.get("WANDB_API_KEY")
WANDB_ENTITY = os.environ.get("WANDB_ENTITY") or os.environ.get("WANDB_TEAM")
WANDB_PROJECT = os.environ.get("WANDB_PROJECT", "almost")
WANDB_BASE_URL = os.environ.get("WANDB_BASE_URL", "https://api.inference.wandb.ai/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B")  # text-only on W&B

LLM_THINKING = os.environ.get("LLM_THINKING", "0") == "1"  # Nemotron reasoning; can overrun the token budget
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "4096"))

# "mock" forces memory_mock; "auto" uses Kenil's memory/ package if importable
MEMORY_BACKEND = os.environ.get("MEMORY_BACKEND", "auto")
# Which cameras the app shows and investigates: real (VSS archive), sim (simulated sites), both.
# "auto" = real when the team VSS stack is configured, else sim. The Weave eval always uses the simulated sites.
_DM = os.environ.get("DATA_MODE", "auto")
CHECK_CATALOG_URLS = os.environ.get("CHECK_CATALOG_URLS", "1") == "1"

# --- VAST Builders stack (team VSS instance + shared GPU models), from /config/<team>.config --------
VSS_URL = (os.environ.get("VSS_URL") or os.environ.get("INGRESS_URL") or "").rstrip("/")
VSS_USERNAME = os.environ.get("VSS_USERNAME") or os.environ.get("USERNAME_VSS") or (
    os.environ.get("USERNAME") if os.environ.get("INGRESS_URL") else None)
VSS_PASSWORD = os.environ.get("VSS_PASSWORD") or (os.environ.get("PASSWORD") if os.environ.get("INGRESS_URL") else None)
GPU_HOST = os.environ.get("GPU_HOST", "166.19.38.112")
GPU_BEARER_TOKEN = os.environ.get("GPU_BEARER_TOKEN")
COSMOS3_REASON_URL = (os.environ.get("COSMOS3_REASON_URL") or f"http://{GPU_HOST}:8001").rstrip("/")
YOLO_URL = (os.environ.get("YOLO_URL") or f"http://{GPU_HOST}:8002").rstrip("/")
COSMOS_EMBED1_URL = (os.environ.get("COSMOS_EMBED1_URL") or f"http://{GPU_HOST}:8003").rstrip("/")

DATA_MODE = _DM if _DM in ("real", "sim", "both") else ("real" if VSS_URL else "sim")
