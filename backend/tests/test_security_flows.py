import json
from uuid import uuid4

import pytest
from conftest import PairedDevice, ParentFamily
from sqlalchemy import select

from app.events.models import ProtectionHealthEvent, SafetyEvent, UsageAggregate, WebEvent
from app.pairing.models import PairingSession


@pytest.mark.asyncio
async def test_refresh_rotation_and_reuse_revokes_family(client, parent_a: ParentFamily) -> None:
    login = await client.post(
        "/v1/auth/login",
        json={"email": "invalid@example.com", "password": "wrong password"},
    )
    assert login.status_code == 401

    signup = await client.post(
        "/v1/auth/signup",
        json={"email": "rotate@example.com", "password": "correct horse battery staple"},
    )
    refresh = signup.json()["refresh_token"]
    rotated = await client.post("/v1/auth/refresh", json={"refresh_token": refresh})
    assert rotated.status_code == 200
    reused = await client.post("/v1/auth/refresh", json={"refresh_token": refresh})
    assert reused.status_code == 401
    assert (
        await client.post(
            "/v1/auth/refresh", json={"refresh_token": rotated.json()["refresh_token"]}
        )
    ).status_code == 401


@pytest.mark.asyncio
async def test_concurrent_refreshes_cannot_issue_two_successor_tokens(client) -> None:
    """The same refresh credential has exactly one successful rotation."""
    import asyncio

    signup = await client.post(
        "/v1/auth/signup",
        json={
            "email": f"refresh-race-{uuid4()}@example.com",
            "password": "correct horse battery staple",
        },
    )
    refresh = signup.json()["refresh_token"]

    first, second = await asyncio.gather(
        client.post("/v1/auth/refresh", json={"refresh_token": refresh}),
        client.post("/v1/auth/refresh", json={"refresh_token": refresh}),
    )

    assert sorted((first.status_code, second.status_code)) == [200, 401]


@pytest.mark.asyncio
async def test_logout_revokes_refresh_token(client) -> None:
    signup = await client.post(
        "/v1/auth/signup",
        json={"email": "logout@example.com", "password": "correct horse battery staple"},
    )
    refresh = signup.json()["refresh_token"]
    assert await client.post("/v1/auth/logout", json={"refresh_token": refresh})
    revoked = await client.post("/v1/auth/refresh", json={"refresh_token": refresh})
    assert revoked.status_code == 401


@pytest.mark.asyncio
async def test_validation_errors_have_stable_shape(client) -> None:
    response = await client.post("/v1/auth/signup", json={"email": "not-an-email", "password": "x"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_http_auth_errors_use_stable_envelope(client) -> None:
    response = await client.post(
        "/v1/auth/login",
        json={"email": "unknown-envelope@example.com", "password": "wrong password"},
    )
    assert response.status_code == 401
    assert response.json() == {
        "error": {"code": "AUTHENTICATION_ERROR", "message": "Invalid credentials"}
    }


@pytest.mark.asyncio
async def test_password_reset_revokes_existing_refresh_tokens(client, monkeypatch) -> None:
    import importlib

    api_module = importlib.import_module("app.api.app")
    sent: list[str] = []

    async def capture(_recipient: str, _subject: str, body: str) -> None:
        sent.append(body)

    monkeypatch.setattr(api_module.notifier, "send_email", capture)
    email = f"{uuid4()}@example.com"
    signup = await client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "correct horse battery staple"},
    )
    refresh = signup.json()["refresh_token"]
    reset_request = await client.post(
        "/v1/auth/password-reset/request", json={"email": email}
    )
    assert reset_request.status_code == 202
    assert sent
    confirm = await client.post(
        "/v1/auth/password-reset/confirm",
        json={"token": sent[-1], "password": "NewPassword123!"},
    )
    assert confirm.status_code == 204
    refresh_response = await client.post(
        "/v1/auth/refresh", json={"refresh_token": refresh}
    )
    assert refresh_response.status_code == 401


