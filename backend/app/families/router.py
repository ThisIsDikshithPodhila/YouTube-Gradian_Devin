# ruff: noqa: E501
from fastapi import APIRouter, Query

from ..api.handler_support import (
    UTC,
    UUID,
    AsyncSession,
    ChildProfile,
    Depends,
    Device,
    DeviceCredential,
    Family,
    FamilyCreate,
    FamilyGuardian,
    GuardianAcceptIn,
    GuardianInvitation,
    GuardianInviteIn,
    GuardianRole,
    HTTPException,
    HTTPRequest,
    Parent,
    auth_rate_limiter,
    broadcaster,
    current_parent,
    datetime,
    family_for_parent,
    get_session,
    hashlib,
    notifier,
    rate_key,
    secrets,
    select,
    status,
    timedelta,
)

router = APIRouter()


async def create_family(
    body: FamilyCreate,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> Family:
    family = Family(name=body.name)
    session.add(family)
    await session.flush()
    session.add(FamilyGuardian(family_id=family.id, parent_id=parent.id, role=GuardianRole.OWNER))
    await session.commit()
    return family

async def list_families(
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[Family]:
    return list(
        (
            await session.scalars(
                select(Family)
                .join(FamilyGuardian, FamilyGuardian.family_id == Family.id)
                .where(FamilyGuardian.parent_id == parent.id)
                .order_by(Family.created_at)
            )
        ).all()
    )

async def read_family(
    family_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> Family:
    return await family_for_parent(session, parent, family_id)

async def family_health(
    family_id: UUID,
    child_id: UUID | None = Query(None),
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, object]]:
    await family_for_parent(session, parent, family_id)
    devices = list(
        (
            await session.scalars(
                select(Device)
                .join(ChildProfile, ChildProfile.id == Device.child_profile_id)
                .where(
                    ChildProfile.family_id == family_id,
                    *([ChildProfile.id == child_id] if child_id is not None else []),
                )
            )
        ).all()
    )
    return [
        {
            "child_profile_id": str(device.child_profile_id),
            "device_id": str(device.id),
            "state": device.protection_state,
            "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
            "policy_version_applied": device.policy_version_applied,
        }
        for device in devices
    ]

async def list_guardians(
    family_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> list[FamilyGuardian]:
    await family_for_parent(session, parent, family_id)
    return list(
        (
            await session.scalars(
                select(FamilyGuardian).where(FamilyGuardian.family_id == family_id)
            )
        ).all()
    )

async def invite_guardian(
    family_id: UUID,
    body: GuardianInviteIn,
    request: HTTPRequest,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> None:
    await family_for_parent(session, parent, family_id)
    auth_rate_limiter.check(rate_key(request, "guardian-invite", body.email.lower()), 5, 60)
    raw = secrets.token_urlsafe(32)
    invitation = GuardianInvitation(
        family_id=family_id,
        email=body.email.lower(),
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    session.add(invitation)
    await notifier.send_email(body.email, "Join a Guardian family", raw)
    await session.commit()

async def accept_guardian(
    body: GuardianAcceptIn,
    request: HTTPRequest,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> None:
    auth_rate_limiter.check(rate_key(request, "guardian-accept", str(parent.id)), 10, 60)
    invitation = await session.scalar(
        select(GuardianInvitation).where(
            GuardianInvitation.token_hash == hashlib.sha256(body.token.encode()).hexdigest()
        )
    )
    if (
        invitation is None
        or invitation.accepted_at is not None
        or invitation.expires_at <= datetime.now(UTC)
        or invitation.email != parent.email
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invitation is invalid")
    invitation.accepted_at = datetime.now(UTC)
    session.add(
        FamilyGuardian(
            family_id=invitation.family_id,
            parent_id=parent.id,
            role=GuardianRole.CO_GUARDIAN,
        )
    )
    await session.commit()

async def revoke_device(
    family_id: UUID,
    device_id: UUID,
    parent: Parent = Depends(current_parent),
    session: AsyncSession = Depends(get_session),
) -> None:
    await family_for_parent(session, parent, family_id)
    device = await session.scalar(
        select(Device)
        .join(ChildProfile, ChildProfile.id == Device.child_profile_id)
        .where(Device.id == device_id, ChildProfile.family_id == family_id)
    )
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    now = datetime.now(UTC)
    device.revoked_at = now
    credential = await session.scalar(
        select(DeviceCredential).where(DeviceCredential.device_id == device.id)
    )
    if credential is not None:
        credential.revoked_at = now
    await session.commit()
    broadcaster.publish(
        family_id,
        {"type": "device-status", "device_id": str(device.id), "status": "REVOKED"},
        device.child_profile_id,
    )

router.add_api_route("/v1/families", create_family, methods=["POST"], status_code=201, response_model=None)
router.add_api_route("/v1/families", list_families, methods=["GET"], response_model=None)
router.add_api_route("/v1/families/{family_id}", read_family, methods=["GET"], response_model=None)
router.add_api_route("/v1/families/{family_id}/health", family_health, methods=["GET"], response_model=None)
router.add_api_route("/v1/families/{family_id}/guardians", list_guardians, methods=["GET"], response_model=None)
router.add_api_route("/v1/families/{family_id}/guardians/invite", invite_guardian, methods=["POST"], status_code=202, response_model=None)
router.add_api_route("/v1/families/guardians/accept", accept_guardian, methods=["POST"], status_code=204, response_model=None)
router.add_api_route("/v1/families/{family_id}/devices/{device_id}/revoke", revoke_device, methods=["POST"], status_code=204, response_model=None)
