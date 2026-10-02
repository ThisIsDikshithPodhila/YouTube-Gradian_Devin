# ruff: noqa: E501
from fastapi import APIRouter, Query

from ..api.handler_support import (
    UTC,
    UUID,
    AsyncSession,
    ChildProfile,
    Depends,
    Family,
    FamilyGuardian,
    Header,
    HTTPException,
    Parent,
    RequestDecisionIn,
    RequestOut,
    RequestRow,
    RequestState,
    acquire_idempotency_lock,
    broadcaster,
    create_next_bundle,
    current_bundle_for_update,
    current_parent,
    datetime,
    deepcopy,
    family_for_parent,
    get_session,
    is_expired,
    payload_hash,
    replay_or_conflict,
    save_result,
    select,
    status,
    timedelta,
    transition,
)
from ..policies.temporary import build_more_time_override
from .models import ContentApproval

router = APIRouter()


async def list_requests(
    family_id: UUID,
    child_id: UUID | None = Query(None),
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[RequestRow]:
    await family_for_parent(session, parent, family_id)
    rows = await session.scalars(
        select(RequestRow)
        .join(ChildProfile, ChildProfile.id == RequestRow.child_profile_id)
        .where(
            ChildProfile.family_id == family_id,
            *([ChildProfile.id == child_id] if child_id is not None else []),
        )
        .order_by(RequestRow.created_at.desc())
    )
    return list(rows.all())

async def decide_request(
    request_id: UUID,
    target: RequestState,
    body: RequestDecisionIn,
    parent: Parent,
    session: AsyncSession,
    *,
    locked_row: RequestRow | None = None,
    commit: bool = True,
) -> RequestOut:
    row = locked_row or await _request_for_parent_for_update(request_id, parent, session)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found")
    if is_expired(row.expires_at):
        row.state = RequestState.EXPIRED.value
    # A delivery retry or two guardians tapping the same decision is a replay,
    # not a second policy mutation. The row lock makes this check atomic.
    if row.state == target.value:
        return RequestOut.model_validate(row)
    transition(row.state, target)
    previous = row.state
    row.state = target.value
    row.decision_reason = body.reason
    row.decided_by_parent_id = parent.id
    row.decided_at = datetime.now(UTC)
    if target is RequestState.APPROVED:
        if row.request_type == "CONTENT_REVIEW":
            evidence = row.content_review
            app_ref = row.content_app_ref
            fingerprint = row.content_fingerprint
            if not isinstance(evidence, dict) or not app_ref or not fingerprint:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Content review approval requires exact minimized evidence",
                )
            # Do not publish an approval through the child-wide signed policy:
            # a second device or another item in the same app must remain blocked.
            session.add(
                ContentApproval(
                    request_id=row.id,
                    device_id=row.device_id,
                    app_ref=app_ref,
                    fingerprint=fingerprint,
                    expires_at=row.decided_at + timedelta(minutes=15),
                )
            )
        else:
            current = await current_bundle_for_update(session, row.child_profile_id)
            if current is None:
                raise HTTPException(status.HTTP_409_CONFLICT, "Policy is unavailable")
            policy = deepcopy(current.new_value)
            policy["signature"] = ""
            raw_overrides = policy.get("temporary_overrides", [])
            overrides = list(raw_overrides) if isinstance(raw_overrides, list) else []
            expires_at = datetime.now(UTC) + timedelta(hours=1)
            if row.request_type == "MORE_TIME":
                starts_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
                override = build_more_time_override(
                    policy,
                    row.subject,
                    15,
                    f"request-{row.id}",
                    starts_at,
                    expires_at.isoformat().replace("+00:00", "Z"),
                )
                if override is None:
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                        "More-time approval requires an exact app, domain, or explicit device target",
                    )
                overrides.append(override)
            else:
                if not row.subject:
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                        "Approval requires an exact request subject",
                    )
                overrides.append(
                    {
                        "rule_id": f"request-{row.id}",
                        "target_kind": "APP" if row.request_type == "UNBLOCK_APP" else "DOMAIN",
                        "target_ref": row.subject,
                        "action": "ALLOW",
                        "starts_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                        "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
                    }
                )
            policy["temporary_overrides"] = overrides
            await create_next_bundle(
                session,
                row.child_profile_id,
                parent.id,
                policy,
                {"state": previous, "request_id": str(row.id)},
                expires_at=expires_at,
            )
    result = RequestOut.model_validate(row)
    if commit:
        await session.commit()
        await _publish_request_decision(session, row)
    return result


