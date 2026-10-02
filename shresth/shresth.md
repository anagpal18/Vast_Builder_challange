# Cloudflare tunnel: reach team-28's VSS from Shresth's machine

The workshop VM (8 GB) is too slow for ingest + analysis, and the VSS archive is only reachable from inside the
VM. A Cloudflare quick tunnel on the VM relays the VSS API to a public URL, so the heavy work runs on
Shresth's machine instead.

## On the VM (no sudo, no Cloudflare account)

```bash
cd ~ && curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared
./cloudflared tunnel --no-autoupdate --protocol http2 --url http://video-lab-team-28.cosmos.vastdata.com --http-host-header video-lab-team-28.cosmos.vastdata.com
```

- After a few seconds it prints `https://<random-words>.trycloudflare.com`. Send that URL to Shresth.
- **Keep the terminal open.** The tunnel lives only while `cloudflared` runs. `Ctrl+C` stops it.
- Every restart gives a **new** URL; send the new one.
- If `curl` from GitHub is blocked, ask Shresth for another download route.

## Send separately (never commit, never post in a public channel)

- The tunnel URL.
- The VSS password: the `PASSWORD=` line in `/config/team-28.config` (username is `team-28`).

## On Shresth's machine

Add to the gitignored `.env` (never commit):

```bash
VSS_URL=https://<random-words>.trycloudflare.com
VSS_USERNAME=team-28
VSS_PASSWORD=<from the team config>
DATA_MODE=real
```

Then:

```bash
.venv/bin/python -m backend.perception.ingest_vss --chunks 4      # 4 SF street cams + neighborhood cam
DATA_MODE=real .venv/bin/uvicorn backend.main:app --port 8765 &
.venv/bin/python scripts/e2e_check.py --base http://127.0.0.1:8765 > e2e.json
```

`GPU_BEARER_TOKEN` (Cosmos3-Reason, YOLO, Embed1) is already in `.env`; the GPU host is reachable directly.

## Notes

- The tunnel exposes the team's VSS API at an unguessable public URL; data still needs a login. Stop it when done.
- Only the VSS backend goes through the tunnel. Deploying to Kubernetes still runs on the VM
  (`scripts/deploy-k8s.sh`, see `AGENTS.md`); it only runs `kubectl`, the heavy work happens in the cluster pod.
