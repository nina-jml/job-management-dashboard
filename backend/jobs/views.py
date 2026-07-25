from django.db import connection
from django.http import JsonResponse


def health(request):
    """Liveness + database readiness.

    Deliberately a plain Django view rather than a DRF one: it has to keep
    answering even if DRF configuration is the thing that is broken.

    `make test` and the compose healthcheck both gate on this. Without it the
    suite races Postgres initialization, which is the classic intermittent CI
    failure (TEST_PLAN case F2).
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception as exc:  # noqa: BLE001 — report any failure, don't crash the probe
        return JsonResponse({"status": "error", "database": "error", "detail": str(exc)}, status=503)

    return JsonResponse({"status": "ok", "database": "ok"})