@pytest.mark.asyncio
async def test_invalid_heartbeat_contract_is_rejected(client, paired_device: PairedDevice) -> None:
    headers = {"Authorization": f"Bearer {paired_device.device_token}"}
    response = await client.post(
        "/v1/devices/me/heartbeat",
        json={
            "protection_state": "not-a-protection-state",
            "capabilities": {
                "unknown": {
                    "level": "INVALID",
                    "detail": None,
                    "updatedAt": "2026-01-01T00:00:00Z",
                }
            },
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_login_rate_limit_trips(client) -> None:
    for _ in range(10):
        response = await client.post(
            "/v1/auth/login",
            json={"email": "rate@example.com", "password": "wrong password"},
        )
        assert response.status_code == 401
    response = await client.post(
        "/v1/auth/login",
        json={"email": "rate@example.com", "password": "wrong password"},
    )
    assert response.status_code == 429


@pytest.mark.asyncio
async def test_verification_and_password_reset_rate_limits_trip(client) -> None:
    email = f"{uuid4()}@example.com"
    signup = await client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "correct horse battery staple"},
    )
    headers = {"Authorization": f"Bearer {signup.json()['access_token']}"}
    for _ in range(5):
        assert (
            await client.post("/v1/auth/verification/request", headers=headers)
        ).status_code == 202
    assert (
        await client.post("/v1/auth/verification/request", headers=headers)
    ).status_code == 429

    reset_email = f"{uuid4()}@example.com"
    for _ in range(5):
        assert (
            await client.post(
                "/v1/auth/password-reset/request", json={"email": reset_email}
            )
        ).status_code == 202
    assert (
        await client.post(
            "/v1/auth/password-reset/request", json={"email": reset_email}
        )
    ).status_code == 429


@pytest.mark.asyncio
async def test_access_and_refresh_expiry_are_rejected(client) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    email = f"{uuid4()}@example.com"
    await client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "correct horse battery staple"},
    )
    original_access = settings.access_minutes
    original_refresh = settings.refresh_days
    try:
        settings.access_minutes = 0
        settings.refresh_days = 0
        expired_access = await client.post(
            "/v1/auth/login",
            json={"email": email, "password": "correct horse battery staple"},
        )
        assert expired_access.status_code == 200
        refresh = expired_access.json()["refresh_token"]
        assert (
            await client.get(
                "/v1/auth/me",
                headers={"Authorization": f"Bearer {expired_access.json()['access_token']}"},
            )
        ).status_code == 401
        assert (
            await client.post("/v1/auth/refresh", json={"refresh_token": refresh})
        ).status_code == 401
    finally:
        settings.access_minutes = original_access
        settings.refresh_days = original_refresh


