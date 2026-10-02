#!/usr/bin/env bash
# Deploy ALMOST onto the team's Kubernetes namespace, public at http://<team host>/app. Run ON THE WORKSHOP VM.
#   scripts/deploy-k8s.sh                 # deploy / redeploy latest main
#   REAL_CAMERAS=sf_streets_cam-4 REAL_CHUNKS=6 scripts/deploy-k8s.sh
#   scripts/deploy-k8s.sh logs | status | delete
# No docker build/push (hackathon VMs can't): public python:3.11-slim fetches this repo at start, team
# credentials come from /config/<team>.config via a Secret, Ingress path /app on the team host.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=almost
REPO="${REPO:-anagpal18/Vast_Builder_challange}"
REF="${REF:-main}"
REAL_CAMERAS="${REAL_CAMERAS:-sf_streets_cam-1,sf_streets_cam-2,sf_streets_cam-3,sf_streets_cam-4,neighborhood_cam-1}"
REAL_CHUNKS="${REAL_CHUNKS:-4}"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# --- kubectl (not preinstalled on the VMs) ------------------------------------------------
export PATH="$HOME/.local/bin:$PATH"
if ! command -v kubectl >/dev/null; then
  say "installing kubectl into ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
  ver=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
  curl -fsSL -o "$HOME/.local/bin/kubectl" "https://dl.k8s.io/release/${ver}/bin/linux/${arch}/kubectl"
  chmod +x "$HOME/.local/bin/kubectl"
fi

# --- team config + kubeconfig -------------------------------------------------------------
mapfile -t CFGS < <(find /config -maxdepth 1 -type f -name '*.config' | sort)
(( ${#CFGS[@]} == 1 )) || { echo "expected exactly one /config/*.config, found ${#CFGS[@]}" >&2; exit 1; }
TEAM_CONFIG="${CFGS[0]}"
set -a; . "$TEAM_CONFIG"; set +a
if [ -z "${KUBECONFIG:-}" ]; then
  for k in /config/kubeconfig /config/*k8s*.yaml; do [ -f "$k" ] && { export KUBECONFIG="$k"; break; }; done
fi
[ -f "${KUBECONFIG:-}" ] || { echo "no kubeconfig in /config" >&2; exit 1; }
NS="${NS:-$USERNAME}"
APP_HOST="${INGRESS_URL#http://}"; APP_HOST="${APP_HOST#https://}"; APP_HOST="${APP_HOST%%/*}"
K="kubectl -n $NS"

case "${1:-deploy}" in
  logs)   exec $K logs -f deploy/$APP --tail=200 ;;
  status) $K get pods,svc,ingress -l app=$APP; curl -s "http://$APP_HOST/app/health"; echo; exit 0 ;;
  delete) $K delete deploy,svc,ingress -l app=$APP; $K delete secret ${APP}-config --ignore-not-found; exit 0 ;;
esac

say "namespace $NS · host $APP_HOST · repo $REPO@$REF"
$K auth can-i create deployments >/dev/null || { echo "kubectl cannot create deployments in $NS" >&2; exit 1; }

# --- secret: the team config (+ optional .env with a personal W&B key) -----------------------
args=(--from-file=team.config="$TEAM_CONFIG")
[ -f .env ] && args+=(--from-file=dotenv=.env)
$K create secret generic ${APP}-config "${args[@]}" --dry-run=client -o yaml | kubectl apply -f -

# --- deployment + service + ingress ---------------------------------------------------------
$K apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP}
  labels: {app: ${APP}}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: ${APP}}}
  template:
    metadata:
      labels: {app: ${APP}}
    spec:
      containers:
      - name: app
        image: python:3.11-slim
        imagePullPolicy: IfNotPresent
        ports: [{containerPort: 8080}]
        env:
        - {name: PORT, value: "8080"}
        - {name: REPO, value: "${REPO}"}
        - {name: REF, value: "${REF}"}
        - {name: REAL_CAMERAS, value: "${REAL_CAMERAS}"}
        - {name: REAL_CHUNKS, value: "${REAL_CHUNKS}"}
        - {name: PYTHONUNBUFFERED, value: "1"}
        - {name: PIP_DISABLE_PIP_VERSION_CHECK, value: "1"}
        workingDir: /work
        command: ["bash", "-c"]
        args:
        - |
          set -euo pipefail
          python - <<'PY'
          import io, os, tarfile, urllib.request, shutil
          url = f"https://codeload.github.com/{os.environ['REPO']}/tar.gz/{os.environ['REF']}"
          data = urllib.request.urlopen(url, timeout=120).read()
          shutil.rmtree("/work/app", ignore_errors=True)
          with tarfile.open(fileobj=io.BytesIO(data)) as t:
              root = t.getnames()[0].split("/")[0]
              t.extractall("/work/src")
          shutil.move(f"/work/src/{root}", "/work/app")
          print("fetched", url)
          PY
          cd /work/app
          pip install -q --no-cache-dir -r requirements.txt
          if [ -f /secrets/dotenv ]; then cp /secrets/dotenv .env; fi
          exec bash scripts/k8s-entrypoint.sh
        volumeMounts:
        - {name: team-config, mountPath: /config, readOnly: true}
        - {name: dotenv, mountPath: /secrets, readOnly: true}
        - {name: work, mountPath: /work}
        resources:
          requests: {cpu: "1", memory: 2Gi}
          limits: {memory: 6Gi}
        startupProbe:
          httpGet: {path: /health, port: 8080}
          periodSeconds: 10
          failureThreshold: 90
        readinessProbe:
          httpGet: {path: /health, port: 8080}
          periodSeconds: 10
        livenessProbe:
          httpGet: {path: /health, port: 8080}
          periodSeconds: 30
          failureThreshold: 5
      volumes:
      - name: team-config
        secret:
          secretName: ${APP}-config
          items: [{key: team.config, path: team.config}]
      - name: dotenv
        secret:
          secretName: ${APP}-config
          optional: true
          items: [{key: dotenv, path: dotenv}]
      - name: work
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: ${APP}
  labels: {app: ${APP}}
spec:
  selector: {app: ${APP}}
  ports: [{name: http, port: 80, targetPort: 8080}]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${APP}
  labels: {app: ${APP}}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /\$2
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
spec:
  ingressClassName: nginx
  rules:
  - host: ${APP_HOST}
    http:
      paths:
      - path: /app(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service: {name: ${APP}, port: {number: 80}}
YAML

say "restarting to pick up ${REF}"
$K rollout restart deploy/$APP >/dev/null
say "waiting for the pod (first start: pip + simulated data, ~3-6 min)"
if ! $K rollout status deploy/$APP --timeout=20m; then
  $K get pods -l app=$APP; $K logs deploy/$APP --tail=80 || true; exit 1
fi
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$APP_HOST/app/health" || true)
  [ "$code" = 200 ] && break; sleep 5
done
say "health: $(curl -s "http://$APP_HOST/app/health" | head -c 400)"
cat <<OUT

  App (frontend):   http://$APP_HOST/app/
  Test console:     http://$APP_HOST/app/console
  API health:       http://$APP_HOST/app/health
  Real cameras ingest in the background; watch: scripts/deploy-k8s.sh status | logs

OUT
