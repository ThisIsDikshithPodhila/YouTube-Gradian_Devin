"""add per-child YouTube settings and video approval rules fingerprint

Revision ID: 0023_video_settings
Revises: 0022_inventory_lifecycle
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0023_video_settings"
down_revision = "0022_inventory_lifecycle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "child_video_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "child_profile_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("child_profiles.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("trusted_channels", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("blocked_channels", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("learning_topics", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("picks", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("learning_only", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("hide_shorts", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("hide_comments", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("autoplay_next", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("youtube_guardian_only", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("rules_revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.add_column(
        "requests", sa.Column("video_rules_fingerprint", sa.String(length=64), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("requests", "video_rules_fingerprint")
    op.drop_table("child_video_settings")