async def _request_for_parent_for_update(
    request_id: UUID, parent: Parent, session: AsyncSession
) -> RequestRow | None:
    row = await session.scalar(
        select(RequestRow)
        .join(ChildProfile, ChildProfile.id == RequestRow.child_profile_id)
        .join(Family, Family.id == ChildProfile.family_id)
        .join(FamilyGuardian, FamilyGuardian.family_id == Family.id)
        .where(RequestRow.id == request_id, FamilyGuardian.parent_id == parent.id)
        .with_for_update()
    )
    return row if isinstance(row, RequestRow) else None


async def _publish_request_decision(session: AsyncSession, row: RequestRow) -> None:
    family_id = await session.scalar(
        select(ChildProfile.family_id).where(ChildProfile.id == row.child_profile_id)
    )
    if family_id is not None:
        broadcaster.publish(
            family_id,
            {"type": "request-decided", "request_id": str(row.id), "state": row.state},
            row.child_profile_id,
        )


async def _idempotent_decision(
    family_id: UUID,
    request_id: UUID,
    target: RequestState,
    body: RequestDecisionIn,
    parent: Parent,
    idempotency_key: str,
    session: AsyncSession,
) -> RequestOut:
    # Advisory-key -> request row -> policy document is the global lock order.
    # The lock covers both replay lookup and result insert, so concurrent
    # deliveries with the same key produce one decision and one replay.
    operation = "request_decision"
    digest = payload_hash(
        {
            "family_id": str(family_id),
            "request_id": str(request_id),
            "action": target.value,
            "body": body.model_dump(mode="json"),
        }
    )
    await acquire_idempotency_lock(session, operation, idempotency_key)
    row = await _request_for_parent_for_update(request_id, parent, session)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found")
    replay = await replay_or_conflict(session, operation, idempotency_key, digest)
    if replay is not None:
        return RequestOut.model_validate(replay.response_body)
    result = await decide_request(
        request_id,
        target,
        body,
        parent,
        session,
        locked_row=row,
        commit=False,
    )
    await save_result(
        session,
        operation,
        idempotency_key,
        digest,
        status.HTTP_200_OK,
        result.model_dump(mode="json"),
    )
    await session.commit()
    await _publish_request_decision(session, row)
    return result

async def approve_request(
    family_id: UUID,
    request_id: UUID,
    body: RequestDecisionIn,
    parent: Parent = Depends(current_parent),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    session: AsyncSession = Depends(get_session),
) -> RequestOut:
    await family_for_parent(session, parent, family_id)
    if idempotency_key is not None:
        return await _idempotent_decision(
            family_id,
            request_id,
            RequestState.APPROVED,
            body,
            parent,
            idempotency_key,
            session,
        )
    return await decide_request(request_id, RequestState.APPROVED, body, parent, session)

async def deny_request(
    family_id: UUID,
    request_id: UUID,
    body: RequestDecisionIn,
    parent: Parent = Depends(current_parent),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    session: AsyncSession = Depends(get_session),
) -> RequestOut:
    await family_for_parent(session, parent, family_id)
    if idempotency_key is not None:
        return await _idempotent_decision(
            family_id,
            request_id,
            RequestState.DENIED,
            body,
            parent,
            idempotency_key,
            session,
        )
    return await decide_request(request_id, RequestState.DENIED, body, parent, session)

router.add_api_route("/v1/families/{family_id}/requests", list_requests, methods=["GET"], response_model=list[RequestOut])
router.add_api_route("/v1/families/{family_id}/requests/{request_id}/approve", approve_request, methods=["POST"], response_model=RequestOut)
router.add_api_route("/v1/families/{family_id}/requests/{request_id}/deny", deny_request, methods=["POST"], response_model=RequestOut)
