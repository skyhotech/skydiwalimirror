import math

from rest_framework.exceptions import Throttled
from rest_framework.views import exception_handler


def _human_wait(seconds):
    """'45 seconds' or '60 minutes'; keep in sync with ERRORS.busy in src/lib/backend.ts."""
    seconds = math.ceil(seconds)
    if seconds < 90:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    minutes = math.ceil(seconds / 60)
    return f"{minutes} minutes"


def friendly_exception_handler(exc, context):
    """DRF errors in plain language for customers and staff."""
    response = exception_handler(exc, context)
    if response is None:
        return None
    if isinstance(exc, Throttled):
        response.data = {
            "detail": f"Too many tries. Please wait {_human_wait(exc.wait or 30)} and try again."
        }
    elif response.status_code == 403 and "detail" in response.data:
        response.data = {"detail": "Please sign in again to continue."}
    return response
