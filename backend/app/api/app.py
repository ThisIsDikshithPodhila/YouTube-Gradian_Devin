import json
import logging
import re
from collections.abc import Awaitable, Callable
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from starlette.responses import Response

from ..auth.router import router as auth_router
from ..children.router import router as children_router
from ..core.errors import http_exception_handler, internal_error_handler, validation_error_handler
from ..devices.router import router as devices_router
from ..events.router import router as events_router
from ..families.router import router as families_router
from ..health.router import router as health_router
from ..pairing.router import router as pairing_router
from ..policies.router import router as policies_router
from ..push.router import router as push_router
from ..reputation.router import router as reputation_router
from ..requests.router import router as requests_router
from .handler_support import notifier
from .lifecycle import lifespan

app = FastAPI(title="Guardian API", version="0.1.0", lifespan=lifespan)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _safe_log_path(path: str) -> str:
    """Remove bearer-like action tokens before writing a request path to logs."""
    return re.sub(
        r"(/v1/push/actions/)[^/]+/(approve|deny)$",
        r"\1[redacted]/\2",
        path,
    )


@app.middleware("http")
async def request_id_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    logger.warning(
        json.dumps(
            {
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "path": _safe_log_path(request.url.path),
                "status_code": response.status_code,
                "response_request_id": response.headers.get("X-Request-ID"),
            },
            separators=(",", ":"),
        ),
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": _safe_log_path(request.url.path),
            "status_code": response.status_code,
        },
    )
    return response


app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(Exception, internal_error_handler)

for router in (
    auth_router,
    families_router,
    children_router,
    devices_router,
    pairing_router,
    policies_router,
    events_router,
    health_router,
    requests_router,
    push_router,
    reputation_router,
):
    app.include_router(router)
__all__ = ["app", "notifier"]
