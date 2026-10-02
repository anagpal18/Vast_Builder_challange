#!/usr/bin/env bash
# One-shot setup on a fresh VM (Ubuntu/Debian or macOS). Idempotent: re-run after every `git pull`.
#   WITH_YOLO=1 scripts/setup.sh   # also install ultralytics (real footage, GPU if available)
#   SKIP_TESTS=1 scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
WITH_YOLO="${WITH_YOLO:-0}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# --- system packages ---------------------------------------------------------
need=()
command -v ffmpeg >/dev/null || need+=(ffmpeg)
command -v curl >/dev/null || need+=(curl)
[ "$WITH_YOLO" = "1" ] && need+=(libgl1 libglib2.0-0)
if [ ${#need[@]} -gt 0 ]; then
  if command -v apt-get >/dev/null; then
    say "installing system packages: ${need[*]}"
    $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
  elif command -v brew >/dev/null; then
    brew install ffmpeg
  else
    echo "please install: ${need[*]}" >&2; exit 1
  fi
fi

# --- python env (uv manages Python 3.11) ---------------------------------------
if ! command -v uv >/dev/null; then
  say "installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
[ -x .venv/bin/python ] || { say "creating .venv (Python 3.11)"; uv venv --python 3.11 --python-preference only-managed .venv; }
REQ=requirements.txt; [ "$WITH_YOLO" = "1" ] && REQ=requirements-yolo.txt
say "installing $REQ"
uv pip install --python .venv/bin/python -q -r "$REQ"

# --- secrets -------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env; chmod 600 .env
  say "created .env from .env.example: add WANDB_API_KEY (agents fall back to templates without it)"
fi
grep -q '^WANDB_API_KEY=.\+' .env || echo "   note: WANDB_API_KEY is empty in .env"

# --- data ----------------------------------------------------------------------
say "preparing data (simulated footage/tracks/ground truth; YOLO for real footage)"
.venv/bin/python -m backend.precompute

# --- tests ---------------------------------------------------------------------
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  say "running tests"
  .venv/bin/pytest -q -p no:warnings
fi
say "done. start with: scripts/run.sh   (or: make service)"
