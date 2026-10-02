import pytest

from app.api.handler_support import signer
from app.core.config import get_settings


@pytest.mark.asyncio
async def test_signed_policy_and_requests_round_trip(client, paired_device) -> None:
    request_body = b'{"request_type":"UNBLOCK_APP","subject":"com.example.app"}'
    device_headers = paired_device.signed_headers("/v1/devices/me/requests", request_body)
    policy = await client.get("/v1/devices/me/policy", headers=device_headers)
    assert policy.status_code == 200
    policy_body = policy.json()
    assert policy_body["bundle"]["signature"]
    assert policy_body["bundle"]["key_id"] == get_settings().policy_key_id
    request = await client.post(
        "/v1/devices/me/requests",
        headers={**device_headers, "Idempotency-Key": "request-1"},
        content=request_body,
    )
    assert request.status_code == 201
    replay = await client.post(
        "/v1/devices/me/requests",
        headers={
            **paired_device.signed_headers("/v1/devices/me/requests", request_body),
            "Idempotency-Key": "request-1",
        },
        content=request_body,
    )
    assert replay.status_code == 201
    assert replay.json()["id"] == request.json()["id"]
    public_key = await client.get("/v1/policy/public-key")
    assert public_key.status_code == 200
    assert public_key.json()["key_id"] == get_settings().policy_key_id
    assert signer.public_key() == public_key.json()["public_key"]


@pytest.mark.asyncio
async def test_parent_policy_mutation_is_versioned_and_idempotent(client, parent_a) -> None:
    headers = {
        "Authorization": f"Bearer {parent_a.token}",
        "Idempotency-Key": "policy-1",
    }
    response = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "APP_DAILY_MINUTES", "target": "com.example.app", "value": 30},
    )
    assert response.status_code == 200
    assert response.json()["policy_version"] == 2
    replay = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "APP_DAILY_MINUTES", "target": "com.example.app", "value": 30},
    )
    assert replay.status_code == 200
    assert replay.json()["bundle"]["signature"] == response.json()["bundle"]["signature"]


@pytest.mark.asyncio
async def test_parent_rule_mutations_replace_same_target(client, parent_a) -> None:
    url = (
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}"
        "/policy/mutations"
    )
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    operations = [
        {"operation": "APP_DAILY_MINUTES", "target": "com.example.app", "value": 1},
        {"operation": "APP_DAILY_MINUTES", "target": "com.example.app", "value": 30},
        {"operation": "APP_UNLIMITED", "target": "com.example.app"},
        {"operation": "DOMAIN_BLOCK", "target": "example.com"},
        {"operation": "DOMAIN_ALLOW", "target": "example.com"},
        {"operation": "WEB_CATEGORY_BLOCK", "target": "GAMES"},
        {"operation": "CATEGORY_DAILY_MINUTES", "target": "GAMES", "value": 45},
    ]
    response = None
    for operation in operations:
        response = await client.post(url, headers=headers, json=operation)
        assert response.status_code == 200, response.text

    assert response is not None
    bundle = response.json()["bundle"]
    app_rules = [rule for rule in bundle["app_rules"] if rule["app_ref"] == "com.example.app"]
    domain_rules = [rule for rule in bundle["domain_rules"] if rule["domain"] == "example.com"]
    category_rules = [rule for rule in bundle["category_rules"] if rule["category"] == "GAMES"]
    assert app_rules == [{
        "rule_id": app_rules[0]["rule_id"],
        "app_ref": "com.example.app",
        "action": "UNLIMITED",
    }]
    assert domain_rules == [{
        "rule_id": domain_rules[0]["rule_id"],
        "domain": "example.com",
        "action": "ALLOW",
    }]
    assert category_rules == [{
        "rule_id": category_rules[0]["rule_id"],
        "category": "GAMES",
        "action": "LIMIT",
        "daily_minutes": 45,
    }]


