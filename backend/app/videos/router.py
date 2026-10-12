# ruff: noqa: E501
import hashlib
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.handler_support import (
    ChildProfile,
    Device,
    Parent,
    RequestOut,
    RequestRow,
    broadcaster,
    create_next_bundle,
    current_bundle_for_update,
    current_device,
    current_parent,
    family_for_parent,
    get_session,
    verify_device_request_headers,
)
from ..requests.models import RequestState, RequestType
from .classifier import (
    LEARNING_PRESETS,
    VIDEO_ID_PATTERN,
    VideoMetadata,
    VideoTopic,
    classify_video,
    fetch_video_metadata,
    topics_for_age_band,
)
from .models import ChildVideoSettings

router = APIRouter()

UNVERIFIED_LABEL = "Video details unavailable"
DECISION_WINDOW = timedelta(hours=24)
YOUTUBE_DOMAINS = (
    "youtube.com",
    "youtu.be",
    "googlevideo.com",
    "ytimg.com",
    "youtube-nocookie.com",
    "youtubei.googleapis.com",
)
YOUTUBE_RULE_PREFIX = "youtube-guardian-only-"
LEARNING_ONLY = VideoTopic(
    "LEARNING_ONLY", "Outside your learning picks and trusted channels", (), "OLDER_TEEN"
)
SOS_LABELS = {"SCARY_CONTENT": "saw something scary", "NEED_HELP": "needs help"}


class VideoCheckIn(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID_PATTERN)


class VideoCheckOut(BaseModel):
    video_id: str
    title: str | None
    channel: str | None
    verdict: Literal["ALLOW", "REVIEW", "BLOCKED"]
    topic: str | None
    request_id: UUID | None


class VideoTopicOut(BaseModel):
    code: str
    label: str
    keywords: list[str]


