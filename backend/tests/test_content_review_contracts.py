"""Regression coverage for minimized, device-bound content review contracts."""

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from conftest import PairedDevice
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from jsonschema import Draft202012Validator, FormatChecker
from sqlalchemy import delete, select

from app.api.app import app
from app.events.models import SafetyEvent
from app.policies.models import PolicyBundle
from app.policies.service import default_policy
from app.policies.signing import verify_signed_bundle
from app.requests import router as request_router
from app.requests.models import Request

FINGERPRINT_A = "a" * 64
FINGERPRINT_B = "b" * 64
FINGERPRINT_C = "c" * 64
SCHEMA = json.loads(
    (
        Path(__file__).parents[2]
        / "packages"
        / "policy-schema"
        / "schema"
        / "policy-bundle.schema.json"
    ).read_text()
)


def content_review_payload(
    *,
    fingerprint: str = FINGERPRINT_A,
    app_ref: str = "com.example.video",
) -> dict[str, object]:
    return {
        "request_type": "CONTENT_REVIEW",
        "content_review": {
            "app_ref": app_ref,
            "fingerprint": fingerprint,
            "category": "SELF_HARM_SUICIDE",
            "severity": "HIGH",
            "confidence": 0.91,
            "reason_code": "SELF_HARM_DIRECT+SELF_HARM_INTENT",
            "public_content_ref": {"provider": "YOUTUBE", "content_id": "dQw4w9WgXcQ"},
        },
    }


async def post_content_review(client, paired_device, payload: dict[str, object], key: str):
    path = "/v1/devices/me/requests"
    body = json.dumps(payload, separators=(",", ":")).encode()
    return await client.post(
        path,
        content=body,
        headers={
            **paired_device.signed_headers(path, body),
            "Content-Type": "application/json",
            "Idempotency-Key": key,
        },
    )


