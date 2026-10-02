import json
from datetime import UTC, datetime

from sqlalchemy import func, select

from app.children.models import ChildAppInventory, ChildProfile
from app.devices.models import Device, DeviceCredential
from app.events.models import (
    ProtectionHealthEvent,
    SafetyEvent,
    SafetyNotification,
    UsageAggregate,
    WebEvent,
)
from app.families.models import Family, FamilyGuardian
from app.pairing.models import PairingSession
from app.policies.models import PolicyBundle, PolicyDocument
from app.push.models import PushToken
from app.requests.models import Request


async def count_rows(session, model) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)))


async def test_account_deletion_removes_family_and_child_data(
    client, parent_a, paired_device, database_session
) -> None:
    auth = {"Authorization": f"Bearer {parent_a.token}"}
    device_auth = {"Authorization": f"Bearer {paired_device.device_token}"}

    heartbeat_body = json.dumps(
        {"protection_state": "HEALTHY", "capabilities": {}}, separators=(",", ":")
    ).encode()
    heartbeat = await client.post(
        "/v1/devices/me/heartbeat",
        headers=paired_device.signed_headers("/v1/devices/me/heartbeat", heartbeat_body),
        content=heartbeat_body,
    )
    assert heartbeat.status_code == 204, heartbeat.text
    inventory_body = json.dumps(
        {
            "apps": [
                {
                    "platform_app_id": "com.example.chat",
                    "display_name": "Chat",
                    "category": "COMMUNICATION",
                    "observed_at": datetime.now(UTC).isoformat(),
                }
            ]
        },
        separators=(",", ":"),
    ).encode()
    inventory = await client.post(
        "/v1/devices/me/inventory",
        headers=paired_device.signed_headers("/v1/devices/me/inventory", inventory_body),
        content=inventory_body,
    )
    assert inventory.status_code == 202, inventory.text
    push = await client.post(
        "/v1/me/push-tokens",
        headers=auth,
        json={"token": "test-device-token-" + "x" * 20, "platform": "ANDROID"},
    )
    assert push.status_code == 204, push.text
    events_body = json.dumps(
        {
            "events": [
                {
                    "event_type": "APP_USAGE",
                    "occurred_at": datetime.now(UTC).isoformat(),
                    "app_ref": "com.example.chat",
                    "duration_seconds": 30,
                },
                {
                    "event_type": "WEB_BLOCKED",
                    "occurred_at": datetime.now(UTC).isoformat(),
                    "domain": "blocked.example",
                },
                {
                    "event_type": "SAFETY_HARASSMENT",
                    "occurred_at": datetime.now(UTC).isoformat(),
                    "app_ref": "com.example.chat",
                    "category": "HARASSMENT",
                    "severity": "HIGH",
                    "confidence": 0.8,
                    "reason_code": "BULLYING_TARGETED",
                },
            ]
        },
        separators=(",", ":"),
    ).encode()
    events = await client.post(
        "/v1/devices/me/events",
        headers=paired_device.signed_headers("/v1/devices/me/events", events_body),
        content=events_body,
    )
    assert events.status_code == 202, events.text
    request_body = b'{"request_type":"MORE_TIME","subject":"Chat","reason":"Need more time"}'
    request = await client.post(
        "/v1/devices/me/requests",
        headers={
            **device_auth,
            **paired_device.signed_headers(
                "/v1/devices/me/requests", request_body
            ),
        },
        content=request_body,
    )
    assert request.status_code == 201, request.text
    before = {
        model.__tablename__: await count_rows(database_session, model)
        for model in (
            Family,
            FamilyGuardian,
            ChildProfile,
            Device,
            DeviceCredential,
            ChildAppInventory,
            PolicyDocument,
            PolicyBundle,
            ProtectionHealthEvent,
            UsageAggregate,
            WebEvent,
            SafetyEvent,
            SafetyNotification,
            Request,
            PairingSession,
            PushToken,
        )
    }
    assert not [
        key for key, value in before.items() if value == 0 and key != "safety_notifications"
    ], before

    deleted = await client.delete("/v1/auth/account", headers=auth)
    assert deleted.status_code == 204, deleted.text

    me = await client.get("/v1/auth/me", headers=auth)
    assert me.status_code == 401
    repeated = await client.delete("/v1/auth/account", headers=auth)
    assert repeated.status_code == 401
    after = {
        model.__tablename__: await count_rows(database_session, model)
        for model in (
            Family,
            FamilyGuardian,
            ChildProfile,
            Device,
            DeviceCredential,
            ChildAppInventory,
            PolicyDocument,
            PolicyBundle,
            ProtectionHealthEvent,
            UsageAggregate,
            WebEvent,
            SafetyEvent,
            SafetyNotification,
            Request,
            PairingSession,
            PushToken,
        )
    }
    assert after == {key: 0 for key in before}


async def test_account_deletion_is_authorized_and_web_route_is_accessible(
    client, parent_a, parent_b
) -> None:
    denied = await client.delete(
        "/v1/auth/account", headers={"Authorization": "Bearer invalid-token"}
    )
    assert denied.status_code == 401

    page = await client.get("/account-deletion")
    assert page.status_code == 200
    assert "DELETE /v1/auth/account" in page.text
    assert "irreversible" in page.text

    family = await client.get(
        f"/v1/families/{parent_b.family_id}",
        headers={"Authorization": f"Bearer {parent_a.token}"},
    )
    assert family.status_code == 404