class LearningTopic(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    keywords: str = Field(min_length=1, max_length=120)


class VideoPick(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID_PATTERN)
    title: str | None = Field(default=None, max_length=300)
    channel: str | None = Field(default=None, max_length=200)


class VideoSettingsBody(BaseModel):
    trusted_channels: list[str] = Field(default_factory=list, max_length=200)
    blocked_channels: list[str] = Field(default_factory=list, max_length=200)
    learning_topics: list[LearningTopic] = Field(default_factory=list, max_length=30)
    picks: list[VideoPick] = Field(default_factory=list, max_length=100)
    learning_only: bool = False
    hide_shorts: bool = True
    hide_comments: bool = True
    autoplay_next: bool = False
    youtube_guardian_only: bool = False


class VideoSettingsOut(VideoSettingsBody):
    rules_revision: int


class VideoRulesOut(BaseModel):
    age_band: str
    topics: list[VideoTopicOut]
    suggested_learning_topics: list[LearningTopic]
    settings: VideoSettingsOut


class DeviceVideoSettingsOut(BaseModel):
    age_band: str
    learning_topics: list[LearningTopic]
    picks: list[VideoPick]
    learning_only: bool
    hide_shorts: bool
    hide_comments: bool
    autoplay_next: bool


class SosIn(BaseModel):
    kind: Literal["SCARY_CONTENT", "NEED_HELP"]
    video_id: str | None = Field(default=None, pattern=VIDEO_ID_PATTERN)


def video_subject(video_id: str) -> str:
    return f"youtube:{video_id}"


def _channel_key(value: str | None) -> str:
    return " ".join((value or "").lower().split())


def _clean_channels(values: list[str]) -> list[str]:
    seen: dict[str, str] = {}
    for value in values:
        cleaned = " ".join(value.split())[:200]
        if cleaned and _channel_key(cleaned) not in seen:
            seen[_channel_key(cleaned)] = cleaned
    return list(seen.values())


def rules_fingerprint(age_band: str, settings: ChildVideoSettings | None) -> str:
    revision = settings.rules_revision if settings is not None else 0
    return hashlib.sha256(f"{age_band}:{revision}".encode()).hexdigest()


async def _settings_for(session: AsyncSession, child_id: UUID) -> ChildVideoSettings | None:
    settings = await session.scalar(
        select(ChildVideoSettings).where(ChildVideoSettings.child_profile_id == child_id)
    )
    return settings if isinstance(settings, ChildVideoSettings) else None


def _settings_out(settings: ChildVideoSettings | None) -> VideoSettingsOut:
    if settings is None:
        return VideoSettingsOut(rules_revision=0)
    return VideoSettingsOut(
        trusted_channels=list(settings.trusted_channels or []),
        blocked_channels=list(settings.blocked_channels or []),
        learning_topics=[LearningTopic.model_validate(t) for t in settings.learning_topics or []],
        picks=[VideoPick.model_validate(p) for p in settings.picks or []],
        learning_only=settings.learning_only,
        hide_shorts=settings.hide_shorts,
        hide_comments=settings.hide_comments,
        autoplay_next=settings.autoplay_next,
        youtube_guardian_only=settings.youtube_guardian_only,
        rules_revision=settings.rules_revision,
    )


async def check_video(
    body: VideoCheckIn,
    request: Request,
    device: Device = Depends(current_device),
    session: AsyncSession = Depends(get_session),
) -> VideoCheckOut:
    await verify_device_request_headers(request, device, session)
    child = await session.get(ChildProfile, device.child_profile_id)
    if child is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Child profile not found")
    settings = await _settings_for(session, child.id)
    fingerprint = rules_fingerprint(child.age_band, settings)
    metadata = await fetch_video_metadata(body.video_id)
    shown = metadata or VideoMetadata(title=None, channel=None)
    picked = settings is not None and any(
        p.get("video_id") == body.video_id for p in settings.picks or []
    )
    channel = _channel_key(shown.channel)
    blocked = (
        settings is not None
        and bool(channel)
        and channel in {_channel_key(c) for c in settings.blocked_channels or []}
    )
    trusted = (
        settings is not None
        and bool(channel)
        and channel in {_channel_key(c) for c in settings.trusted_channels or []}
    )
    if blocked:
        return VideoCheckOut(
            video_id=body.video_id,
            title=shown.title,
            channel=shown.channel,
            verdict="BLOCKED",
            topic="Channel blocked by your parent",
            request_id=None,
        )
    topic = classify_video(metadata, child.age_band) if metadata else None
    if (
        metadata is not None
        and topic is not None
        and (picked or trusted)
        and topic.code != "YOUTUBE_RESTRICTED"
    ):
        topic = None
    if (
        metadata is not None
        and topic is None
        and settings is not None
        and settings.learning_only
        and not (picked or trusted)
    ):
        topic = LEARNING_ONLY
    if metadata is not None and topic is None:
        return VideoCheckOut(
            video_id=body.video_id,
            title=shown.title,
            channel=shown.channel,
            verdict="ALLOW",
            topic=None,
            request_id=None,
        )
    topic_label = topic.label if topic else UNVERIFIED_LABEL
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"video-review:{device.id}:{body.video_id}"},
    )
    now = datetime.now(UTC)
    previous = await session.scalar(
        select(RequestRow)
        .where(
            RequestRow.device_id == device.id,
            RequestRow.request_type == RequestType.VIDEO_REVIEW.value,
            RequestRow.subject == video_subject(body.video_id),
            RequestRow.created_at > now - DECISION_WINDOW,
        )
        .order_by(RequestRow.created_at.desc())
    )
    if previous is not None and previous.video_rules_fingerprint != fingerprint:
        if previous.state == RequestState.PENDING.value:
            previous.state = RequestState.CANCELLED.value
        previous = None
    if previous is not None:
        if previous.state == RequestState.APPROVED.value:
            return VideoCheckOut(
                video_id=body.video_id,
                title=shown.title,
                channel=shown.channel,
                verdict="ALLOW",
                topic=topic_label,
                request_id=previous.id,
            )
        if previous.state == RequestState.DENIED.value:
            return VideoCheckOut(
                video_id=body.video_id,
                title=shown.title,
                channel=shown.channel,
                verdict="BLOCKED",
                topic=topic_label,
                request_id=previous.id,
            )
        if previous.state == RequestState.PENDING.value:
            if not _expire_if_due(previous, now):
                return VideoCheckOut(
                    video_id=body.video_id,
                    title=shown.title,
                    channel=shown.channel,
                    verdict="REVIEW",
                    topic=topic_label,
                    request_id=previous.id,
                )
    row = RequestRow(
        child_profile_id=device.child_profile_id,
        device_id=device.id,
        request_type=RequestType.VIDEO_REVIEW.value,
        subject=video_subject(body.video_id),
        reason=" | ".join(
            [topic_label, shown.title or "Untitled video", shown.channel or "Unknown channel"]
        )[:1000],
        expires_at=now + timedelta(hours=1),
        video_rules_fingerprint=fingerprint,
    )
    session.add(row)
    await session.commit()
    broadcaster.publish(
        child.family_id,
        {"type": "request-created", "request_id": str(row.id)},
        device.child_profile_id,
    )
    return VideoCheckOut(
        video_id=body.video_id,
        title=shown.title,
        channel=shown.channel,
        verdict="REVIEW",
        topic=topic_label,
        request_id=row.id,
    )


