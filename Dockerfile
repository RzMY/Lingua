FROM python:3.11-slim-bookworm AS dependencies

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    NLTK_DATA=/opt/nltk_data

WORKDIR /build
COPY requirements.txt ./requirements.txt
COPY docker/requirements.txt ./docker/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install -r docker/requirements.txt \
    && /opt/venv/bin/pip check \
    && /opt/venv/bin/python -m nltk.downloader -d /opt/nltk_data -e \
        cmudict averaged_perceptron_tagger averaged_perceptron_tagger_eng

FROM python:3.11-slim-bookworm AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NLTK_DATA=/opt/nltk_data \
    HOME=/tmp \
    LINGUA_HOST=0.0.0.0 \
    LINGUA_PORT=5173

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 lingua \
    && useradd --uid 10001 --gid lingua --no-create-home --home-dir /tmp lingua

COPY --from=dependencies /opt/venv /opt/venv
COPY --from=dependencies /opt/nltk_data /opt/nltk_data
WORKDIR /app
COPY pipeline/ ./pipeline/
COPY web/ ./web/
COPY docker/healthcheck.py /opt/lingua/healthcheck.py

USER 10001:10001
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "/opt/lingua/healthcheck.py"]
ENTRYPOINT ["python", "-m", "pipeline"]
CMD ["serve", "--root", "/app/web"]