@pytest.mark.asyncio
async def test_parent_policy_override_surface_records_audit_fields(client, parent_a) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    operations = [
        {
            "operation": "APP_SCHEDULE",
            "target": "com.example.app",
            "value": {"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "18:00"},
        },
        {
            "operation": "WEB_CATEGORY_BLOCK",
            "target": "SOCIAL_MEDIA",
        },
        {
            "operation": "UNKNOWN_APP_POLICY",
            "target": "base_policy",
            "value": "LIMIT_AND_NOTIFY",
        },
        {
            "operation": "ROUTINE_CREATE",
            "target": "school",
            "value": {
                "routine_id": "school",
                "name": "School",
                "kind": "SCHEDULED",
                "window": {"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "15:00"},
            },
        },
    ]
    previous_version = 1
    for operation in operations:
        response = await client.post(
            f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
            headers=headers,
            json=operation,
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["policy_version"] == previous_version + 1
        assert body["author_parent_id"]
        assert body["mutation_at"]
        assert body["effective_at"]
        assert body["previous_value"]["operation"] == operation["operation"]
        assert body["new_value"]["policy_version"] == body["policy_version"]
        assert body["superseded_policy_version"] == previous_version
        previous_version += 1


@pytest.mark.asyncio
async def test_manual_routine_activation_is_carried_in_signed_policy(client, parent_a) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    created = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={
            "operation": "ROUTINE_CREATE",
            "target": "focus",
            "value": {
                "routine_id": "focus",
                "name": "Focus",
                "kind": "MANUAL",
                "blocked_apps": ["com.example.video"],
            },
        },
    )
    assert created.status_code == 200
    activated = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "ROUTINE_ACTIVATE", "target": "focus"},
    )
    assert activated.status_code == 200
    assert activated.json()["bundle"]["base_policy"]["current_manual_routine_id"] == "focus"
    deactivated = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "ROUTINE_DEACTIVATE", "target": "focus"},
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["bundle"]["base_policy"]["current_manual_routine_id"] is None


@pytest.mark.asyncio
async def test_parent_time_extension_is_signed_and_expires(client, parent_a) -> None:
    response = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers={"Authorization": f"Bearer {parent_a.token}"},
        json={
            "operation": "TEMPORARY_SCREEN_TIME",
            "target": "device",
            "value": 15,
            "expires_at": "2099-01-01T00:00:00Z",
        },
    )
    assert response.status_code == 200, response.text
    override = response.json()["bundle"]["temporary_overrides"][-1]
    assert override["target_kind"] == "DEVICE"
    assert override["target_ref"] == "device"
    assert override["daily_minutes"] == 195
    assert response.json()["bundle"]["signature"]


@pytest.mark.asyncio
async def test_parent_time_extension_targets_existing_app_rule_additively(client, parent_a) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    limited = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "APP_DAILY_MINUTES", "target": "com.example.chrome", "value": 30},
    )
    assert limited.status_code == 200, limited.text
    response = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={
            "operation": "TEMPORARY_SCREEN_TIME",
            "target": "com.example.chrome",
            "value": 15,
            "expires_at": "2099-01-01T00:00:00Z",
        },
    )
    assert response.status_code == 200, response.text
    override = response.json()["bundle"]["temporary_overrides"][-1]
    assert override["target_kind"] == "APP"
    assert override["target_ref"] == "com.example.chrome"
    assert override["daily_minutes"] == 45


@pytest.mark.asyncio
async def test_pause_internet_uses_signed_manual_routine(client, parent_a) -> None:
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    paused = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "PAUSE_INTERNET", "target": "pause-internet"},
    )
    assert paused.status_code == 200, paused.text
    assert paused.json()["bundle"]["base_policy"]["current_manual_routine_id"] == "pause-internet"
    resumed = await client.post(
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}/policy/mutations",
        headers=headers,
        json={"operation": "RESUME_INTERNET", "target": "pause-internet"},
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["bundle"]["base_policy"]["current_manual_routine_id"] is None


@pytest.mark.asyncio
async def test_device_push_token_registration_is_device_scoped(client, paired_device) -> None:
    body = b'{"platform":"ANDROID","token":"device-token-xxxxxxxxxxxxxxxxxxxx"}'
    response = await client.post(
        "/v1/devices/me/push-tokens",
        headers=paired_device.signed_headers("/v1/devices/me/push-tokens", body),
        content=body,
    )
    assert response.status_code == 204


@pytest.mark.asyncio
async def test_request_approval_retry_replays_without_new_policy_version(
    client, paired_device
) -> None:
    request_body = b'{"request_type":"UNBLOCK_APP","subject":"com.example.app"}'
    device_headers = paired_device.signed_headers("/v1/devices/me/requests", request_body)
    parent_headers = {"Authorization": f"Bearer {paired_device.parent.token}"}
    created = await client.post(
        "/v1/devices/me/requests",
        headers=device_headers,
        content=request_body,
    )
    assert created.status_code == 201
    path = (
        f"/v1/families/{paired_device.parent.family_id}/requests/"
        f"{created.json()['id']}/approve"
    )
    headers = {**parent_headers, "Idempotency-Key": "approval-retry"}
    first = await client.post(path, headers=headers, json={"reason": "Approved"})
    second = await client.post(path, headers=headers, json={"reason": "Approved"})
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["state"] == second.json()["state"] == "APPROVED"
