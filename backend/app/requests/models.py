from datetime import datetime
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from ..core.models import Base, TimestampMixin


class RequestState(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DENIED = "DENIED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"


class RequestType(StrEnum):
    MORE_TIME = "MORE_TIME"
    UNBLOCK_APP = "UNBLOCK_APP"
    UNBLOCK_SITE = "UNBLOCK_SITE"
    CONTENT_REVIEW = "CONTENT_REVIEW"
    VIDEO_REVIEW = "VIDEO_REVIEW"


class Request(TimestampMixin, Base):
    __tablename__ = "requests"
    __table_args__ = (Index("ix_requests_child_state", "child_profile_id", "state"),)

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    child_profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("child_profiles.id", ondelete="CASCADE"), index=True
    )
    device_id: Mapped[UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    request_type: Mapped[str] = mapped_column(String(30))
    subject: Mapped[str | None] = mapped_column(String(255))
    state: Mapped[str] = mapped_column(String(20), default=RequestState.PENDING.value)
    reason: Mapped[str | None] = mapped_column(Text)
    decision_reason: Mapped[str | None] = mapped_column(Text)
    decided_by_parent_id: Mapped[UUID | None] = mapped_column(ForeignKey("parents.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Content review never stores the triggering text. The flattened tuple is
    # indexed for exact, pending-request dedupe; JSON holds only typed evidence.
    content_app_ref: Mapped[str | None] = mapped_column(String(200))
    content_fingerprint: Mapped[str | None] = mapped_column(String(64))
    content_review: Mapped[dict[str, object] | None] = mapped_column(JSONB)


class ContentApproval(TimestampMixin, Base):
    """A device-scoped live approval, deliberately outside a child-wide policy."""

    __tablename__ = "content_approvals"
    __table_args__ = (
        Index("ix_content_approvals_device_expiry", "device_id", "expires_at"),
    )

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    request_id: Mapped[UUID] = mapped_column(
        ForeignKey("requests.id", ondelete="CASCADE"), unique=True
    )
    device_id: Mapped[UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    app_ref: Mapped[str] = mapped_column(String(200))
    fingerprint: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
