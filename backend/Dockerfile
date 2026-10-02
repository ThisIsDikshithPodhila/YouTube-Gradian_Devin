# Build from the repository root so the policy schema is available at runtime:
# docker build -f backend/Dockerfile -t guardian-api .
FROM python:3.13-slim-bookworm@sha256:00faa2debb87529f9f0764e9491d8ba400a3678976616c3bd7cb193745ac20d1

COPY --from=ghcr.io/astral-sh/uv:0.7.19@sha256:2dcbc74e60ed6d842122ed538f5267c80e7cde4ff1b6e66a199b89972496f033 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/backend/.venv/bin:$PATH" \
    PYTHONPATH=/app/backend

RUN groupadd --system guardian && useradd --system --gid guardian --home-dir /app guardian

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend /app/backend
COPY packages/policy-schema /app/packages/policy-schema
COPY packages/contracts /app/packages/contracts
RUN chmod 0555 /app/backend/docker-entrypoint.sh \
    && chown -R guardian:guardian /app

USER guardian
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/health', timeout=3).read()"
ENTRYPOINT ["/app/backend/docker-entrypoint.sh"]