@pytest.mark.asyncio
async def test_device_routes_and_minimized_event_validation(
    client, paired_device: PairedDevice
) -> None:
    device_headers = {"Authorization": f"Bearer {paired_device.device_token}"}
    policy = await client.get("/v1/devices/me/policy", headers=device_headers)
    assert policy.status_code == 200
    policy_ack_body = b'{"policy_version":1}'
    assert (
        await client.post(
            "/v1/devices/me/policy/ack",
            content=policy_ack_body,
            headers=paired_device.signed_headers("/v1/devices/me/policy/ack", policy_ack_body),
        )
    ).status_code == 204
    heartbeat_body = b'{"protection_state":"HEALTHY"}'
    assert (
        await client.post(
            "/v1/devices/me/heartbeat",
            content=heartbeat_body,
            headers=paired_device.signed_headers("/v1/devices/me/heartbeat", heartbeat_body),
        )
    ).status_code == 204
    rejected_body = json.dumps(
        {
            "events": [
                {
                    "event_type": "URL",
                    "occurred_at": "2026-01-01T00:00:00Z",
                    "raw_content": "secret",
                }
            ]
        },
        separators=(",", ":"),
    ).encode()
    rejected = await client.post(
        "/v1/devices/me/events",
        content=rejected_body,
        headers=paired_device.signed_headers("/v1/devices/me/events", rejected_body),
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_device_events_and_health_are_persisted(
    client, paired_device: PairedDevice, database_session
) -> None:
    heartbeat_body = b'{"protection_state":"HEALTHY","capabilities":{}}'
    response = await client.post(
        "/v1/devices/me/heartbeat",
        content=heartbeat_body,
        headers=paired_device.signed_headers("/v1/devices/me/heartbeat", heartbeat_body),
    )
    assert response.status_code == 204
    events_body = json.dumps(
        {
            "events": [
                {
                    "event_type": "APP",
                    "occurred_at": "2026-01-01T00:00:00Z",
                    "app_ref": "com.example.app",
                },
                {
                    "event_type": "DOMAIN",
                    "occurred_at": "2026-01-01T00:01:00Z",
                    "domain": "example.com",
                },
                {
                    "event_type": "SAFETY_BLOCK",
                    "occurred_at": "2026-01-01T00:02:00Z",
                    "domain": "unsafe.example.com",
                },
            ]
        },
        separators=(",", ":"),
    ).encode()
    response = await client.post(
        "/v1/devices/me/events",
        content=events_body,
        headers={
            **paired_device.signed_headers("/v1/devices/me/events", events_body),
            "Idempotency-Key": "persisted-events",
        },
    )
    assert response.status_code == 202
    assert await database_session.scalar(
        select(UsageAggregate).where(UsageAggregate.device_id == paired_device.device_id)
    )
    assert await database_session.scalar(
        select(WebEvent).where(WebEvent.device_id == paired_device.device_id)
    )
    assert await database_session.scalar(
        select(SafetyEvent).where(SafetyEvent.device_id == paired_device.device_id)
    )
    assert await database_session.scalar(
        select(ProtectionHealthEvent).where(
            ProtectionHealthEvent.device_id == paired_device.device_id
        )
    )


@pytest.mark.asyncio
async def test_credentials_cannot_cross_parent_and_device_routes(
    client, paired_device: PairedDevice
) -> None:
    parent_headers = {"Authorization": f"Bearer {paired_device.parent.token}"}
    device_headers = {"Authorization": f"Bearer {paired_device.device_token}"}
    assert (await client.get("/v1/devices/me/policy", headers=parent_headers)).status_code == 401
    assert (
        await client.get(f"/v1/families/{paired_device.parent.family_id}", headers=device_headers)
    ).status_code == 401


@pytest.mark.asyncio
async def test_pairing_idempotency_replays_and_conflicts(client, parent_a: ParentFamily) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    pairing = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
        headers=headers,
    )
    code = pairing.json()["qr_payload"].rsplit("code=", 1)[1]
    body = {
        "session_id": pairing.json()["session_id"],
        "code": code,
        "child_profile_id": parent_a.child_id,
        "platform": "ANDROID",
        "public_key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    }
    idem = {"Idempotency-Key": "pairing-replay"}
    first = await client.post("/v1/devices/pair", json=body, headers=idem)
    second = await client.post("/v1/devices/pair", json=body, headers=idem)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    conflict = await client.post(
        "/v1/devices/pair",
        json={**body, "platform": "IOS"},
        headers=idem,
    )
    assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_pairing_returns_manual_code_and_reuse_is_rejected(
    client, parent_a: ParentFamily, caplog
) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    pairing = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
        headers=headers,
    )
    payload = pairing.json()
    assert payload["code"].isdigit() and len(payload["code"]) == 6
    assert payload["code"] in payload["qr_payload"]
    assert f"child_id={parent_a.child_id}" in payload["qr_payload"]
    body = {
        "session_id": payload["session_id"],
        "code": payload["code"],
        "child_profile_id": parent_a.child_id,
        "platform": "ANDROID",
        "public_key": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
    }
    assert (await client.post("/v1/devices/pair", json=body)).status_code == 200
    assert (await client.post("/v1/devices/pair", json=body)).status_code == 400
    assert payload["code"] not in caplog.text


