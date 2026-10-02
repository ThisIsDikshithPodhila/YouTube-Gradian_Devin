# ruff: noqa: E501
import asyncio
import json
from uuid import UUID

import pytest

from app.api.app import app
from app.events.broadcaster import broadcaster


async def connect(family_id: str, token: str, child_id: str | None, path: str = "/v1/ws/sync"):
    incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
    outgoing: asyncio.Queue[dict[str, object]] = asyncio.Queue()
    query = f"family_id={family_id}"
    if child_id is not None:
        query += f"&child_profile_id={child_id}"
    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "scheme": "ws",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": [(b"authorization", f"Bearer {token}".encode()), (b"host", b"test")],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
        "subprotocols": [],
    }

    async def receive():
        return await incoming.get()

    async def send(message):
        await outgoing.put(message)

    task = asyncio.create_task(app(scope, receive, send))
    await incoming.put({"type": "websocket.connect"})
    return task, incoming, outgoing


async def receive_json(outgoing: asyncio.Queue[dict[str, object]]) -> dict[str, object]:
    message = await asyncio.wait_for(outgoing.get(), timeout=2)
    if message["type"] == "websocket.accept":
        message = await asyncio.wait_for(outgoing.get(), timeout=2)
    assert message["type"] == "websocket.send"
    return json.loads(str(message["text"]))


@pytest.mark.asyncio
async def test_parent_websocket_receives_every_published_event_type(
    client, parent_a, parent_b
) -> None:
    task, incoming, outgoing = await connect(parent_a.family_id, parent_a.token, parent_a.child_id)
    assert (await receive_json(outgoing))["type"] == "catch-up"
    await asyncio.sleep(0)
    for event_type in (
        "policy-version-changed",
        "request-created",
        "request-decided",
        "protection-health-changed",
        "device-status",
    ):
        broadcaster.publish(UUID(parent_a.family_id), {"type": event_type}, UUID(parent_a.child_id))
        assert (await receive_json(outgoing))["type"] == event_type
    broadcaster.publish(
        UUID(parent_b.family_id), {"type": "device-status"}, UUID(parent_b.child_id)
    )
    assert outgoing.empty()
    await incoming.put({"type": "websocket.disconnect", "code": 1000})
    await task


@pytest.mark.asyncio
async def test_device_websocket_is_child_scoped_and_rejects_other_family(
    client, paired_device, parent_b
) -> None:
    second_child = await client.post(
        f"/v1/families/{paired_device.parent.family_id}/children",
        json={"name": "Casey", "date_of_birth": "2014-08-15", "timezone": "UTC"},
        headers={"Authorization": f"Bearer {paired_device.parent.token}"},
    )
    assert second_child.status_code == 201, second_child.text
    second_child_id = UUID(second_child.json()["id"])
    task, incoming, outgoing = await connect(
        paired_device.parent.family_id,
        paired_device.device_token,
        None,
    )
    assert (await receive_json(outgoing))["type"] == "catch-up"
    await asyncio.sleep(0)
    broadcaster.publish(
        UUID(paired_device.parent.family_id),
        {"type": "request-created"},
        UUID(paired_device.parent.child_id),
    )
    assert (await receive_json(outgoing))["type"] == "request-created"
    # Omitting child_profile_id on a device connection must still be scoped to
    # the child bound to the credential, never the whole family.
    broadcaster.publish(
        UUID(paired_device.parent.family_id),
        {"type": "other-child-event"},
        second_child_id,
    )
    await asyncio.sleep(0)
    assert outgoing.empty()
    await incoming.put({"type": "websocket.disconnect", "code": 1000})
    await task

    denied_task, _, denied_outgoing = await connect(
        parent_b.family_id,
        paired_device.device_token,
        parent_b.child_id,
    )
    await asyncio.wait_for(denied_outgoing.get(), timeout=2)
    denied = await asyncio.wait_for(denied_outgoing.get(), timeout=2)
    assert denied == {"type": "websocket.close", "code": 1008, "reason": ""}
    await denied_task


@pytest.mark.asyncio
async def test_websocket_authentication_failure_is_rejected(client, parent_a) -> None:
    task, _, outgoing = await connect(parent_a.family_id, "invalid", None)
    await asyncio.wait_for(outgoing.get(), timeout=2)
    denied = await asyncio.wait_for(outgoing.get(), timeout=2)
    assert denied == {"type": "websocket.close", "code": 1008, "reason": ""}
    await task


