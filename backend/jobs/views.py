from django.db import connection
from django.http import JsonResponse
from rest_framework import mixins, viewsets

from .models import Job
from .serializers import JobSerializer


def health(request):
    """Liveness + database readiness.

    Deliberately a plain Django view rather than a DRF one: it has to keep
    answering even if DRF configuration is the thing that is broken.

    `make test` and the compose healthcheck both gate on this. Without it the
    suite races Postgres initialization, which is the classic intermittent CI
    failure (TEST_PLAN case A2).
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception as exc:  # noqa: BLE001 — report any failure, don't crash the probe
        return JsonResponse({"status": "error", "database": "error", "detail": str(exc)}, status=503)

    return JsonResponse({"status": "ok", "database": "ok"})


class JobViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Jobs: list, retrieve, create, update.

    Composed from explicit mixins rather than `ModelViewSet` so each verb
    arrives with the slice that tests it — destroy lands in slice 4. An
    untested endpoint is never reachable.
    """

    queryset = Job.objects.all()
    serializer_class = JobSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]
