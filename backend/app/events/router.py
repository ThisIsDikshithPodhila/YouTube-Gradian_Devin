# ruff: noqa: E501
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query

from ..api.handler_support import (
    UUID,
    ActivityEventOut,
    ActivityUsagePointOut,
    AsyncSession,
    ChildProfile,
    Depends,
    Device,
    DeviceCredential,
    FamilyGuardian,
    HTTPException,
    Parent,
    PolicyBundle,
    RequestRow,
    RequestState,
    SafetyEvent,
    UsageAggregate,
    UsageReportOut,
    WebEvent,
    WebSocket,
    WebSocketDisconnect,
    asyncio,
    broadcaster,
    current_parent,
    family_for_parent,
    get_session,
    hashlib,
    parent_from_access,
    select,
    usage_report,
)
from .reports import resolved_usage_snapshots

router = APIRouter()


async def family_activity(
    family_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, object]]:
    await family_for_parent(session, parent, family_id)
    web_events = list(
        (
            await session.scalars(
                select(WebEvent)
                .join(Device, Device.id == WebEvent.device_id)
                .join(ChildProfile, ChildProfile.id == Device.child_profile_id)
                .where(ChildProfile.family_id == family_id)
                .order_by(WebEvent.occurred_at.desc())
                .limit(200)
            )
        ).all()
    )
    safety_events = list(
        (
            await session.scalars(
                select(SafetyEvent)
                .join(Device, Device.id == SafetyEvent.device_id)
                .join(ChildProfile, ChildProfile.id == Device.child_profile_id)
                .where(ChildProfile.family_id == family_id)
                .order_by(SafetyEvent.occurred_at.desc())
                .limit(200)
            )
        ).all()
    )
    events: list[dict[str, object]] = [
        {
            "id": str(event.id),
            "kind": "WEB",
            "event_type": event.event_type,
            "occurred_at": event.occurred_at.isoformat(),
            "domain": event.domain,
            "app_ref": event.app_ref,
            "category": event.category,
            "severity": None,
            "confidence": None,
            "reason_code": None,
        }
        for event in web_events
    ]
    events.extend(
        {
            "id": str(event.id),
            "kind": "SAFETY",
            "event_type": event.event_type,
            "occurred_at": event.occurred_at.isoformat(),
            "domain": event.domain,
            "app_ref": event.app_ref,
            "category": event.category,
            "severity": event.severity,
            "confidence": event.confidence,
            "reason_code": event.reason_code,
        }
        for event in safety_events
    )
    return sorted(events, key=lambda event: str(event["occurred_at"]), reverse=True)


async def family_usage(
    family_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, object]]:
    await family_for_parent(session, parent, family_id)
    usage_end = datetime.now(UTC)
    usage_start = usage_end - timedelta(days=7)
    rows = resolved_usage_snapshots(
        (
            await session.execute(
                select(UsageAggregate, Device.child_profile_id)
                .join(Device, Device.id == UsageAggregate.device_id)
                .join(ChildProfile, ChildProfile.id == Device.child_profile_id)
                .where(
                    ChildProfile.family_id == family_id,
                    UsageAggregate.occurred_at >= usage_start,
                    UsageAggregate.occurred_at <= usage_end,
                )
                .order_by(UsageAggregate.occurred_at.desc())
            )
        )
        .tuples()
        .all()
    )
    combined: dict[tuple[UUID, date, str], tuple[UsageAggregate, int, datetime]] = {}
    for row, child_id in rows:
        try:
            local_day = row.occurred_at.astimezone(ZoneInfo(row.timezone)).date()
        except Exception:
            local_day = row.occurred_at.astimezone(ZoneInfo("UTC")).date()
        if row.app_ref:
            target = f"APP:{row.app_ref}"
        elif row.category:
            target = f"CATEGORY:{row.category}"
        else:
            target = "DEVICE"
        key = (child_id, local_day, target)
        current = combined.get(key)
        if current is None:
            combined[key] = (row, row.duration_seconds, row.occurred_at)
        else:
            existing_row, seconds, occurred_at = current
            combined[key] = (
                row if row.occurred_at > occurred_at else existing_row,
                seconds + row.duration_seconds,
                max(occurred_at, row.occurred_at),
            )
    return [
        {
            "app_ref": row.app_ref,
            "category": row.category,
            "duration_seconds": duration_seconds,
            "event_type": row.event_type,
            "occurred_at": occurred_at.isoformat(),
        }
        for row, duration_seconds, occurred_at in sorted(
            (item for item in combined.values() if item[1] > 0),
            key=lambda item: item[2],
            reverse=True,
        )
    ]


async def family_usage_report(
    family_id: UUID,
    child_id: UUID | None = None,
    start: date = Query(...),
    end: date = Query(...),
    timezone: str = Query(..., min_length=1, max_length=64),
    granularity: Literal["DAILY", "WEEKLY"] = Query("DAILY"),
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, object]]:
    await family_for_parent(session, parent, family_id)
    if end <= start:
        raise HTTPException(400, "Report end must be after start")
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(timezone)
    except Exception:
        raise HTTPException(422, "Timezone must be a valid IANA timezone") from None
    return await usage_report(
        session,
        family_id=family_id,
        child_id=child_id,
        start=start,
        end=end,
        timezone=timezone,
        granularity=granularity,
    )


