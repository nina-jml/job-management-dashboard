from django.db import connection
from django.http import JsonResponse
from rest_framework import mixins, viewsets
from rest_framework.decorators import action

from .models import Job
from .pagination import JobStatusCursorPagination
from .serializers import JobSerializer, JobStatusSerializer


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
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Jobs: list, retrieve, create, update, destroy, plus status history.

    Composed from explicit mixins rather than `ModelViewSet` so each verb
    arrived with the slice whose spec covers it. An untested endpoint was never
    reachable.

    DELETE returns 204 and cascades to the job's `JobStatus` rows. The cascade
    is Django's ORM collector, *not* an `ON DELETE CASCADE` clause on the
    Postgres constraint (SPEC §2) — sufficient while every write goes through
    the ORM, and TEST_PLAN case D3 asserts no orphan rows survive.
    """

    queryset = Job.objects.all()
    serializer_class = JobSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    @action(detail=True, methods=["get"], url_path="statuses")
    def statuses(self, request, pk=None):
        """The job's status history, newest first.

        Not required by the prompt, but it is the only way to *demonstrate*
        rather than assert the two claims the design rests on: that the log is
        append-only (the earlier entry survives a status change) and that
        DELETE cascaded (this 404s afterwards, via the parent lookup).

        Paginated for the same reason the job list is. A long-lived job polled
        by a scheduler could accumulate a great many events, and "it's only a
        history" is exactly the assumption that later becomes an unbounded
        response.
        """
        job = self.get_object()

        paginator = JobStatusCursorPagination()
        page = paginator.paginate_queryset(job.statuses.all(), request, view=self)
        return paginator.get_paginated_response(JobStatusSerializer(page, many=True).data)