@pytest.mark.asyncio
async def test_pairing_cross_family_redemption_is_rejected(
    client, parent_a: ParentFamily, parent_b: ParentFamily
) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    pairing = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
        headers=headers,
    )
    body = {
        "session_id": pairing.json()["session_id"],
        "code": pairing.json()["code"],
        "child_profile_id": parent_b.child_id,
        "platform": "ANDROID",
        "public_key": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    }
    assert (await client.post("/v1/devices/pair", json=body)).status_code == 400


@pytest.mark.asyncio
async def test_pairing_creation_rate_limit_trips(client, parent_a: ParentFamily) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    for _ in range(10):
        assert (
            await client.post(
                f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
                headers=headers,
            )
        ).status_code == 200
    assert (
        await client.post(
            f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
            headers=headers,
        )
    ).status_code == 429


@pytest.mark.asyncio
async def test_revoked_device_is_rejected_on_every_device_route(
    client, paired_device: PairedDevice
) -> None:
    parent_headers = {"Authorization": f"Bearer {paired_device.parent.token}"}
    device_headers = {"Authorization": f"Bearer {paired_device.device_token}"}
    revoke = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/devices/{paired_device.device_id}/revoke",
        headers=parent_headers,
    )
    assert revoke.status_code == 204
    assert (await client.get("/v1/devices/me/policy", headers=device_headers)).status_code == 401
    assert (
        await client.post(
            "/v1/devices/me/policy/ack",
            json={"policy_version": 1},
            headers=device_headers,
        )
    ).status_code == 401
    assert (
        await client.post(
            "/v1/devices/me/heartbeat",
            json={"protection_state": "HEALTHY"},
            headers=device_headers,
        )
    ).status_code == 401
    assert (
        await client.post(
            "/v1/devices/me/events",
            json={"events": [{"event_type": "APP", "occurred_at": "2026-01-01T00:00:00Z"}]},
            headers=device_headers,
        )
    ).status_code == 401


@pytest.mark.asyncio
async def test_event_batch_idempotency_replays_and_conflicts(
    client, paired_device: PairedDevice
) -> None:
    body = b'{"events":[{"event_type":"APP","occurred_at":"2026-01-01T00:00:00Z"}]}'
    first = await client.post(
        "/v1/devices/me/events",
        content=body,
        headers={
            **paired_device.signed_headers("/v1/devices/me/events", body),
            "Idempotency-Key": "events-replay",
        },
    )
    second = await client.post(
        "/v1/devices/me/events",
        content=body,
        headers={
            **paired_device.signed_headers("/v1/devices/me/events", body),
            "Idempotency-Key": "events-replay",
        },
    )
    assert first.status_code == second.status_code == 202
    conflict_body = b'{"events":[{"event_type":"DOMAIN","occurred_at":"2026-01-01T00:00:00Z"}]}'
    conflict = await client.post(
        "/v1/devices/me/events",
        content=conflict_body,
        headers={
            **paired_device.signed_headers("/v1/devices/me/events", conflict_body),
            "Idempotency-Key": "events-replay",
        },
    )
    assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_pairing_wrong_code_locks_session(client, parent_a: ParentFamily) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    pairing = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
        headers=headers,
    )
    body = {
        "session_id": pairing.json()["session_id"],
        "code": "000000",
        "child_profile_id": parent_a.child_id,
        "platform": "ANDROID",
        "public_key": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    }
    for _ in range(5):
        assert (await client.post("/v1/devices/pair", json=body)).status_code == 400
    assert (await client.post("/v1/devices/pair", json=body)).status_code == 400


