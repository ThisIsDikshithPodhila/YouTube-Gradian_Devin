# ruff: noqa: E501
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
    current_device,
    current_parent,
    family_for_parent,
    get_session,
    verify_device_request_headers,
)
from ..requests.models import RequestState, RequestType
from .classifier import (
    VIDEO_ID_PATTERN,
    VideoMetadata,
    classify_video,
    fetch_video_metadata,
    topics_for_age_band,
)

router = APIRouter()

UNVERIFIED_LABEL = "Video details unavailable"
DECISION_WINDOW = timedelta(hours=24)


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


class VideoRulesOut(BaseModel):
    age_band: str
    topics: list[VideoTopicOut]


def video_subject(video_id: str) -> str:
    return f"youtube:{video_id}"


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
    metadata = await fetch_video_metadata(body.video_id)
    topic = classify_video(metadata, child.age_band) if metadata else None
    shown = metadata or VideoMetadata(title=None, channel=None)
    if metadata is not None and topic is None:
        return VideoCheckOut(video_id=body.video_id, title=shown.title, channel=shown.channel, verdict="ALLOW", topic=None, request_id=None)
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
    if previous is not None:
        if previous.state == RequestState.APPROVED.value:
            return VideoCheckOut(video_id=body.video_id, title=shown.title, channel=shown.channel, verdict="ALLOW", topic=topic_label, request_id=previous.id)
        if previous.state == RequestState.DENIED.value:
            return VideoCheckOut(video_id=body.video_id, title=shown.title, channel=shown.channel, verdict="BLOCKED", topic=topic_label, request_id=previous.id)
        if previous.state == RequestState.PENDING.value:
            if not _expire_if_due(previous, now):
                return VideoCheckOut(video_id=body.video_id, title=shown.title, channel=shown.channel, verdict="REVIEW", topic=topic_label, request_id=previous.id)
    row = RequestRow(
        child_profile_id=device.child_profile_id,
        device_id=device.id,
        request_type=RequestType.VIDEO_REVIEW.value,
        subject=video_subject(body.video_id),
        reason=" | ".join([topic_label, shown.title or "Untitled video", shown.channel or "Unknown channel"])[:1000],
        expires_at=now + timedelta(hours=1),
    )
    session.add(row)
    await session.commit()
    broadcaster.publish(
        child.family_id,
        {"type": "request-created", "request_id": str(row.id)},
        device.child_profile_id,
    )
    return VideoCheckOut(video_id=body.video_id, title=shown.title, channel=shown.channel, verdict="REVIEW", topic=topic_label, request_id=row.id)


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
        topics=[VideoTopicOut(code=t.code, label=t.label, keywords=list(t.keywords)) for t in topics_for_age_band(child.age_band)],
    )


router.add_api_route("/v1/devices/me/videos/check", check_video, methods=["POST"], response_model=VideoCheckOut)
router.add_api_route("/v1/devices/me/requests/{request_id}", device_request, methods=["GET"], response_model=RequestOut)
router.add_api_route("/v1/families/{family_id}/children/{child_id}/video-rules", video_rules, methods=["GET"], response_model=VideoRulesOut)
