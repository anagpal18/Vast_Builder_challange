"""Shared NVIDIA GPU models on CoreWeave (vast-builders-challenge `.cursor/skills/gpu/`).

Cosmos3-Reason :8001 (OpenAI chat, video_url content) · YOLO11 :8002 (/v1/infer) · Cosmos Embed1 :8003 (256-d).
Bearer = GPU_BEARER_TOKEN from /config/<team>.config. Model ids are discovered, never hardcoded.
"""
import base64
import json
import logging
import re
from functools import lru_cache
from pathlib import Path

import httpx

from backend import config as C

log = logging.getLogger("almost.gpu")


def _h():
    return {"Authorization": f"Bearer {C.GPU_BEARER_TOKEN}"} if C.GPU_BEARER_TOKEN else {}


def available():
    return bool(C.GPU_BEARER_TOKEN)


@lru_cache(maxsize=None)
def model_id(base):
    r = httpx.get(f"{base}/v1/models", headers=_h(), timeout=15)
    r.raise_for_status()
    return r.json()["data"][0]["id"]


def health():
    out = {}
    for name, url, path in (("cosmos3_reason", C.COSMOS3_REASON_URL, "/v1/models"),
                            ("yolo", C.YOLO_URL, "/healthz"), ("embed1", C.COSMOS_EMBED1_URL, "/v1/models")):
        try:
            r = httpx.get(url + path, headers=_h(), timeout=10)
            out[name] = r.status_code
        except Exception as e:
            out[name] = type(e).__name__
    return out


def _json_from(text):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise ValueError(f"no JSON in model output: {text[:200]}")
    return json.loads(m.group(0))


def cosmos_video_json(prompt, video_path: Path, max_tokens=900, timeout=180):
    """Ask Cosmos3-Reason about a clip; returns parsed JSON."""
    b64 = base64.b64encode(Path(video_path).read_bytes()).decode()
    body = {"model": model_id(C.COSMOS3_REASON_URL), "max_tokens": max_tokens, "temperature": 0.1,
            "messages": [{"role": "user", "content": [
                {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
                {"type": "text", "text": prompt}]}]}
    r = httpx.post(f"{C.COSMOS3_REASON_URL}/v1/chat/completions", json=body, headers=_h(), timeout=timeout)
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    return _json_from(msg.get("content") or msg.get("reasoning_content") or "")


def embed_text(texts):
    """Cosmos Embed1 text vectors (256-d), one per input."""
    texts = [texts] if isinstance(texts, str) else list(texts)
    body = {"model": model_id(C.COSMOS_EMBED1_URL), "input": texts, "request_type": "query",
            "encoding_format": "float"}
    r = httpx.post(f"{C.COSMOS_EMBED1_URL}/v1/embeddings", json=body, headers=_h(), timeout=60)
    r.raise_for_status()
    return [d["embedding"] for d in r.json()["data"]]


def yolo_infer(video_path: Path, timeout=300):
    """YOLO11 over a whole clip: {perception_ok, object_classes, object_counts, frames: [...]}."""
    b64 = base64.b64encode(Path(video_path).read_bytes()).decode()
    r = httpx.post(f"{C.YOLO_URL}/v1/infer", headers=_h(), timeout=timeout,
                   json={"video_base64": b64, "filename": Path(video_path).name, "include_frames": True})
    r.raise_for_status()
    return r.json()
