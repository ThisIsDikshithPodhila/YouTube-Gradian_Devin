import json
from pathlib import Path

import pytest
from conftest import PairedDevice
from jsonschema import Draft202012Validator, FormatChecker

from app.videos import router as video_router
from app.videos.classifier import VideoMetadata, classify_video, parse_watch_page

SCHEMA = json.loads(
    (
        Path(__file__).parents[2]
        / "packages"
        / "policy-schema"
        / "schema"
        / "policy-bundle.schema.json"
    ).read_text()
)

VIDEOS = {
    "goreVideo01": VideoMetadata(title="Brutal gore compilation", channel="Shock Clips"),
    "scienceVid1": VideoMetadata(title="Volcano science project", channel="Science Kids"),
    "randomVideo": VideoMetadata(title="Funny cats", channel="Cat Channel"),
}


@pytest.fixture(autouse=True)
def fake_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fetch(video_id: str) -> VideoMetadata | None:
        return VIDEOS.get(video_id)

    monkeypatch.setattr(video_router, "fetch_video_metadata", fetch)


def parent_headers(device: PairedDevice) -> dict[str, str]:
    return {"Authorization": f"Bearer {device.parent.token}"}


def settings_path(device: PairedDevice) -> str:
    return (
        f"/v1/families/{device.parent.family_id}/children/{device.parent.child_id}/video-settings"
    )


async def check(client, device: PairedDevice, video_id: str) -> dict[str, object]:
    path = "/v1/devices/me/videos/check"
    body = json.dumps({"video_id": video_id}, separators=(",", ":")).encode()
    response = await client.post(path, content=body, headers=device.signed_headers(path, body))
    assert response.status_code == 200, response.text
    return dict(response.json())


async def put_settings(client, device: PairedDevice, **values: object) -> dict[str, object]:
    response = await client.put(settings_path(device), json=values, headers=parent_headers(device))
    assert response.status_code == 200, response.text
    return dict(response.json())


async def test_channel_lists_picks_and_learning_only_drive_the_video_check(
    client, paired_device: PairedDevice
) -> None:
    assert (await check(client, paired_device, "goreVideo01"))["verdict"] == "REVIEW"
    await put_settings(client, paired_device, blocked_channels=["shock  clips"])
    blocked = await check(client, paired_device, "goreVideo01")
    assert blocked["verdict"] == "BLOCKED" and blocked["request_id"] is None

    await put_settings(client, paired_device, learning_only=True, trusted_channels=["Science Kids"])
    assert (await check(client, paired_device, "scienceVid1"))["verdict"] == "ALLOW"
    outside = await check(client, paired_device, "randomVideo")
    assert outside["verdict"] == "REVIEW"
    assert outside["topic"] == "Outside your learning picks and trusted channels"

    saved = await put_settings(
        client, paired_device, learning_only=True, picks=[{"video_id": "randomVideo"}]
    )
    assert saved["picks"] == [
        {"video_id": "randomVideo", "title": "Funny cats", "channel": "Cat Channel"}
    ]
    assert (await check(client, paired_device, "randomVideo"))["verdict"] == "ALLOW"


async def test_rule_change_requires_a_fresh_parent_decision(
    client, paired_device: PairedDevice
) -> None:
    first = await check(client, paired_device, "goreVideo01")
    approved = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{first['request_id']}/approve",
        json={"reason": "ok"},
        headers=parent_headers(paired_device) | {"Idempotency-Key": "approve-1"},
    )
    assert approved.status_code == 200, approved.text
    assert (await check(client, paired_device, "goreVideo01"))["verdict"] == "ALLOW"

    await put_settings(client, paired_device, blocked_channels=["Someone Else"])
    again = await check(client, paired_device, "goreVideo01")
    assert again["verdict"] == "REVIEW" and again["request_id"] != first["request_id"]

    await put_settings(
        client, paired_device, blocked_channels=["Someone Else"], hide_comments=False
    )
    same = await check(client, paired_device, "goreVideo01")
    assert same["request_id"] == again["request_id"]


async def test_youtube_guardian_only_publishes_signed_domain_blocks(
    client, paired_device: PairedDevice
) -> None:
    policy_path = (
        f"/v1/families/{paired_device.parent.family_id}/children/{paired_device.parent.child_id}"
    )
    await put_settings(client, paired_device, youtube_guardian_only=True)
    bundle = (await client.get(policy_path, headers=parent_headers(paired_device))).json()[
        "policy_document"
    ]
    rules = {rule["domain"]: rule for rule in bundle["domain_rules"]}
    assert (
        rules["youtube.com"]["action"] == "BLOCK"
        and rules["googlevideo.com"]["match"] == "SUBDOMAINS"
    )
    assert (
        list(Draft202012Validator(SCHEMA, format_checker=FormatChecker()).iter_errors(bundle)) == []
    )

    await put_settings(client, paired_device, youtube_guardian_only=False)
    bundle = (await client.get(policy_path, headers=parent_headers(paired_device))).json()[
        "policy_document"
    ]
    assert all(rule["domain"] != "youtube.com" for rule in bundle["domain_rules"])


async def test_sos_alert_is_deduplicated_and_acknowledged_without_policy_change(
    client, paired_device: PairedDevice
) -> None:
    path = "/v1/devices/me/sos"
    body = json.dumps(
        {"kind": "SCARY_CONTENT", "video_id": "goreVideo01"}, separators=(",", ":")
    ).encode()
    first = await client.post(path, content=body, headers=paired_device.signed_headers(path, body))
    second = await client.post(path, content=body, headers=paired_device.signed_headers(path, body))
    assert first.status_code == 201, first.text
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["request_type"] == "SOS"
    assert first.json()["reason"] == "SCARY_CONTENT | saw something scary | Brutal gore compilation"
    acknowledged = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/requests/{first.json()['id']}/approve",
        json={"reason": "On my way"},
        headers=parent_headers(paired_device) | {"Idempotency-Key": "sos-ack"},
    )
    assert acknowledged.status_code == 200, acknowledged.text
    assert acknowledged.json()["state"] == "APPROVED"


async def test_device_settings_fall_back_to_age_presets(
    client, paired_device: PairedDevice
) -> None:
    response = await client.get(
        "/v1/devices/me/video-settings",
        headers={"Authorization": f"Bearer {paired_device.device_token}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["hide_shorts"] is True and body["autoplay_next"] is False
    assert body["learning_topics"][0]["label"]


def test_watch_page_age_gate_and_family_safe_flags_are_parsed() -> None:
    player = {
        "playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in to confirm your age"},
        "videoDetails": {"keywords": ["prank"], "shortDescription": "desc"},
        "microformat": {"playerMicroformatRenderer": {"isFamilySafe": False, "category": "Comedy"}},
    }
    page = f"<script>var ytInitialPlayerResponse = {json.dumps(player)};var meta = 1;</script>"
    details = parse_watch_page(page)
    assert details is not None and details.age_restricted and details.family_safe is False
    assert details.category == "Comedy" and details.keywords == ("prank",)
    topic = classify_video(VideoMetadata(title="Fun", channel="C", family_safe=False), "TEEN")
    assert topic is not None and topic.code == "YOUTUBE_RESTRICTED"
    assert (
        classify_video(VideoMetadata(title="Fun", channel="C", family_safe=False), "OLDER_TEEN")
        is None
    )
    assert parse_watch_page("<html>no player</html>") is None
