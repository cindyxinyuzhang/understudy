# The API image. The worker uses a separate Dockerfile because it needs the OMR stack
# (model weights, CUDA, poppler) which would otherwise triple the size of every web pod.
FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies are installed from pyproject alone, before the source is copied, so a
# code change does not invalidate the dependency layer.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

# Non-root: the container writes nothing except to object storage and the database.
RUN useradd --create-home --uid 10001 understudy && chown -R understudy:understudy /app
USER understudy

EXPOSE 8000

# Readiness is checked by the orchestrator against /readyz, which touches the database
# and Redis; /healthz is liveness only and stays up through a dependency blip.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/healthz').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
