from django.db import connection
from django.http import JsonResponse
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError

from .models import Job, StatusType
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

    def get_queryset(self):
        """Apply `?status=` server-side, across the whole table.

        Filtering the loaded page in the browser would be a wrong answer
        delivered quickly: at the scale this design targets, the matching rows
        are usually not the ones already fetched (SPEC §2).

        This is the query the `current_status` projection exists to serve — it
        is an indexed column read, not a per-row subquery over the status log.

        The parameter repeats to select several at once —
        `?status=RUNNING&status=FAILED` means either. Repetition rather than a
        comma-separated list because it is what `URLSearchParams` and DRF both
        produce by default, so neither side needs a parsing rule. Omitting it
        entirely means no filter; there is no "all" sentinel to keep in sync
        between the client and the server.

        `IN` over the leading column of `(current_status, created_at, id)` is a
        handful of index range seeks, so selecting four statuses costs about
        what selecting one does — it does not degrade into a scan.
        """
        queryset = super().get_queryset()

        # Only the collection is filtered. `get_object()` reads this same
        # queryset, so narrowing it on a detail route turns a list filter into
        # an existence predicate: `GET /api/jobs/5/?status=RUNNING` would 404 a
        # PENDING job 5 instead of returning it, and `/statuses/?status=bogus`
        # would 400 about a filter that endpoint does not even have.
        if self.action != "list":
            return queryset

        # Drop empties so a stray `?status=` is "no filter", not "no results".
        statuses = [s for s in self.request.query_params.getlist("status") if s]
        if statuses:
            invalid = [s for s in statuses if s not in StatusType.values]
            if invalid:
                # Silently returning nothing would look like "no jobs match"
                # rather than "that isn't a status". Every bad value is named,
                # so a caller fixes them in one round trip rather than five.
                raise ValidationError(
                    {"status": [f"'{s}' is not a valid status." for s in invalid]}
                )
            # dict.fromkeys dedupes and keeps order, so the generated SQL is
            # stable — a repeated value must not turn into a longer IN list.
            queryset = queryset.filter(current_status__in=list(dict.fromkeys(statuses)))

        return queryset

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
