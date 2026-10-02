import uuid

from app.api.app import _safe_log_path


def test_push_action_tokens_are_redacted_before_request_logging() -> None:
    token = "push-action-token-that-must-not-be-logged"
    assert (
        _safe_log_path(f"/v1/push/actions/{token}/approve")
        == "/v1/push/actions/[redacted]/approve"
    )
    assert token not in _safe_log_path(f"/v1/push/actions/{token}/deny")


async def test_request_id_is_propagated_and_generated(client) -> None:
    supplied = str(uuid.uuid4())
    response = await client.get("/readiness", headers={"X-Request-ID": supplied})
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == supplied

    generated = await client.get("/readiness")
    generated_id = generated.headers.get("X-Request-ID")
    assert generated.status_code == 200
    assert generated_id
    assert uuid.UUID(generated_id)

    error = await client.get(
        "/v1/auth/me",
        headers={"X-Request-ID": supplied},
    )
    assert error.status_code == 401
    assert error.headers["X-Request-ID"] == supplied
