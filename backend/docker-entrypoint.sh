#!/bin/sh
set -eu

# A single process is deliberate: live approval broadcasts use in-process state.
# Scale-out requires a shared broadcaster before this value can change.
if [ "${GUARDIAN_UVICORN_WORKERS:-1}" != "1" ]; then
  echo "GUARDIAN_UVICORN_WORKERS must be exactly 1 until broadcasts are shared" >&2
  exit 64
fi

python -c 'from app.core.config import get_settings; get_settings()'
alembic upgrade head
# The application emits an audited, token-redacted request record. Uvicorn's
# default access log would otherwise retain one-time push action tokens.
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --no-access-log