async def websocket_sync(
    websocket: WebSocket,
    session: AsyncSession = Depends(get_session),
) -> None:
    await _sync_socket(websocket, session, None)


async def parent_sync(websocket: WebSocket, session: AsyncSession = Depends(get_session)) -> None:
    await _sync_socket(websocket, session, "parent")


async def child_sync(websocket: WebSocket, session: AsyncSession = Depends(get_session)) -> None:
    await _sync_socket(websocket, session, "child")


async def _sync_socket(
    websocket: WebSocket, session: AsyncSession, role: Literal["parent", "child"] | None
) -> None:
    await websocket.accept()
    token = websocket.headers.get("authorization", "")
    if token.lower().startswith("bearer "):
        token = token[7:]
    family_id = websocket.query_params.get("family_id")
    child_id = websocket.query_params.get("child_profile_id")
    if not token or not family_id:
        await websocket.close(code=1008)
        return
    try:
        family_uuid = UUID(family_id)
    except ValueError:
        await websocket.close(code=1008)
        return
    parent = None
    if role != "child":
        try:
            parent = await parent_from_access(session, token)
        except HTTPException:
            pass
    device = None
    if parent is None and role != "parent":
        digest = hashlib.sha256(token.encode()).hexdigest()
        credential = await session.scalar(
            select(DeviceCredential).where(
                DeviceCredential.token_hash == digest,
                DeviceCredential.revoked_at.is_(None),
            )
        )
        if credential is not None:
            device = await session.get(Device, credential.device_id)
    if parent is None and (device is None or device.revoked_at is not None):
        await websocket.close(code=1008)
        return
    child_uuid = None
    if parent is not None:
        allowed = await session.scalar(
            select(FamilyGuardian).where(
                FamilyGuardian.family_id == family_uuid,
                FamilyGuardian.parent_id == parent.id,
            )
        )
        if allowed is None:
            await websocket.close(code=1008)
            return
        if child_id is not None:
            try:
                child_uuid = UUID(child_id)
            except ValueError:
                await websocket.close(code=1008)
                return
            child = await session.scalar(
                select(ChildProfile).where(
                    ChildProfile.id == child_uuid, ChildProfile.family_id == family_uuid
                )
            )
            if child is None:
                await websocket.close(code=1008)
                return
    else:
        assert device is not None
        child = await session.scalar(
            select(ChildProfile).where(
                ChildProfile.id == device.child_profile_id,
                ChildProfile.family_id == family_uuid,
            )
        )
        if child is None or (child_id is not None and str(child.id) != child_id):
            await websocket.close(code=1008)
            return
        child_uuid = child.id
    connection = broadcaster.subscribe(family_uuid, child_uuid)
    try:
        bundle = None
        if child_uuid is not None:
            bundle = await session.scalar(
                select(PolicyBundle).where(
                    PolicyBundle.child_profile_id == child_uuid,
                    PolicyBundle.is_current.is_(True),
                )
            )
        requests = (
            select(RequestRow.id)
            .join(ChildProfile, ChildProfile.id == RequestRow.child_profile_id)
            .where(
                ChildProfile.family_id == family_uuid,
                RequestRow.state == RequestState.PENDING.value,
                (RequestRow.expires_at.is_(None) | (RequestRow.expires_at > datetime.now(UTC))),
            )
        )
        if child_uuid is not None:
            requests = requests.where(RequestRow.child_profile_id == child_uuid)
        if device is not None:
            requests = requests.where(RequestRow.device_id == device.id)
        open_requests = [str(request_id) for request_id in (await session.scalars(requests)).all()]
        policy_version = bundle.policy_version if bundle is not None else None
        await session.rollback()
        await websocket.send_json(
            {
                "type": "catch-up",
                "policy_version": policy_version,
                "open_requests": open_requests,
            }
        )
        while True:
            receive_task = asyncio.create_task(websocket.receive_text())
            event_task = asyncio.create_task(connection.queue.get())
            done, pending = await asyncio.wait(
                {receive_task, event_task},
                timeout=30,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if not done:
                await websocket.send_json({"type": "ping"})
                continue
            if receive_task in done:
                message = receive_task.result()
                if message != "pong":
                    await websocket.send_json({"type": "pong"})
            if event_task in done:
                await websocket.send_json(event_task.result())
    except (WebSocketDisconnect, TimeoutError):
        return
    finally:
        broadcaster.unsubscribe(connection)


router.add_api_websocket_route("/v1/ws/parent", parent_sync)
router.add_api_websocket_route("/v1/ws/child", child_sync)
router.add_api_websocket_route("/v1/ws/sync", websocket_sync)
router.add_api_route(
    "/v1/families/{family_id}/activity",
    family_activity,
    methods=["GET"],
    response_model=list[ActivityEventOut],
)
router.add_api_route(
    "/v1/families/{family_id}/activity/usage",
    family_usage,
    methods=["GET"],
    response_model=list[ActivityUsagePointOut],
)
router.add_api_route(
    "/v1/families/{family_id}/usage/reports",
    family_usage_report,
    methods=["GET"],
    response_model=list[UsageReportOut],
)
