from app.videos.classifier import VideoMetadata, classify_video, topics_for_age_band


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
