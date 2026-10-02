FROM python:3.11-slim

ARG WITH_YOLO=0
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && if [ "$WITH_YOLO" = "1" ]; then apt-get install -y --no-install-recommends libgl1 libglib2.0-0; fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-yolo.txt ./
RUN pip install -r $( [ "$WITH_YOLO" = "1" ] && echo requirements-yolo.txt || echo requirements.txt )
COPY . .
RUN mkdir -p /app/defaults && cp -r data/config /app/defaults/config   # seeds an empty data volume

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health',timeout=4)"
ENTRYPOINT ["scripts/docker-entrypoint.sh"]
