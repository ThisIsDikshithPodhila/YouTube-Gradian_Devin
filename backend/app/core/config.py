import base64
import json
import re
from functools import lru_cache
from typing import Literal
from urllib.parse import parse_qs, urlparse

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GUARDIAN_", env_file=".env")

    database_url: str = "postgresql+asyncpg://guardian:guardian@localhost:5432/guardian"
    environment: Literal["development", "test", "production"] = "development"
    jwt_secret: str = Field(
        default="development-only-change-me-please-32", min_length=32
    )
    access_minutes: int = 15
    refresh_days: int = 30
    policy_key_id: str = "guardian-dev"
    policy_private_key: str | None = None
    policy_trusted_public_keys: str | None = None
    health_stale_minutes: int = 15

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        if self.environment != "production":
            return self

        _validate_production_database_url(self.database_url)
        if _is_placeholder_jwt_secret(self.jwt_secret):
            raise ValueError(
                "production JWT secret must be a non-placeholder value of at least 32 characters"
            )
        if not self.policy_private_key:
            raise ValueError("production policy private key must be configured")
        try:
            private_key_bytes = base64.b64decode(self.policy_private_key, validate=True)
            if len(private_key_bytes) != 32:
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError(
                "production policy private key must be a base64-encoded 32-byte Ed25519 key"
            ) from None
        try:
            trusted_keys = json.loads(self.policy_trusted_public_keys or "")
            if not isinstance(trusted_keys, dict) or not trusted_keys:
                raise ValueError
            if self.policy_key_id not in trusted_keys or _is_placeholder_key_id(
                self.policy_key_id
            ):
                raise ValueError
            if any(
                not isinstance(key_id, str)
                or not isinstance(encoded_key, str)
                or _is_placeholder_key_id(key_id)
                or not _is_canonical_ed25519_public_key(encoded_key)
                for key_id, encoded_key in trusted_keys.items()
            ):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            raise ValueError(
                "production trusted policy public keys must be a non-empty Ed25519 JSON object "
                "containing the active key"
            ) from None
        if trusted_keys[self.policy_key_id] != _public_key_for_private_seed(private_key_bytes):
            raise ValueError(
                "production active policy public key must correspond to the configured private key"
            )
        return self


def _is_placeholder_key_id(key_id: str) -> bool:
    return not key_id.strip() or bool(
        re.search(
            r"(?:^|[._/-])"
            r"(example|invalid|localhost|change[-_ ]?me|replace[-_ ]?me|"
            r"placeholder|fixture|test)(?:$|[._/-])",
            key_id,
            flags=re.IGNORECASE,
        )
    )


def _is_placeholder_jwt_secret(jwt_secret: str) -> bool:
    if len(jwt_secret) < 32:
        return True
    return bool(
        re.search(
            r"(?:^|[^a-z0-9])"
            r"(?:change[-_ ]?me|replace|placeholder|development|example|fixture|"
            r"default|dummy|ci[-_ ]?only|acceptance[-_ ]?only|test)"
            r"(?:$|[^a-z0-9])",
            jwt_secret,
            flags=re.IGNORECASE,
        )
    )


def _is_canonical_ed25519_public_key(encoded_key: str) -> bool:
    try:
        decoded = base64.b64decode(encoded_key, validate=True)
    except (ValueError, TypeError):
        return False
    return len(decoded) == 32 and base64.b64encode(decoded).decode("ascii") == encoded_key


def _public_key_for_private_seed(private_key_bytes: bytes) -> str:
    public_bytes = (
        Ed25519PrivateKey.from_private_bytes(private_key_bytes)
        .public_key()
        .public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    return base64.b64encode(public_bytes).decode("ascii")


def _validate_production_database_url(database_url: str) -> None:
    parsed = urlparse(database_url)
    if parsed.scheme != "postgresql+asyncpg" or not parsed.hostname:
        raise ValueError("production database URL must use postgresql+asyncpg with a host")
    if parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1", "postgres"}:
        raise ValueError("production database URL must not target a local development database")
    ssl_modes = {mode.lower() for mode in parse_qs(parsed.query).get("ssl", [])}
    if not ssl_modes.intersection({"require", "verify-ca", "verify-full"}):
        raise ValueError("production database URL must require PostgreSQL TLS via ssl=require")


@lru_cache
def get_settings() -> Settings:
    return Settings()
