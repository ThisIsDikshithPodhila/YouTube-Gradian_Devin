import json

import pytest

_PROTECTED_DEVICE_POSTS: tuple[tuple[str, dict[str, object], int], ...] = (
    (
        "/v1/devices/me/policy/ack",
        {"policy_version": 1},
        204,
    ),
    (
        "/v1/devices/me/heartbeat",
        {"protection_state": "HEALTHY", "capabilities": {}},
        204,
    ),
    (
        "/v1/devices/me/events",
        {"events": [{"event_type": "APP", "occurred_at": "2026-01-01T00:00:00Z"}]},
        202,
    ),
    (
        "/v1/devices/me/inventory",
        {"apps": []},
        202,
    ),
    (
        "/v1/devices/me/requests",
        {"request_type": "MORE_TIME", "subject": "Homework", "reason": "Need it"},
        201,
    ),
    (
        "/v1/devices/me/push-tokens",
        {"platform": "ANDROID", "token": "device-token-" + "x" * 20},
        204,
    ),
)


@pytest.mark.asyncio
async def test_protected_device_posts_require_signed_request_proof(
    client, paired_device
) -> None:
    for path, payload, expected_status in _PROTECTED_DEVICE_POSTS:
        encoded_body = json.dumps(payload, separators=(",", ":")).encode()
        bearer_only = await client.post(
            path,
            content=encoded_body,
            headers={
                "Authorization": f"Bearer {paired_device.device_token}",
                "Content-Type": "application/json",
            },
        )
        assert bearer_only.status_code == 401, (path, bearer_only.text)

        signed_headers = paired_device.signed_headers(path, encoded_body)
        signed = await client.post(path, content=encoded_body, headers=signed_headers)
        assert signed.status_code == expected_status, (path, signed.text)

        replay = await client.post(path, content=encoded_body, headers=signed_headers)
        assert replay.status_code == 401, (path, replay.text)
