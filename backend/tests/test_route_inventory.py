from fastapi.routing import APIRoute, APIWebSocketRoute

from app.api.app import app

ExpectedRoute = tuple[str, str, str]


EXPECTED_ROUTES: tuple[ExpectedRoute, ...] = (
    ("/health", "GET", "public"),
    ("/livez", "GET", "public"),
    ("/readiness", "GET", "public"),
    ("/readyz", "GET", "public"),
    ("/account-deletion", "GET", "public"),
    ("/v1/auth/account", "DELETE", "parent"),
    ("/v1/auth/login", "POST", "public"),
    ("/v1/auth/logout", "POST", "public"),
    ("/v1/auth/me", "GET", "parent"),
    ("/v1/auth/password-reset/confirm", "POST", "public"),
    ("/v1/auth/password-reset/request", "POST", "public"),
    ("/v1/auth/refresh", "POST", "public"),
    ("/v1/auth/signup", "POST", "public"),
    ("/v1/auth/verification/confirm", "POST", "public"),
    ("/v1/auth/verification/request", "POST", "parent"),
    ("/v1/devices/me/content-approvals", "GET", "device"),
    ("/v1/devices/me/events", "POST", "device"),
    ("/v1/devices/me/heartbeat", "POST", "device"),
    ("/v1/devices/me/inventory", "POST", "device"),
    ("/v1/devices/me/policy", "GET", "device"),
    ("/v1/devices/me/policy/ack", "POST", "device"),
    ("/v1/devices/me/reputation", "GET", "device"),
    ("/v1/devices/me/reputation/classify", "POST", "device"),
    ("/v1/devices/me/push-tokens", "POST", "device"),
    ("/v1/devices/me/requests", "POST", "device"),
    ("/v1/devices/pair", "POST", "public"),
    ("/v1/families", "POST", "parent"),
    ("/v1/families", "GET", "parent"),
    ("/v1/families/{family_id}", "GET", "parent"),
    ("/v1/families/{family_id}/activity", "GET", "parent"),
    ("/v1/families/{family_id}/activity/usage", "GET", "parent"),
    ("/v1/families/{family_id}/usage/reports", "GET", "parent"),
    ("/v1/families/{family_id}/children", "GET", "parent"),
    ("/v1/families/{family_id}/children", "POST", "parent"),
    ("/v1/families/{family_id}/children/{child_id}", "DELETE", "parent"),
    ("/v1/families/{family_id}/children/{child_id}", "GET", "parent"),
    ("/v1/families/{family_id}/children/{child_id}", "PATCH", "parent"),
    (
        "/v1/families/{family_id}/children/{child_id}/pairing",
        "POST",
        "parent",
    ),
    ("/v1/families/{family_id}/children/{child_id}/inventory", "GET", "parent"),
    (
        "/v1/families/{family_id}/children/{child_id}/inventory/{platform_app_id}/review",
        "POST",
        "parent",
    ),
    (
        "/v1/families/{family_id}/children/{child_id}/policy/mutations",
        "POST",
        "parent",
    ),
    (
        "/v1/families/{family_id}/children/{child_id}/reputation",
        "GET",
        "parent",
    ),
    ("/v1/families/{family_id}/devices/{device_id}/revoke", "POST", "parent"),
    ("/v1/families/{family_id}/guardians", "GET", "parent"),
    ("/v1/families/{family_id}/guardians/invite", "POST", "parent"),
    ("/v1/families/{family_id}/health", "GET", "parent"),
    ("/v1/families/{family_id}/requests", "GET", "parent"),
    (
        "/v1/families/{family_id}/requests/{request_id}/approve",
        "POST",
        "parent",
    ),
    ("/v1/families/{family_id}/requests/{request_id}/deny", "POST", "parent"),
    ("/v1/families/guardians/accept", "POST", "parent"),
    ("/v1/me/push-tokens", "POST", "parent"),
    ("/v1/policy/public-key", "GET", "public"),
    ("/v1/push/actions/{action_token}/approve", "POST", "action-token"),
    ("/v1/push/actions/{action_token}/deny", "POST", "action-token"),
    ("/v1/ws/child", "WEBSOCKET", "device"),
    ("/v1/ws/parent", "WEBSOCKET", "parent"),
    ("/v1/ws/sync", "WEBSOCKET", "parent-or-device"),
)


def _dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()
    pending = list(route.dependant.dependencies)
    while pending:
        dependency = pending.pop()
        call = dependency.call
        names.add(getattr(call, "__name__", ""))
        pending.extend(dependency.dependencies)
    return names


def _registered_routes() -> list[ExpectedRoute]:
    routes: list[ExpectedRoute] = []
    pending = list(app.routes)
    while pending:
        route = pending.pop()
        nested_router = getattr(route, "original_router", None)
        nested_routes = getattr(nested_router, "routes", None)
        if isinstance(nested_routes, list):
            pending.extend(nested_routes)
            continue
        if isinstance(route, APIWebSocketRoute):
            auth_kind = {
                "/v1/ws/child": "device",
                "/v1/ws/parent": "parent",
            }.get(route.path, "parent-or-device")
            routes.append((route.path, "WEBSOCKET", auth_kind))
            continue
        if not isinstance(route, APIRoute):
            continue
        if route.path.startswith(("/docs", "/redoc", "/openapi")):
            continue
        dependencies = _dependency_names(route)
        if "current_parent" in dependencies:
            auth_kind = "parent"
        elif "current_device" in dependencies:
            auth_kind = "device"
        elif route.path.startswith("/v1/push/actions/"):
            auth_kind = "action-token"
        else:
            auth_kind = "public"
        routes.extend((route.path, method, auth_kind) for method in sorted(route.methods))
    return routes


def test_registered_routes_match_expected_inventory() -> None:
    expected = sorted(EXPECTED_ROUTES)
    actual = sorted(_registered_routes())

    assert len(actual) == len(set(actual)), "registered route duplicated"
    assert actual == expected