async def pair_additional_device(client, paired_device) -> PairedDevice:
    """Pair another physical child device without sharing authorization tokens."""
    parent = paired_device.parent
    pairing = await client.post(
        f"/v1/families/{parent.family_id}/children/{parent.child_id}/pairing",
        headers={"Authorization": f"Bearer {parent.token}"},
    )
    assert pairing.status_code == 200, pairing.text
    payload = pairing.json()["qr_payload"]
    code = payload.rsplit("code=", 1)[1].split("&", 1)[0]
    public_key = Ed25519PrivateKey.from_private_bytes(bytes(range(32))).public_key()
    redeemed = await client.post(
        "/v1/devices/pair",
        json={
            "session_id": pairing.json()["session_id"],
            "code": code,
            "child_profile_id": parent.child_id,
            "platform": "ANDROID",
            "public_key": base64.b64encode(
                public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
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


@pytest.mark.parametrize(
    ("age_band", "expected"),
    [
        ("YOUNG_CHILD", "MEDIUM"),
        ("PRETEEN", "MEDIUM"),
        ("TEEN", "HIGH"),
        ("OLDER_TEEN", "CRITICAL"),
    ],
)
def test_content_block_threshold_is_signed_and_separate_from_notification_threshold(
    age_band: str, expected: str
) -> None:
    policy = default_policy(uuid4(), uuid4(), age_band, "UTC")
    assert policy["content_safety"] == {"content_block_threshold": expected}
    # The established notification-alert default must remain stable.
    assert policy["communication_safety"]["severity_threshold"] == "HIGH"
    validator = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
    assert list(validator.iter_errors(policy)) == []


def test_legacy_signed_policy_without_content_safety_remains_schema_compatible() -> None:
    policy = default_policy(uuid4(), uuid4(), "TEEN", "UTC")
    policy.pop("content_safety")
    validator = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
    assert list(validator.iter_errors(policy)) == []


@pytest.mark.asyncio
async def test_content_review_accepts_only_minimized_typed_evidence_and_dedupes(
    client, paired_device, database_session
) -> None:
    first = await post_content_review(
        client, paired_device, content_review_payload(), "content-review-a"
    )
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["request_type"] == "CONTENT_REVIEW"
    assert body["subject"] is None
    assert body["reason"] is None
    assert body["content_review"] == content_review_payload()["content_review"]

    repeated = await post_content_review(
        client, paired_device, content_review_payload(), "content-review-b"
    )
    assert repeated.status_code == 201, repeated.text
    assert repeated.json()["id"] == body["id"]

    row = await database_session.get(Request, body["id"])
    assert row is not None
    assert row.content_app_ref == "com.example.video"
    assert row.content_fingerprint == FINGERPRINT_A
    assert row.content_review == content_review_payload()["content_review"]


@pytest.mark.asyncio
async def test_content_review_rejects_raw_or_arbitrary_content_fields(
    client, paired_device
) -> None:
    raw_canary = "RAW-CONTENT-CANARY-DO-NOT-PERSIST"
    payload = content_review_payload()
    payload["content_review"]["raw_text"] = raw_canary  # type: ignore[index]
    rejected_nested = await post_content_review(
        client, paired_device, payload, "content-review-raw-nested"
    )
    assert rejected_nested.status_code == 422
    assert raw_canary not in rejected_nested.text

    payload = content_review_payload()
    payload["raw_text"] = raw_canary
    rejected_top_level = await post_content_review(
        client, paired_device, payload, "content-review-raw-top"
    )
    assert rejected_top_level.status_code == 422
    assert raw_canary not in rejected_top_level.text

    invalid_evidence = [
        {"fingerprint": "A" * 64},
        {"fingerprint": "a" * 63},
        {"app_ref": "com.example bad"},
        {
            "public_content_ref": {
                "provider": "YOUTUBE",
                "content_id": "https://youtube.example/watch?v=secret",
            }
        },
        {"public_content_ref": {"provider": "UNKNOWN", "content_id": "public-id"}},
    ]
    for index, invalid in enumerate(invalid_evidence):
        payload = content_review_payload()
        payload["content_review"].update(invalid)  # type: ignore[index]
        rejected = await post_content_review(
            client, paired_device, payload, f"content-review-invalid-{index}"
        )
        assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_content_review_approval_is_device_app_fingerprint_bound_and_never_widens(
    client, paired_device, database_session, monkeypatch
) -> None:
    created = await post_content_review(
        client, paired_device, content_review_payload(), "content-review-approve"
    )
    assert created.status_code == 201, created.text
    request_id = created.json()["id"]
    frozen_decision_time = datetime.now(UTC).replace(microsecond=0)

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen_decision_time.astimezone(tz) if tz else frozen_decision_time

    monkeypatch.setattr(request_router, "datetime", FrozenDateTime)
    decision = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {paired_device.parent.token}"},
        json={"reason": "Reviewed"},
    )
    assert decision.status_code == 200, decision.text

    row = await database_session.get(Request, request_id)
    assert row is not None and row.decided_at is not None
    approvals = await client.get(
        "/v1/devices/me/content-approvals",
        headers={"Authorization": f"Bearer {paired_device.device_token}"},
    )
    assert approvals.status_code == 200, approvals.text
    assert approvals.json() == [
        {
            "device_id": paired_device.device_id,
            "app_ref": "com.example.video",
            "fingerprint": FINGERPRINT_A,
            "expires_at": approvals.json()[0]["expires_at"],
        }
    ]
    expires_at = datetime.fromisoformat(approvals.json()[0]["expires_at"].replace("Z", "+00:00"))
    assert row.decided_at == frozen_decision_time
    assert expires_at == frozen_decision_time + timedelta(minutes=15)

    # A content approval is deliberately not a child-wide policy exception.
    current = await database_session.scalar(
        select(PolicyBundle).where(
            PolicyBundle.child_profile_id == paired_device.parent.child_id,
            PolicyBundle.is_current.is_(True),
        )
    )
    assert current is not None
    assert current.policy_version == 1
    assert not current.new_value["temporary_overrides"]

    # Repeated approval is a replay, not another fifteen-minute grant.
    repeat = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {paired_device.parent.token}"},
        json={"reason": "Reviewed again"},
    )
    assert repeat.status_code == 200
    still_active = await client.get(
        "/v1/devices/me/content-approvals",
        headers={"Authorization": f"Bearer {paired_device.device_token}"},
    )
    assert still_active.json()[0]["expires_at"] == approvals.json()[0]["expires_at"]


@pytest.mark.asyncio
async def test_content_approval_isolated_to_exact_device_even_with_same_child(
    client, paired_device
) -> None:
    created = await post_content_review(client, paired_device, content_review_payload(), "device-a")
    request_id = created.json()["id"]
    approved = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {paired_device.parent.token}"},
        json={"reason": "Reviewed"},
    )
    assert approved.status_code == 200, approved.text

    second_device = await pair_additional_device(client, paired_device)
    visible_to_second = await client.get(
        "/v1/devices/me/content-approvals",
        headers={"Authorization": f"Bearer {second_device.device_token}"},
    )
    assert visible_to_second.status_code == 200, visible_to_second.text
    assert visible_to_second.json() == []

    # The same content seen on a different device needs its own decision.
    independent = await post_content_review(
        client, second_device, content_review_payload(), "device-b"
    )
    assert independent.status_code == 201, independent.text
    assert independent.json()["id"] != request_id