@pytest.mark.asyncio
async def test_pairing_expired_is_rejected(
    client, parent_a: ParentFamily, database_session
) -> None:
    from datetime import UTC, datetime, timedelta

    headers = {"Authorization": f"Bearer {parent_a.token}"}
    pairing = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/pairing",
        headers=headers,
    )
    session_id = pairing.json()["session_id"]
    row = await database_session.scalar(
        select(PairingSession).where(PairingSession.id == session_id)
    )
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await database_session.commit()
    code = pairing.json()["qr_payload"].rsplit("code=", 1)[1]
    body = {
        "session_id": session_id,
        "code": code,
        "child_profile_id": parent_a.child_id,
        "platform": "ANDROID",
        "public_key": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
    }
    assert (await client.post("/v1/devices/pair", json=body)).status_code == 400


@pytest.mark.asyncio
async def test_child_delete_and_guardian_invitation_single_use(
    client, parent_a: ParentFamily, monkeypatch
) -> None:
    import importlib

    api_module = importlib.import_module("app.api.handler_support")
    sent: list[str] = []

    async def capture(_recipient: str, _subject: str, body: str) -> None:
        sent.append(body)

    monkeypatch.setattr(api_module.notifier, "send_email", capture)
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    invitee = await client.post(
        "/v1/auth/signup",
        json={"email": "invitee@example.com", "password": "correct horse battery staple"},
    )
    invitee_headers = {"Authorization": f"Bearer {invitee.json()['access_token']}"}
    invitation = await client.post(
        f"/v1/families/{parent_a.family_id}/guardians/invite",
        json={"email": "invitee@example.com"},
        headers=headers,
    )
    assert invitation.status_code == 202
    assert len(sent) == 1
    accepted = await client.post(
        "/v1/families/guardians/accept",
        json={"token": sent[0]},
        headers=invitee_headers,
    )
    assert accepted.status_code == 204
    replay = await client.post(
        "/v1/families/guardians/accept",
        json={"token": sent[0]},
        headers=invitee_headers,
    )
    assert replay.status_code == 400
    deleted = await client.delete(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}",
        headers=headers,
    )
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_verification_and_password_reset_tokens_are_single_use(
    client, monkeypatch
) -> None:
    import importlib

    api_module = importlib.import_module("app.api.app")
    sent: list[str] = []

    async def capture(_recipient: str, _subject: str, body: str) -> None:
        sent.append(body)

    monkeypatch.setattr(api_module.notifier, "send_email", capture)
    signup = await client.post(
        "/v1/auth/signup",
        json={"email": "tokens@example.com", "password": "correct horse battery staple"},
    )
    headers = {"Authorization": f"Bearer {signup.json()['access_token']}"}
    assert (
        await client.post("/v1/auth/verification/request", headers=headers)
    ).status_code == 202
    verification_token = sent.pop()
    assert (
        await client.post(
            "/v1/auth/verification/confirm",
            json={"token": verification_token},
        )
    ).status_code == 204
    assert (
        await client.post(
            "/v1/auth/verification/confirm",
            json={"token": verification_token},
        )
    ).status_code == 400
    assert (
        await client.post(
            "/v1/auth/password-reset/request",
            json={"email": "tokens@example.com"},
        )
    ).status_code == 202
    reset_token = sent.pop()
    assert (
        await client.post(
            "/v1/auth/password-reset/confirm",
            json={"token": reset_token, "password": "new correct horse battery"},
        )
    ).status_code == 204
    assert (
        await client.post(
            "/v1/auth/password-reset/confirm",
            json={"token": reset_token, "password": "new correct horse battery"},
        )
    ).status_code == 400


@pytest.mark.asyncio
async def test_unhandled_error_uses_generic_error_shape(client, monkeypatch) -> None:
    import importlib

    import httpx

    api_module = importlib.import_module("app.api.handler_support")
    app_module = importlib.import_module("app.api.app")

    async def fail(*_args, **_kwargs):
        raise RuntimeError("sensitive internal detail")

    monkeypatch.setattr(api_module, "parent_from_access", fail)
    transport = httpx.ASGITransport(app=app_module.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as isolated:
        response = await isolated.get(
            "/v1/auth/me", headers={"Authorization": "Bearer valid-looking-token"}
        )
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "INTERNAL_ERROR", "message": "An internal error occurred"}
    }
