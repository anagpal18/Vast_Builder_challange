"""Client for the team's VSS retrieval backend (vast-builders-challenge `.cursor/skills/retrieval/*`).

Base = INGRESS_URL, API prefix /api/v1, JWT from POST /auth/login (re-login on 401).
Response shapes come from the skills docs; accessors below are tolerant on purpose.
"""
import logging
import shutil
import threading
import time
from pathlib import Path

import httpx

from backend import config as C

log = logging.getLogger("almost.vss")


class VSSError(RuntimeError):
    pass


class VSS:
    def __init__(self, base=None, username=None, password=None, timeout=60):
        self.base = (base or C.VSS_URL).rstrip("/")
        self.username = username or C.VSS_USERNAME
        self.password = password or C.VSS_PASSWORD
        self._token = None
        self._lock = threading.Lock()
        self.http = httpx.Client(timeout=timeout, follow_redirects=True)

    @property
    def configured(self):
        return bool(self.base and self.username and self.password)

    # --- auth -------------------------------------------------------------------------------
    def login(self):
        if not self.configured:
            raise VSSError("VSS not configured: need INGRESS_URL, USERNAME, PASSWORD (/config/<team>.config)")
        r = self.http.post(f"{self.base}/api/v1/auth/login",
                           json={"username": self.username, "password": self.password})
        if r.status_code != 200:
            raise VSSError(f"login failed: HTTP {r.status_code} {r.text[:200]}")
        self._token = r.json()["access_token"]
        return self._token

    @property
    def token(self):
        with self._lock:
            return self._token or self.login()

    RETRY_STATUS = {502, 503, 504, 520, 522, 524, 530}  # gateway / tunnel hiccups

    def _req(self, method, path, retries=5, **kw):
        relogged = False
        for attempt in range(retries):
            try:
                r = self.http.request(method, f"{self.base}/api/v1{path}",
                                      headers={"Authorization": f"Bearer {self.token}"}, **kw)
            except httpx.TransportError as e:
                if attempt == retries - 1:
                    raise VSSError(f"{method} {path}: {type(e).__name__}: {e}") from e
                time.sleep(min(30, 2 ** attempt))
                continue
            if r.status_code == 401 and not relogged:
                relogged = True
                with self._lock:
                    self._token = None
                continue
            if r.status_code in self.RETRY_STATUS and attempt < retries - 1:
                log.warning("%s %s: HTTP %s, retrying", method, path, r.status_code)
                time.sleep(min(30, 2 ** attempt))
                continue
            if r.status_code >= 400:
                raise VSSError(f"{method} {path}: HTTP {r.status_code} {r.text[:200]}")
            return r.json()

    def get(self, path, **params):
        return self._req("GET", path, params={k: v for k, v in params.items() if v is not None})

    def post(self, path, body):
        return self._req("POST", path, json=body)

    # --- retrieval --------------------------------------------------------------------------
    def me(self):
        return self.get("/auth/me")

    def search(self, query, top_k=15, min_similarity=0.3, metadata_filters=None, llm_top_n=1, retries=5, **extra):
        body = {"query": query, "top_k": top_k, "min_similarity": min_similarity, "llm_top_n": max(1, llm_top_n),
                "metadata_filters": metadata_filters or {}, "include_public": True, **extra}
        from backend import replay
        return replay.call("vss_search", [self.username, body],
                           lambda: self._req("POST", "/search", retries=retries, json=body))

    def schema(self):
        return self.get("/metadata/schema")

    def values(self, field, prefix=None, limit=100):
        return self.get("/metadata/values", field=field, prefix=prefix, limit=limit)

    def dashboard(self, scope="all"):
        return self.get("/dashboard/stats", scope=scope)

    def explore(self, limit=48, offset=0, location=None, date=None, scope="all"):
        return self.get("/videos/explore", scope=scope, limit=limit, offset=offset, location=location, date=date)

    def segments(self, original_video):
        return self.get("/tools/segments", original_video=original_video)

    def segment(self, source):
        return self.get("/videos/metadata", source=source)

    def detections(self, source):
        try:
            return self.get("/videos/detections", source=source)
        except VSSError as e:
            if "HTTP 404" in str(e):
                return None  # no YOLO sidecar for this segment
            raise

    def stream_url(self, source):
        """Browser-playable URL (the JWT rides in ?token= because <video> can't send headers)."""
        return str(httpx.URL(f"{self.base}/api/v1/videos/stream", params={"source": source, "token": self.token}))

    def download(self, source, dest: Path):
        """Stream one segment (s3://...) to a local file."""
        dest = Path(dest)
        if dest.exists() and dest.stat().st_size > 0:
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        for attempt in range(5):
            try:
                with self.http.stream("GET", f"{self.base}/api/v1/videos/stream",
                                      params={"source": source, "token": self.token}, timeout=300) as r:
                    if r.status_code in self.RETRY_STATUS or r.status_code == 401:
                        if r.status_code == 401:
                            with self._lock:
                                self._token = None
                        raise httpx.TransportError(f"HTTP {r.status_code}")
                    if r.status_code >= 400:
                        raise VSSError(f"stream {source}: HTTP {r.status_code}")
                    expected = int(r.headers.get("content-length") or 0)
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_bytes(1 << 20):
                            f.write(chunk)
                if expected and tmp.stat().st_size != expected:
                    raise httpx.TransportError(f"short read {tmp.stat().st_size}/{expected}")
                shutil.move(tmp, dest)
                return dest
            except httpx.TransportError as e:  # includes RemoteProtocolError (cut-off body)
                log.warning("download %s attempt %d failed: %s", Path(source).name, attempt + 1, e)
                if attempt == 4:
                    raise VSSError(f"stream {source}: {e}") from e
                time.sleep(min(30, 2 ** attempt))


def rows(resp, *keys):
    """First list found under any of `keys` (or the response itself if it is a list)."""
    if isinstance(resp, list):
        return resp
    for k in keys:
        v = resp.get(k) if isinstance(resp, dict) else None
        if isinstance(v, list):
            return v
    return []


def pick(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return default


_CLIENT = None


def client():
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = VSS()
    return _CLIENT
