#!/usr/bin/env python3
"""Read-only probe of the team's VAST Builders stack, run ON THE WORKSHOP VM. Stdlib only, no setup needed.

    python3 scripts/vm_smoke.py > smoke.json && cat smoke.json

Prints one JSON report (never passwords or tokens): which credentials exist, VSS login, metadata values,
dashboard stats, sample explore / segments / detections / search rows (truncated), GPU model health, and
whether kubectl can deploy into the team namespace. Paste the output back.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPORT = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": {}}
SECRET_WORDS = ("PASSWORD", "SECRET", "KEY", "TOKEN")


def load_team_config():
    files = sorted(glob.glob("/config/*.config"))
    env = {}
    if len(files) == 1:
        for line in open(files[0]):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in env.items():
        os.environ.setdefault(k, v)
    REPORT["config_files"] = sorted(glob.glob("/config/*"))
    REPORT["team_config"] = files[0] if len(files) == 1 else f"expected 1 /config/*.config, found {len(files)}"
    keys = sorted(set(env) | {k for k in os.environ if k.startswith(("VSS", "S3_", "VDB", "VAST", "COSMOS", "YOLO",
                                                                         "CANARY", "GPU", "WANDB", "INGRESS"))})
    REPORT["vars"] = {k: ("<set>" if any(w in k for w in SECRET_WORDS) else os.environ.get(k)) if os.environ.get(k)
                      else None for k in keys}


def trunc(x, n=3, depth=0):
    """Keep the shape, drop the bulk."""
    if isinstance(x, list):
        return [trunc(v, n, depth + 1) for v in x[:n]] + ([f"...(+{len(x) - n})"] if len(x) > n else [])
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k in ("vectors", "vectors_visual", "access_token", "token"):
                out[k] = "<omitted>"
            else:
                out[k] = trunc(v, n, depth + 1)
        return out
    if isinstance(x, str) and len(x) > 300:
        return x[:300] + "..."
    return x


def http(method, url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, raw[:300].decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - we want every failure in the report
        return None, f"{type(e).__name__}: {e}"


def step(name, fn):
    t = time.time()
    try:
        REPORT["steps"][name] = {"ok": True, **fn()}
    except Exception as e:  # noqa: BLE001
        REPORT["steps"][name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    REPORT["steps"][name]["s"] = round(time.time() - t, 2)


def main():
    load_team_config()
    base = (os.environ.get("INGRESS_URL") or "").rstrip("/")
    user, pw = os.environ.get("USERNAME"), os.environ.get("PASSWORD")
    ctx = {}

    def login():
        code, r = http("POST", f"{base}/api/v1/auth/login", {"username": user, "password": pw})
        if code != 200:
            raise RuntimeError(f"HTTP {code}: {r}")
        ctx["H"] = {"Authorization": f"Bearer {r['access_token']}"}
        ctx["token"] = r["access_token"]
        return {"username": r.get("username")}

    def get(path, **params):
        q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        code, r = http("GET", f"{base}/api/v1{path}" + (f"?{q}" if q else ""), headers=ctx["H"])
        if code != 200:
            raise RuntimeError(f"GET {path} HTTP {code}: {r}")
        return r

    def post(path, body):
        code, r = http("POST", f"{base}/api/v1{path}", body, headers=ctx["H"], timeout=120)
        if code != 200:
            raise RuntimeError(f"POST {path} HTTP {code}: {r}")
        return r

    step("vss_login", login)
    if "H" in ctx:
        step("metadata_schema", lambda: {"schema": [{k: s.get(k) for k in ("name", "type", "ui_type", "options")}
                                                    for s in get("/metadata/schema").get("schema", [])]})
        for f in ("camera_id", "location", "capture_type"):
            step(f"values_{f}", lambda f=f: {"r": get("/metadata/values", field=f, limit=100)})
        step("dashboard", lambda: {"r": trunc({k: v for k, v in get("/dashboard/stats").items()
                                                if k in ("overview", "quality", "objects", "metadata",
                                                         "pipeline_alignment", "recent_videos")}, 8)})

        def explore():
            r = get("/videos/explore", scope="all", limit=12)
            ctx["explore"] = r
            return {"r": trunc(r, 4)}
        step("explore", explore)

        def first_video():
            r = ctx.get("explore") or {}
            items = r if isinstance(r, list) else next((v for v in r.values() if isinstance(v, list)), [])
            for it in items:
                ov = it.get("original_video") if isinstance(it, dict) else None
                if ov:
                    return ov
            return None

        def segs():
            ov = first_video()
            if not ov:
                raise RuntimeError("no original_video in explore")
            r = get("/tools/segments", original_video=ov)
            ctx["segs"] = r
            return {"original_video": ov, "r": trunc(r, 3)}
        step("segments", segs)

        def first_source():
            r = ctx.get("segs") or {}
            items = r if isinstance(r, list) else next((v for v in r.values() if isinstance(v, list)), [])
            for it in items:
                if isinstance(it, dict) and it.get("source"):
                    return it["source"]
            return None

        step("segment_metadata", lambda: {"r": trunc(get("/videos/metadata", source=first_source()), 3)})
        step("detections", lambda: {"r": trunc(get("/videos/detections", source=first_source()), 3)})

        def stream():
            src = first_source()
            url = f"{base}/api/v1/videos/stream?" + urllib.parse.urlencode({"source": src, "token": ctx["token"]})
            req = urllib.request.Request(url, headers={"Range": "bytes=0-1023"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return {"status": r.status, "content_type": r.headers.get("Content-Type"),
                        "content_range": r.headers.get("Content-Range"), "bytes": len(r.read())}
        step("stream", stream)
        for q in ("person close to a moving vehicle", "pedestrian crossing in front of a turning car"):
            step(f"search::{q}", lambda q=q: {"r": trunc(post("/search", {"query": q, "top_k": 5, "llm_top_n": 1,
                                                                           "min_similarity": 0.2}), 3)})

    gpu = os.environ.get("GPU_HOST", "166.19.38.112")
    auth = {"Authorization": f"Bearer {os.environ.get('GPU_BEARER_TOKEN', '')}"}
    urls = {"cosmos": os.environ.get("COSMOS3_REASON_URL") or f"http://{gpu}:8001",
            "yolo": os.environ.get("YOLO_URL") or f"http://{gpu}:8002",
            "embed": os.environ.get("COSMOS_EMBED1_URL") or f"http://{gpu}:8003"}
    REPORT["gpu_urls"] = urls
    step("gpu_cosmos_models", lambda: dict(zip(("code", "r"), http("GET", urls["cosmos"] + "/v1/models", headers=auth))))
    step("gpu_embed_models", lambda: dict(zip(("code", "r"), http("GET", urls["embed"] + "/v1/models", headers=auth))))
    step("gpu_yolo_healthz", lambda: dict(zip(("code", "r"), http("GET", urls["yolo"] + "/healthz", headers=auth))))

    def kube():
        kc = next((p for p in ("/config/kubeconfig", *glob.glob("/config/*k8s*.yaml")) if os.path.exists(p)), None)
        if not kc or not shutil.which("kubectl"):
            return {"kubeconfig": kc, "kubectl": shutil.which("kubectl")}
        env = {**os.environ, "KUBECONFIG": kc}
        ns = os.environ.get("USERNAME", "")

        def k(*a):
            p = subprocess.run(["kubectl", *a], env=env, capture_output=True, text=True, timeout=30)
            return (p.stdout or p.stderr).strip()[:1500]
        return {"kubeconfig": kc, "namespace": ns,
                "can_create_deploy": k("auth", "can-i", "create", "deployments", "-n", ns),
                "can_create_ingress": k("auth", "can-i", "create", "ingresses", "-n", ns),
                "ingresses": k("get", "ingress", "-n", ns, "-o", "wide"),
                "pods": k("get", "pods", "-n", ns),
                "storageclasses": k("get", "storageclass")}
    step("kubernetes", kube)
    REPORT["tools"] = {t: shutil.which(t) for t in ("python3", "git", "ffmpeg", "docker", "kubectl", "node", "uv")}
    print(json.dumps(REPORT, indent=1, default=str))


if __name__ == "__main__":
    sys.exit(main())
