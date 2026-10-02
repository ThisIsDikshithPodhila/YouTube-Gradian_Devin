from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = BACKEND_DIR.parent


def test_container_runs_unprivileged_single_worker_and_has_a_healthcheck() -> None:
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    entrypoint = (BACKEND_DIR / "docker-entrypoint.sh").read_text()

    assert "USER guardian" in dockerfile
    assert "HEALTHCHECK" in dockerfile
    assert "COPY packages/policy-schema /app/packages/policy-schema" in dockerfile
    assert "COPY packages/contracts /app/packages/contracts" in dockerfile
    assert "alembic upgrade head" in entrypoint
    assert "--workers 1" in entrypoint
    assert "--no-access-log" in entrypoint
    assert "GUARDIAN_UVICORN_WORKERS must be exactly 1" in entrypoint


def test_build_context_excludes_runtime_secrets_and_local_database_stays_loopback_only() -> None:
    dockerignore = (ROOT_DIR / ".dockerignore").read_text()
    compose = (BACKEND_DIR / "docker-compose.yml").read_text()

    assert "**/.env" in dockerignore
    assert '"127.0.0.1:5432:5432"' in compose