async def device_request(
    request_id: UUID,
    device: Device = Depends(current_device),
    session: AsyncSession = Depends(get_session),
) -> RequestOut:
    row = await session.scalar(
        select(RequestRow).where(RequestRow.id == request_id, RequestRow.device_id == device.id)
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found")
    if _expire_if_due(row, datetime.now(UTC)):
        await session.commit()
        await session.refresh(row)
    return RequestOut.model_validate(row)


def _expire_if_due(row: RequestRow, now: datetime) -> bool:
    if row.state != RequestState.PENDING.value or row.expires_at is None or row.expires_at > now:
        return False
    row.state = RequestState.EXPIRED.value
    return True


async def video_rules(
    family_id: UUID,
    child_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> VideoRulesOut:
    await family_for_parent(session, parent, family_id)
    child = await session.scalar(
        select(ChildProfile).where(ChildProfile.id == child_id, ChildProfile.family_id == family_id)
    )
    if child is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Child not found")
    return VideoRulesOut(
        age_band=child.age_band,
        topics=[
            VideoTopicOut(code=t.code, label=t.label, keywords=list(t.keywords))
            for t in topics_for_age_band(child.age_band)
        ],
        suggested_learning_topics=[
            LearningTopic(label=p.label, keywords=p.keywords)
            for p in LEARNING_PRESETS.get(child.age_band, ())
        ],
        settings=_settings_out(await _settings_for(session, child.id)),
    )


async def update_video_settings(
    family_id: UUID,
    child_id: UUID,
    body: VideoSettingsBody,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> VideoSettingsOut:
    await family_for_parent(session, parent, family_id)
    child = await session.scalar(
        select(ChildProfile)
        .where(ChildProfile.id == child_id, ChildProfile.family_id == family_id)
        .with_for_update()
    )
    if child is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Child not found")
    settings = await _settings_for(session, child.id)
    if settings is None:
        settings = ChildVideoSettings(child_profile_id=child.id, rules_revision=1)
        session.add(settings)
        previous_guardian_only = False
        created = True
    else:
        previous_guardian_only = settings.youtube_guardian_only
        created = False
    rules_changed = False
    trusted = _clean_channels(body.trusted_channels)
    blocked = _clean_channels(body.blocked_channels)
    blocked_keys = {_channel_key(c) for c in blocked}
    trusted = [c for c in trusted if _channel_key(c) not in blocked_keys]
    if (
        [_channel_key(c) for c in settings.trusted_channels or []]
        != [_channel_key(c) for c in trusted]
        or [_channel_key(c) for c in settings.blocked_channels or []]
        != [_channel_key(c) for c in blocked]
        or settings.learning_only != body.learning_only
        or {p.get("video_id") for p in settings.picks or []} != {p.video_id for p in body.picks}
    ):
        rules_changed = True
    known = {p.get("video_id"): p for p in settings.picks or []}
    picks: list[dict[str, object]] = []
    for pick in {p.video_id: p for p in body.picks}.values():
        stored = known.get(pick.video_id)
        if stored is not None and stored.get("title"):
            picks.append(stored)
            continue
        metadata = await fetch_video_metadata(pick.video_id)
        picks.append(
            {
                "video_id": pick.video_id,
                "title": metadata.title if metadata else pick.title,
                "channel": metadata.channel if metadata else pick.channel,
            }
        )
    settings.trusted_channels = trusted
    settings.blocked_channels = blocked
    settings.learning_topics = [t.model_dump() for t in body.learning_topics]
    settings.picks = picks
    settings.learning_only = body.learning_only
    settings.hide_shorts = body.hide_shorts
    settings.hide_comments = body.hide_comments
    settings.autoplay_next = body.autoplay_next
    settings.youtube_guardian_only = body.youtube_guardian_only
    if rules_changed and not created:
        settings.rules_revision += 1
    policy_version: int | None = None
    if previous_guardian_only != body.youtube_guardian_only:
        policy_version = await _apply_youtube_domain_rules(
            session, child, parent, body.youtube_guardian_only
        )
    await session.commit()
    await session.refresh(settings)
    broadcaster.publish(
        family_id,
        {"type": "video-settings-changed", "rules_revision": settings.rules_revision},
        child.id,
    )
    if policy_version is not None:
        broadcaster.publish(
            family_id,
            {"type": "policy-version-changed", "policy_version": policy_version},
            child.id,
        )
    return _settings_out(settings)


async def _apply_youtube_domain_rules(
    session: AsyncSession, child: ChildProfile, parent: Parent, enabled: bool
) -> int:
    current = await current_bundle_for_update(session, child.id)
    if current is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Policy is unavailable")
    policy = deepcopy(current.new_value)
    policy["signature"] = ""
    raw_rules = policy.get("domain_rules")
    rules = [r for r in raw_rules if isinstance(r, dict)] if isinstance(raw_rules, list) else []
    rules = [r for r in rules if not str(r.get("rule_id", "")).startswith(YOUTUBE_RULE_PREFIX)]
    if enabled:
        youtube = set(YOUTUBE_DOMAINS)
        rules = [r for r in rules if r.get("domain") not in youtube]
        rules.extend(
            {
                "rule_id": f"{YOUTUBE_RULE_PREFIX}{domain}",
                "domain": domain,
                "match": "SUBDOMAINS",
                "action": "BLOCK",
            }
            for domain in YOUTUBE_DOMAINS
        )
    policy["domain_rules"] = rules
    bundle = await create_next_bundle(
        session,
        child.id,
        parent.id,
        policy,
        {"operation": "YOUTUBE_GUARDIAN_ONLY", "value": enabled},
    )
    child.policy_document = bundle.new_value
    return bundle.policy_version


async def device_video_settings(
    device: Device = Depends(current_device),
    session: AsyncSession = Depends(get_session),
) -> DeviceVideoSettingsOut:
    child = await session.get(ChildProfile, device.child_profile_id)
    if child is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Child profile not found")
    settings = _settings_out(await _settings_for(session, child.id))
    topics = settings.learning_topics or [
        LearningTopic(label=p.label, keywords=p.keywords)
        for p in LEARNING_PRESETS.get(child.age_band, ())
    ]
    return DeviceVideoSettingsOut(
        age_band=child.age_band,
        learning_topics=topics,
        picks=settings.picks,
        learning_only=settings.learning_only,
        hide_shorts=settings.hide_shorts,
        hide_comments=settings.hide_comments,
        autoplay_next=settings.autoplay_next,
    )


async def send_sos(
    body: SosIn,
    request: Request,
    device: Device = Depends(current_device),
    session: AsyncSession = Depends(get_session),
) -> RequestOut:
    await verify_device_request_headers(request, device, session)
    child = await session.get(ChildProfile, device.child_profile_id)
    if child is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Child profile not found")
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"sos:{device.id}"},
    )
    now = datetime.now(UTC)
    subject = video_subject(body.video_id) if body.video_id else None
    existing = await session.scalar(
        select(RequestRow).where(
            RequestRow.device_id == device.id,
            RequestRow.request_type == RequestType.SOS.value,
            RequestRow.state == RequestState.PENDING.value,
            RequestRow.subject.is_(None) if subject is None else RequestRow.subject == subject,
            RequestRow.created_at > now - timedelta(minutes=2),
        )
    )
    if existing is not None:
        return RequestOut.model_validate(existing)
    title = None
    if body.video_id:
        metadata = await fetch_video_metadata(body.video_id)
        title = metadata.title if metadata else None
    row = RequestRow(
        child_profile_id=child.id,
        device_id=device.id,
        request_type=RequestType.SOS.value,
        subject=subject,
        reason=" | ".join([body.kind, SOS_LABELS[body.kind], title or ""])[:1000],
        expires_at=now + timedelta(hours=24),
    )
    session.add(row)
    await session.commit()
    broadcaster.publish(
        child.family_id, {"type": "request-created", "request_id": str(row.id)}, child.id
    )
    return RequestOut.model_validate(row)


router.add_api_route(
    "/v1/devices/me/videos/check", check_video, methods=["POST"], response_model=VideoCheckOut
)
router.add_api_route(
    "/v1/devices/me/requests/{request_id}",
    device_request,
    methods=["GET"],
    response_model=RequestOut,
)
router.add_api_route(
    "/v1/families/{family_id}/children/{child_id}/video-rules",
    video_rules,
    methods=["GET"],
    response_model=VideoRulesOut,
)
router.add_api_route(
    "/v1/families/{family_id}/children/{child_id}/video-settings",
    update_video_settings,
    methods=["PUT"],
    response_model=VideoSettingsOut,
)
router.add_api_route(
    "/v1/devices/me/video-settings",
    device_video_settings,
    methods=["GET"],
    response_model=DeviceVideoSettingsOut,
)
router.add_api_route(
    "/v1/devices/me/sos",
    send_sos,
    methods=["POST"],
    response_model=RequestOut,
    status_code=status.HTTP_201_CREATED,
)
