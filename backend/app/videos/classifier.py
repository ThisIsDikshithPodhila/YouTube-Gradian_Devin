# ruff: noqa: E501
import json
import re
from dataclasses import dataclass, field, replace

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
        (
            "horror",
            "scary",
            "creepy",
            "jumpscare",
            "jump scare",
            "haunted",
            "terrifying",
            "nightmare",
        ),
        "PRETEEN",
    ),
    VideoTopic(
        "DANGEROUS_CHALLENGE",
        "Dangerous challenges and pranks",
        (
            "challenge gone wrong",
            "prank gone wrong",
            "dangerous challenge",
            "don't try this",
            "extreme stunt",
        ),
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
    description: str = ""
    keywords: tuple[str, ...] = field(default=())
    category: str | None = None
    family_safe: bool | None = None
    age_restricted: bool = False


@dataclass(frozen=True)
class LearningPreset:
    label: str
    keywords: str


LEARNING_PRESETS: dict[str, tuple[LearningPreset, ...]] = {
    "YOUNG_CHILD": (
        LearningPreset("Animals and nature", "animals nature for kids"),
        LearningPreset("Numbers and counting", "counting numbers for kids"),
        LearningPreset("Phonics and reading", "phonics reading for kids"),
        LearningPreset("Easy science experiments", "easy science experiments for kids"),
        LearningPreset("Drawing and crafts", "easy drawing crafts for kids"),
    ),
    "PRETEEN": (
        LearningPreset("Science projects", "science projects for kids"),
        LearningPreset("DIY and crafts", "diy crafts for kids"),
        LearningPreset("Space and planets", "space planets explained for kids"),
        LearningPreset("Coding for beginners", "coding for kids scratch"),
        LearningPreset("How things work", "how things work for kids"),
    ),
    "TEEN": (
        LearningPreset("Physics and chemistry explained", "physics chemistry explained"),
        LearningPreset("Electronics DIY", "electronics diy projects beginners"),
        LearningPreset("Programming", "programming tutorial beginners"),
        LearningPreset("History documentaries", "history documentary for students"),
        LearningPreset("Math made simple", "math explained for students"),
    ),
    "OLDER_TEEN": (
        LearningPreset("Engineering projects", "engineering projects"),
        LearningPreset("Programming", "programming tutorial"),
        LearningPreset("Personal finance basics", "personal finance basics for teens"),
        LearningPreset("Science explained", "science explained"),
    ),
}


def topics_for_age_band(age_band: str) -> list[VideoTopic]:
    rank = AGE_BAND_ORDER.index(age_band) if age_band in AGE_BAND_ORDER else 0
    return [topic for topic in VIDEO_TOPICS if rank <= AGE_BAND_ORDER.index(topic.review_through)]


def _matches(keyword: str, text: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])", text) is not None


YOUTUBE_RESTRICTED = VideoTopic(
    "YOUTUBE_RESTRICTED",
    "YouTube marks this video as not suitable for children",
    (),
    "TEEN",
)


def classify_video(metadata: VideoMetadata, age_band: str) -> VideoTopic | None:
    if (metadata.age_restricted or metadata.family_safe is False) and age_band in AGE_BAND_ORDER[
        :3
    ]:
        return YOUTUBE_RESTRICTED
    text = " ".join(
        [
            metadata.title or "",
            metadata.channel or "",
            metadata.description,
            " ".join(metadata.keywords),
        ]
    ).lower()
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
    metadata = VideoMetadata(
        title=title if isinstance(title, str) else None,
        channel=channel if isinstance(channel, str) else None,
    )
    details = await fetch_watch_page_details(video_id)
    if details is None:
        return metadata
    return replace(
        metadata,
        description=details.description,
        keywords=details.keywords,
        category=details.category,
        family_safe=details.family_safe,
        age_restricted=details.age_restricted,
    )


_PLAYER_RESPONSE = re.compile(
    r"ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var |</script>)", re.S
)


def parse_watch_page(page: str) -> VideoMetadata | None:
    """Read YouTube's own family-safe, age-gate, category, description and tags."""
    match = _PLAYER_RESPONSE.search(page)
    if match is None:
        return None
    try:
        player = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(player, dict):
        return None
    playability = player.get("playabilityStatus")
    details = player.get("videoDetails")
    microformat = player.get("microformat")
    renderer = (
        microformat.get("playerMicroformatRenderer") if isinstance(microformat, dict) else None
    )
    details = details if isinstance(details, dict) else {}
    renderer = renderer if isinstance(renderer, dict) else {}
    status = playability.get("status") if isinstance(playability, dict) else None
    reason = str(playability.get("reason", "")) if isinstance(playability, dict) else ""
    raw_keywords = details.get("keywords")
    description = details.get("shortDescription")
    category = renderer.get("category")
    family_safe = renderer.get("isFamilySafe")
    return VideoMetadata(
        title=None,
        channel=None,
        description=description[:5000] if isinstance(description, str) else "",
        keywords=tuple(k for k in raw_keywords if isinstance(k, str))[:50]
        if isinstance(raw_keywords, list)
        else (),
        category=category if isinstance(category, str) else None,
        family_safe=family_safe if isinstance(family_safe, bool) else None,
        age_restricted=status in {"LOGIN_REQUIRED", "AGE_CHECK_REQUIRED"}
        and "age" in reason.lower(),
    )


async def fetch_watch_page_details(video_id: str) -> VideoMetadata | None:
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            response = await client.get(
                "https://www.youtube.com/watch",
                params={"v": video_id, "hl": "en"},
                headers={"Accept-Language": "en"},
                cookies={"SOCS": "CAI", "CONSENT": "YES+"},
            )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    return parse_watch_page(response.text)