@pytest.mark.asyncio
async def test_parent_and_child_channels_enforce_roles_and_family_scope(
    client, parent_a, parent_b, paired_device
) -> None:
    for path, family_id, token in (
        ("/v1/ws/parent", parent_a.family_id, paired_device.device_token),
        ("/v1/ws/child", parent_a.family_id, parent_a.token),
        ("/v1/ws/parent", parent_b.family_id, parent_a.token),
        ("/v1/ws/child", parent_b.family_id, paired_device.device_token),
    ):
        task, _, outgoing = await connect(family_id, token, None, path)
        await asyncio.wait_for(outgoing.get(), timeout=2)
        assert await asyncio.wait_for(outgoing.get(), timeout=2) == {
            "type": "websocket.close",
            "code": 1008,
            "reason": "",
        }
        await task


@pytest.mark.asyncio
async def test_realtime_parent_child_requests_policy_and_reconnect_catch_up(
    client, paired_device
) -> None:
    parent = paired_device.parent
    parent_task, parent_in, parent_out = await connect(
        parent.family_id, parent.token, None, "/v1/ws/parent"
    )
    child_task, child_in, child_out = await connect(
        parent.family_id, paired_device.device_token, None, "/v1/ws/child"
    )
    assert (await receive_json(parent_out))["open_requests"] == []
    assert (await receive_json(child_out))["open_requests"] == []

    mutation = await client.post(
        f"/v1/families/{parent.family_id}/children/{parent.child_id}/policy/mutations",
        headers={"Authorization": f"Bearer {parent.token}"},
        json={"operation": "APP_BLOCK", "target": "com.example.browser"},
    )
    assert mutation.status_code == 200, mutation.text
    assert (await receive_json(child_out))["policy_version"] == mutation.json()["policy_version"]
    assert (await receive_json(parent_out))["type"] == "policy-version-changed"

    import_body = json.dumps({"request_type": "MORE_TIME", "subject": None}).encode()
    path = "/v1/devices/me/requests"
    created = await client.post(
        path,
        content=import_body,
        headers={
            **paired_device.signed_headers(path, import_body),
            "Content-Type": "application/json",
        },
    )
    assert created.status_code == 201, created.text
    request_id = created.json()["id"]
    assert (await receive_json(parent_out))["request_id"] == request_id
    assert (await receive_json(child_out))["request_id"] == request_id

    await child_in.put({"type": "websocket.disconnect", "code": 1000})
    await child_task
    reconnected_task, reconnected_in, reconnected_out = await connect(
        parent.family_id, paired_device.device_token, None, "/v1/ws/child"
    )
    catch_up = await receive_json(reconnected_out)
    assert catch_up["policy_version"] == mutation.json()["policy_version"]
    assert catch_up["open_requests"] == [request_id]

    decision = await client.post(
        f"/v1/families/{parent.family_id}/requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {parent.token}"},
        json={"reason": "Approved"},
    )
    assert decision.status_code == 200, decision.text
    assert (await receive_json(reconnected_out))["state"] == "APPROVED"
    assert (await receive_json(parent_out))["state"] == "APPROVED"

    await reconnected_in.put({"type": "websocket.disconnect", "code": 1000})
    await parent_in.put({"type": "websocket.disconnect", "code": 1000})
    await reconnected_task
    await parent_task


@pytest.mark.asyncio
async def test_child_socket_never_receives_sibling_events(client, paired_device) -> None:
    parent = paired_device.parent
    sibling = await client.post(
        f"/v1/families/{parent.family_id}/children",
        headers={"Authorization": f"Bearer {parent.token}"},
        json={"name": "Sibling", "date_of_birth": "2017-08-15", "timezone": "UTC"},
    )
    assert sibling.status_code == 201, sibling.text
    task, incoming, outgoing = await connect(
        parent.family_id, paired_device.device_token, None, "/v1/ws/child"
    )
    assert (await receive_json(outgoing))["type"] == "catch-up"
    sibling_id = UUID(sibling.json()["id"])
    broadcaster.publish(UUID(parent.family_id), {"type": "request-created"}, sibling_id)
    await asyncio.sleep(0)
    assert outgoing.empty()
    await incoming.put({"type": "websocket.disconnect", "code": 1000})
    await task

    denied_task, _, denied_out = await connect(
        parent.family_id, paired_device.device_token, sibling.json()["id"], "/v1/ws/child"
    )
    await asyncio.wait_for(denied_out.get(), timeout=2)
    assert (await asyncio.wait_for(denied_out.get(), timeout=2))["code"] == 1008
    await denied_task
