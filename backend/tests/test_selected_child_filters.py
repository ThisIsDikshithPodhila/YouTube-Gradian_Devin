import base64
import json
from datetime import UTC, datetime

import pytest
from conftest import PairedDevice
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


async def pair_child(client, parent, child_id: str) -> PairedDevice:
    headers = {"Authorization": f"Bearer {parent.token}"}
    pairing = await client.post(
        f"/v1/families/{parent.family_id}/children/{child_id}/pairing",
        headers=headers,
    )
    assert pairing.status_code == 200, pairing.text
    private_key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    redeemed = await client.post(
        "/v1/devices/pair",
        json={
            "session_id": pairing.json()["session_id"],
            "code": pairing.json()["code"],
            "child_profile_id": child_id,
            "platform": "ANDROID",
            "public_key": base64.b64encode(
                private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
            ).decode("ascii"),
        },
    )
    assert redeemed.status_code == 200, redeemed.text
    return PairedDevice(
        parent,
        redeemed.json()["device_id"],
        redeemed.json()["device_token"],
        base64.b64encode(bytes(range(32))).decode("ascii"),
    )


async def post_events(client, device: PairedDevice, event_type: str, app_ref: str) -> None:
    body = {
        "events": [
            {
                "event_type": event_type,
                "occurred_at": datetime.now(UTC).isoformat(),
                "app_ref": app_ref,
                "category": "EDUCATION",
                **({"duration_seconds": 60} if event_type == "APP_USAGE" else {}),
            }
        ]
    }
    encoded = json.dumps(body, separators=(",", ":")).encode()
    response = await client.post(
        "/v1/devices/me/events",
        headers=device.signed_headers("/v1/devices/me/events", encoded),
        content=encoded,
    )
    assert response.status_code == 202, response.text


@pytest.mark.asyncio
async def test_parent_surfaces_filter_to_the_selected_child(
    client, parent_a, paired_device
) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    second_child = await client.post(
        f"/v1/families/{parent_a.family_id}/children",
        headers=headers,
        json={"name": "Blair", "date_of_birth": "2014-08-15", "timezone": "UTC"},
    )
    assert second_child.status_code == 201, second_child.text
    second_child_id = second_child.json()["id"]
    second_device = await pair_child(client, parent_a, second_child_id)

    await post_events(client, paired_device, "WEB_BLOCKED", "com.example.alex")
    await post_events(client, paired_device, "APP_USAGE", "com.example.alex")
    await post_events(client, second_device, "WEB_BLOCKED", "com.example.blair")
    await post_events(client, second_device, "APP_USAGE", "com.example.blair")

    first_activity = await client.get(
        f"/v1/families/{parent_a.family_id}/activity?child_id={parent_a.child_id}",
        headers=headers,
    )
    assert first_activity.status_code == 200, first_activity.text
    assert {row["app_ref"] for row in first_activity.json()} == {"com.example.alex"}

    second_usage = await client.get(
        f"/v1/families/{parent_a.family_id}/activity/usage?child_id={second_child_id}",
        headers=headers,
    )
    assert second_usage.status_code == 200, second_usage.text
    assert {row["app_ref"] for row in second_usage.json()} == {"com.example.blair"}

    first_health = await client.get(
        f"/v1/families/{parent_a.family_id}/health?child_id={parent_a.child_id}",
        headers=headers,
    )
    assert first_health.status_code == 200, first_health.text
    assert [row["child_profile_id"] for row in first_health.json()] == [parent_a.child_id]

    request_body = {"request_type": "MORE_TIME", "subject": "device", "reason": "Homework"}
    encoded_request = json.dumps(request_body, separators=(",", ":")).encode()
    created_request = await client.post(
        "/v1/devices/me/requests",
        headers=second_device.signed_headers("/v1/devices/me/requests", encoded_request),
        content=encoded_request,
    )
    assert created_request.status_code == 201, created_request.text
    first_requests = await client.get(
        f"/v1/families/{parent_a.family_id}/requests?child_id={parent_a.child_id}",
        headers=headers,
    )
    second_requests = await client.get(
        f"/v1/families/{parent_a.family_id}/requests?child_id={second_child_id}",
        headers=headers,
    )
    assert first_requests.json() == []
    assert [row["id"] for row in second_requests.json()] == [created_request.json()["id"]]
