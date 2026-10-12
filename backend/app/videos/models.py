from uuid import UUID, uuid4

from sqlalchemy import Boolean, ForeignKey, Integer
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from ..core.models import Base, TimestampMixin


class ChildVideoSettings(TimestampMixin, Base):
    """Parent-owned YouTube choices for one child, enforced by the video check."""

    __tablename__ = "child_video_settings"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    child_profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("child_profiles.id", ondelete="CASCADE"), unique=True
    )
    trusted_channels: Mapped[list[str]] = mapped_column(JSONB, default=list)
    blocked_channels: Mapped[list[str]] = mapped_column(JSONB, default=list)
    learning_topics: Mapped[list[dict[str, object]]] = mapped_column(JSONB, default=list)
    picks: Mapped[list[dict[str, object]]] = mapped_column(JSONB, default=list)
    learning_only: Mapped[bool] = mapped_column(Boolean, default=False)
    hide_shorts: Mapped[bool] = mapped_column(Boolean, default=True)
    hide_comments: Mapped[bool] = mapped_column(Boolean, default=True)
    autoplay_next: Mapped[bool] = mapped_column(Boolean, default=False)
    youtube_guardian_only: Mapped[bool] = mapped_column(Boolean, default=False)
    rules_revision: Mapped[int] = mapped_column(Integer, default=1)
