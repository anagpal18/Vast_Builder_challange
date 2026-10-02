.PHONY: setup setup-yolo data synthetic yolo serve service eval test docker-up docker-gpu docker-down logs
setup:        ; scripts/setup.sh
setup-yolo:   ; WITH_YOLO=1 scripts/setup.sh
data:         ; .venv/bin/python -m backend.precompute
synthetic:    ; .venv/bin/python -m backend.precompute --synthetic
yolo:         ; .venv/bin/python -m backend.precompute --yolo
serve:        ; scripts/run.sh
service:      ; scripts/install-service.sh
eval:         ; .venv/bin/python -m backend.evals.run_eval --label "$(LABEL)"
test:         ; .venv/bin/pytest -q -p no:warnings
docker-up:    ; docker compose up -d --build
docker-gpu:   ; docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
docker-down:  ; docker compose down
logs:         ; docker compose logs -f --tail=100
