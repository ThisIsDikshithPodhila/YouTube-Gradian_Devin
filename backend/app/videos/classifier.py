# ruff: noqa: E501
import re
from dataclasses import dataclass

import httpx

AGE_BAND_ORDER = ("YOUNG_CHILD", "PRETEEN", "TEEN", "OLDER_TEEN")
VIDEO_ID_PATTERN = r"^[A-Za-z0-9_-]{11}$"


@dataclass(frozen=True)
class VideoTopic:
    code: str
    label: str
    keywords: tuple[str, ...]
    review_through: str
    """Highest age band that still needs a parent decision for this topic."""


VIDEO_TOPICS: tuple[VideoTopic, ...] = (
    VideoTopic(
        "ADULT_CONTENT",
        "Adult or sexual content",
        ("18+", "nsfw", "sexy", "explicit", "adults only", "onlyfans", "strip"),
        "TEEN",
    ),
    VideoTopic(
        "GRAPHIC_VIOLENCE",
        "Graphic violence",
        ("gore", "gory", "brutal", "bloody", "execution", "fight compilation", "street fight"),
        "TEEN",
    ),
    VideoTopic(
        "HORROR",
        "Horror and scary content",
        ("horror", "scary", "creepy", "jumpscare", "jump scare", "haunted", "terrifying", "nightmare"),
        "PRETEEN",
    ),
    VideoTopic(
        "DANGEROUS_CHALLENGE",
        "Dangerous challenges and pranks",
        ("challenge gone wrong", "prank gone wrong", "dangerous challenge", "don't try this", "extreme stunt"),
        "TEEN",
    ),
    VideoTopic(
        "GAMBLING",
        "Gambling and betting",
        ("casino", "gambling", "betting", "slot machine", "poker", "jackpot"),
        "TEEN",
    ),
    VideoTopic(
        "DRUGS_ALCOHOL",
        "Drugs, alcohol and vaping",
        ("drunk", "alcohol", "vape", "vaping", "weed", "cannabis", "drugs"),
        "TEEN",
    ),
    VideoTopic(
        "STRONG_LANGUAGE",
        "Strong language",
        ("uncensored", "swearing", "profanity", "cursing", "explicit lyrics"),
        "PRETEEN",
    ),
    VideoTopic(
        "WEAPONS",
        "Weapons",
        ("gun review", "firearm", "firearms", "rifle", "shotgun"),
        "PRETEEN",
    ),
)


@dataclass(frozen=True)
class VideoMetadata:
    title: str | None
    channel: str | None


def topics_for_age_band(age_band: str) -> list[VideoTopic]:
    rank = AGE_BAND_ORDER.index(age_band) if age_band in AGE_BAND_ORDER else 0
    return [topic for topic in VIDEO_TOPICS if rank <= AGE_BAND_ORDER.index(topic.review_through)]


def _matches(keyword: str, text: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])", text) is not None


def classify_video(metadata: VideoMetadata, age_band: str) -> VideoTopic | None:
    text = f"{metadata.title or ''} {metadata.channel or ''}".lower()
    for topic in topics_for_age_band(age_band):
        if any(_matches(keyword, text) for keyword in topic.keywords):
            return topic
    return None


async def fetch_video_metadata(video_id: str) -> VideoMetadata | None:
    """Public YouTube oEmbed metadata; None when YouTube withholds it."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                "https://www.youtube.com/oembed",
                params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
            )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    title = body.get("title")
    channel = body.get("author_name")
    return VideoMetadata(
        title=title if isinstance(title, str) else None,
        channel=channel if isinstance(channel, str) else None,
    )
