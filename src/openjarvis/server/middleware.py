"""Security middleware -- HTTP security headers and request guards."""

from __future__ import annotations

from typing import Any

__all__ = ["SECURITY_HEADERS", "create_security_middleware"]


def create_security_middleware() -> Any:
    """Create a FastAPI middleware that adds security headers.

    Returns a middleware class/callable, or None if FastAPI is not available.

    Headers added:
    - X-Content-Type-Options: nosniff
    - X-Frame-Options: DENY
    - X-XSS-Protection: 1; mode=block
    - Strict-Transport-Security: max-age=31536000; includeSubDomains
    - Referrer-Policy: strict-origin-when-cross-origin
    - Permissions-Policy: camera=(), microphone=(self), geolocation=()

    Microphone is scoped to "self" (this origin only) because the
    INKAL Command Center records voice input from the browser for
    /v1/speech/transcribe; camera and geolocation stay fully denied
    since nothing in this server uses them.

    CSP adds an explicit media-src allowing "blob:" because the Command
    Center plays synthesized speech (/v1/speech/synthesize) through an
    <audio> element backed by a blob: URL. Without it, media-src falls
    back to default-src's 'self', which does not cover blob: sources --
    Chrome then refuses to load the audio and reports the generic,
    misleading "no supported source" / MEDIA_ERR_SRC_NOT_SUPPORTED
    error, which looks like a codec/format problem but is really CSP
    silently blocking the resource load before decoding ever starts.

    OPTIONS requests are passed through without headers so that
    CORS preflight is not blocked.
    """
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request
        from starlette.responses import Response
    except ImportError:
        return None

    class SecurityHeadersMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next: Any) -> Response:
            # Let CORS preflight requests pass through without
            # security headers that would conflict with CORS.
            if request.method == "OPTIONS":
                return await call_next(request)

            response = await call_next(request)
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["X-XSS-Protection"] = "1; mode=block"
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            response.headers["Permissions-Policy"] = (
                "camera=(), microphone=(self), geolocation=()"
            )
            response.headers["Content-Security-Policy"] = (
                "default-src 'self' 'unsafe-inline' 'unsafe-eval'; "
                "media-src 'self' blob:"
            )
            return response

    return SecurityHeadersMiddleware


# Also export the header values as constants for testing
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self' 'unsafe-inline' 'unsafe-eval'; media-src 'self' blob:"
    ),
}
