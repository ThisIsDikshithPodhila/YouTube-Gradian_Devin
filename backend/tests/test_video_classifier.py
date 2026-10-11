import httpx
import pytest

from app.videos import classifier
from app.videos.classifier import (
    VideoMetadata,
    classify_video,
    fetch_video_metadata,
    topics_for_age_band,
)


def test_horror_title_needs_review_for_preteen_but_not_teen() -> None:
    metadata = VideoMetadata(title="Top 10 SCARY Horror Moments", channel="Clips")
    topic = classify_video(metadata, "PRETEEN")
    assert topic is not None and topic.code == "HORROR"
    assert classify_video(metadata, "TEEN") is None


def test_keywords_match_whole_words_only() -> None:
    metadata = VideoMetadata(title="Learn the Alphabet: Strawberry", channel="Kids")
    assert classify_video(metadata, "YOUNG_CHILD") is None


def test_older_teens_have_no_preset_topics() -> None:
    assert topics_for_age_band("OLDER_TEEN") == []


@pytest.mark.parametrize("body", [b"", b"not json", b"[1, 2]"])
async def test_malformed_oembed_body_means_unavailable_metadata(
    monkeypatch: pytest.MonkeyPatch, body: bytes
) -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=body))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        classifier.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    assert await fetch_video_metadata("abcdefghijk") is None