@pytest.mark.asyncio
async def test_content_review_denial_and_changed_fingerprint_produce_no_unrelated_approval(
    client, paired_device
) -> None:
    created = await post_content_review(
        client, paired_device, content_review_payload(), "content-review-deny"
    )
    request_id = created.json()["id"]
    denied = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{request_id}/deny",
        headers={"Authorization": f"Bearer {paired_device.parent.token}"},
        json={"reason": "Not approved"},
    )
    assert denied.status_code == 200, denied.text
    duplicate_denial = await post_content_review(
        client, paired_device, content_review_payload(), "content-review-deny-repeat"
    )
    assert duplicate_denial.status_code == 201, duplicate_denial.text
    assert duplicate_denial.json()["id"] == request_id
    assert duplicate_denial.json()["state"] == "DENIED"
    approvals = await client.get(
        "/v1/devices/me/content-approvals",
        headers={"Authorization": f"Bearer {paired_device.device_token}"},
    )
    assert approvals.json() == []

    changed = await post_content_review(
        client,
        paired_device,
        content_review_payload(fingerprint=FINGERPRINT_B),
        "content-review-changed-fingerprint",
    )
    assert changed.status_code == 201, changed.text
    assert changed.json()["id"] != request_id


@pytest.mark.asyncio
async def test_content_review_idempotency_conflict_and_concurrent_tuple_dedupe(
    client, paired_device
) -> None:
    first = await post_content_review(client, paired_device, content_review_payload(), "same-key")
    assert first.status_code == 201, first.text
    different_payload = await post_content_review(
        client,
        paired_device,
        content_review_payload(fingerprint=FINGERPRINT_B),
        "same-key",
    )
    assert different_payload.status_code == 409

    results = await asyncio.gather(
        post_content_review(
            client,
            paired_device,
            content_review_payload(fingerprint=FINGERPRINT_C),
            "concurrent-a",
        ),
        post_content_review(
            client,
            paired_device,
            content_review_payload(fingerprint=FINGERPRINT_C),
            "concurrent-b",
        ),
    )
    assert [result.status_code for result in results] == [201, 201]
    assert results[0].json()["id"] == results[1].json()["id"]
    assert results[0].json()["id"] != first.json()["id"]


@pytest.mark.asyncio
async def test_request_create_idempotency_key_is_bound_to_authenticated_device(
    client, paired_device
) -> None:
    key = "same-key-must-not-cross-device"
    first = await post_content_review(client, paired_device, content_review_payload(), key)
    assert first.status_code == 201, first.text

    second_device = await pair_additional_device(client, paired_device)
    cross_device = await post_content_review(
        client, second_device, content_review_payload(), key
    )
    assert cross_device.status_code == 409
    assert first.json()["id"] not in cross_device.text


@pytest.mark.asyncio
async def test_parent_can_set_a_signed_content_block_threshold_without_changing_alert_threshold(
    client, parent_a
) -> None:
    url = (
        f"/v1/families/{parent_a.family_id}/children/{parent_a.child_id}"
        "/policy/mutations"
    )
    headers = {"Authorization": f"Bearer {parent_a.token}"}
    updated = await client.post(
        url,
        headers=headers,
        json={
            "operation": "CONTENT_BLOCK_THRESHOLD",
            "target": "content_safety",
            "value": "CRITICAL",
        },
    )
    assert updated.status_code == 200, updated.text
    bundle = updated.json()["bundle"]
    assert bundle["content_safety"]["content_block_threshold"] == "CRITICAL"
    assert bundle["communication_safety"]["severity_threshold"] == "HIGH"
    assert verify_signed_bundle(bundle, {"test-key": app.state.test_public_key})

    invalid = await client.post(
        url,
        headers=headers,
        json={
            "operation": "CONTENT_BLOCK_THRESHOLD",
            "target": "content_safety",
            "value": "UNSAFE",
        },
    )
    assert invalid.status_code == 422


