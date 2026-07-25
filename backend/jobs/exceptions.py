"""
One error shape for the whole API.

DRF's default handler returns a different JSON body depending on which
exception fired — `{"detail": …}` here, `{"field": [...]}` there. That pushes
the branching into the frontend. Normalizing it here means `api/jobs.ts` has a
single `ApiError` type and one parsing path (TEST_PLAN cases B5, C5, C7, E4).

    {
      "detail": "human-readable summary",
      "errors": {"name": ["This field may not be blank."]}   # field errors, or {}
    }
"""

import logging

from django.db import DatabaseError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

logger = logging.getLogger(__name__)


def api_exception_handler(exc, context):
    response = drf_exception_handler(exc, context)

    if response is None:
        # Not a DRF exception: a genuine bug or a database failure. Log it with
        # the traceback, but never leak internals to the client.
        logger.exception("Unhandled exception in %s", context.get("view"))
        if isinstance(exc, DatabaseError):
            detail = "A database error occurred. Please try again."
        else:
            detail = "An unexpected server error occurred."
        return Response(
            {"detail": detail, "errors": {}},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    data = response.data
    if isinstance(data, dict) and "detail" in data and len(data) == 1:
        # Already a summary-only error (404, 405, permission denied…).
        response.data = {"detail": str(data["detail"]), "errors": {}}
    elif isinstance(data, dict):
        # Serializer validation errors: keep them keyed by field, and surface a
        # readable summary so the UI can show something without introspecting.
        response.data = {"detail": _summarize(data), "errors": data}
    else:
        # Non-field errors arrive as a bare list.
        response.data = {"detail": _summarize({"non_field_errors": data}), "errors": {"non_field_errors": data}}

    return response


def _summarize(errors: dict) -> str:
    for field, messages in errors.items():
        first = messages[0] if isinstance(messages, (list, tuple)) and messages else messages
        return str(first) if field == "non_field_errors" else f"{field}: {first}"
    return "Invalid request."
