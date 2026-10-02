# Guardian backend

The backend is a FastAPI modular monolith using SQLAlchemy 2 async sessions,
Alembic migrations, and PostgreSQL 16. Application code never calls
`metadata.create_all`; schema changes are applied with:

```bash
docker compose up -d postgres
uv sync --locked --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Python dependencies are managed exclusively with `uv`. The repository pins
the tool version in `.uv-version`, pins application and development
dependencies in `pyproject.toml`, and records the resolved artifacts in
`uv.lock`. Use `uv sync --locked` locally and in CI; do not maintain a
parallel `requirements.txt` file.

Authentication uses Argon2id password hashes, short-lived access JWTs, and
hashed rotating refresh tokens. Configure secrets through environment
variables; never commit `.env`.

## Foreground sync

Connect with an `Authorization: Bearer <token>` WebSocket header and a
`family_id` query parameter. Parent access tokens use `/v1/ws/parent` (optionally
pass `child_profile_id` to follow one child); paired device credentials use
`/v1/ws/child`. The child channel derives its profile from the device credential
and never subscribes to siblings. Wrong role, revoked device, invalid family, or
unrelated child closes with code 1008. `/v1/ws/sync` remains available for older
clients, with device subscriptions restricted to their own child.

On connection the server sends `{"type":"catch-up","policy_version":...,"open_requests":[...]}`;
subsequent policy, request, and health events prompt clients to refetch their
authenticated REST resources. The server sends `ping` after 30 seconds of
inactivity; clients reply `pong`. Clients should reconnect and refetch after
network interruptions. Event fanout is currently process local, so multiple
API worker processes need a shared broker for immediate cross-worker delivery;
reconnect catch-up and REST reconciliation remain the fallback.

## Local policy signing key

The backend refuses to start when `GUARDIAN_POLICY_PRIVATE_KEY` is absent,
not base64, or does not decode to exactly 32 bytes. Generate a local Ed25519
key and place it in the ignored `backend/.env` file:

```bash
python -c 'import base64; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat; key=Ed25519PrivateKey.generate(); print(base64.b64encode(key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())).decode())'
```

Set the generated value as `GUARDIAN_POLICY_PRIVATE_KEY`. The matching public
key is exposed by `GET /v1/policy/public-key`; do not commit the private key.