@pytest.mark.asyncio
async def test_minimized_content_event_aliases_are_normalized_and_raw_fields_rejected(
    client, paired_device, database_session
) -> None:
    path = "/v1/devices/me/events"
    event = {
        "event_type": "SAFETY_CONTENT_RISK",
        "occurred_at": "2026-08-16T12:00:00Z",
        "app_ref": "com.example.video",
        "category": "SELF_HARM",
        "severity": "HIGH",
        "confidence": 0.9,
        "reason_code": "SELF_HARM_DIRECT",
        "signal_source": "ACCESSIBILITY_TEXT",
        "action": "BLOCK_AND_REQUEST",
        "classifier_version": "rules-v1",
        "capability_level": "BEST_EFFORT",
        "content_fingerprint": FINGERPRINT_A,
    }
    body = json.dumps({"events": [event]}, separators=(",", ":")).encode()
    accepted = await client.post(
        path,
        content=body,
        headers={**paired_device.signed_headers(path, body), "Content-Type": "application/json"},
    )
    assert accepted.status_code == 202, accepted.text
    row = await database_session.scalar(
        select(SafetyEvent).where(SafetyEvent.content_fingerprint == FINGERPRINT_A)
    )
    assert row is not None
    assert row.category == "SELF_HARM_SUICIDE"
    assert row.signal_source == "ACCESSIBILITY_TEXT"
    assert row.action == "BLOCK_AND_REQUEST"
    assert row.classifier_version == "rules-v1"
    assert row.capability_level == "BEST_EFFORT"
    assert row.content_fingerprint == FINGERPRINT_A

    event["raw_accessibility_text"] = "RAW-EVENT-CANARY-DO-NOT-PERSIST"
    raw_body = json.dumps({"events": [event]}, separators=(",", ":")).encode()
    rejected = await client.post(
        path,
        content=raw_body,
        headers={
            **paired_device.signed_headers(path, raw_body),
            "Content-Type": "application/json",
        },
    )
    assert rejected.status_code == 422
    assert "RAW-EVENT-CANARY-DO-NOT-PERSIST" not in rejected.text
    # The backend suite deliberately shares a database. This test is concerned
    # with persistence shape, not with contributing an unrelated alert to a
    # later notification-routing assertion.
    await database_session.execute(
        delete(SafetyEvent).where(SafetyEvent.event_type == "SAFETY_CONTENT_RISK")
    )
    await database_session.commit()


@pytest.mark.asyncio
async def test_content_risk_events_require_the_full_minimized_verdict_and_safe_destinations(
    client, paired_device
) -> None:
    path = "/v1/devices/me/events"
    content_event = {
        "event_type": "SAFETY_CONTENT_RISK",
        "occurred_at": "2026-08-16T12:00:00Z",
        "app_ref": "com.example.video",
        "category": "SELF_HARM_SUICIDE",
        "severity": "HIGH",
        "confidence": 0.9,
        "reason_code": "SELF_HARM_DIRECT",
        "signal_source": "ACCESSIBILITY_TEXT",
        "action": "BLOCK_AND_REQUEST",
        "classifier_version": "rules-v1",
        "capability_level": "BEST_EFFORT",
        "content_fingerprint": FINGERPRINT_A,
    }

    for field in (
        "app_ref",
        "category",
        "severity",
        "confidence",
        "reason_code",
        "signal_source",
        "action",
        "classifier_version",
        "capability_level",
        "content_fingerprint",
    ):
        event = {key: value for key, value in content_event.items() if key != field}
        body = json.dumps({"events": [event]}, separators=(",", ":")).encode()
        response = await client.post(
            path,
            content=body,
            headers={
                **paired_device.signed_headers(path, body),
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 422, field

    arbitrary_reason = {**content_event, "reason_code": "UNREVIEWED_FREEFORM_REASON"}
    body = json.dumps({"events": [arbitrary_reason]}, separators=(",", ":")).encode()
    assert (
        await client.post(
            path,
            content=body,
            headers={
                **paired_device.signed_headers(path, body),
                "Content-Type": "application/json",
            },
        )
    ).status_code == 422

    raw_domain = "https://risk.example/path?RAW-DOMAIN-CANARY"
    body = json.dumps(
        {
            "events": [
                {
                    "event_type": "DOMAIN",
                    "occurred_at": "2026-08-16T12:00:00Z",
                    "domain": raw_domain,
                }
            ]
        },
        separators=(",", ":"),
    ).encode()
    rejected_domain = await client.post(
        path,
        content=body,
        headers={**paired_device.signed_headers(path, body), "Content-Type": "application/json"},
    )
    assert rejected_domain.status_code == 422
    assert raw_domain not in rejected_domain.text

    # Legacy safety events remain compatible; only content-risk records need
    # the full verdict tuple.
    legacy_body = json.dumps(
        {"events": [{"event_type": "SAFETY_RISK", "occurred_at": "2026-08-16T12:00:00Z"}]},
        separators=(",", ":"),
    ).encode()
    legacy = await client.post(
        path,
        content=legacy_body,
        headers={
            **paired_device.signed_headers(path, legacy_body),
            "Content-Type": "application/json",
        },
    )
    assert legacy.status_code == 202, legacy.text

    legacy_raw_body = json.dumps(
        {
            "events": [
                {
                    "event_type": "SAFETY_RISK",
                    "occurred_at": "2026-08-16T12:00:00Z",
                    "reason_code": "RAW LEGACY SAFETY TEXT",
                }
            ]
        },
        separators=(",", ":"),
    ).encode()
    legacy_raw = await client.post(
        path,
        content=legacy_raw_body,
        headers={
            **paired_device.signed_headers(path, legacy_raw_body),
            "Content-Type": "application/json",
        },
    )
    assert legacy_raw.status_code == 422
