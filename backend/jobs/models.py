"""
Two tables, one relationship, and one deliberate denormalization.

`JobStatus` is an append-only event log — "at time T this job was observed in
state S". Nothing mutates or deletes a status row; a status *change* is a new
row. `Job.current_status` / `Job.current_status_at` are a projection of that
log, maintained by `services.record_status()` and by nothing else.

Full rationale (including why the projection exists at all, and why the guard
compares against `current_status_at` rather than `updated_at`) is in
docs/OPEN_QUESTIONS.md Q2.
"""

from django.db import models
from django.utils import timezone


class StatusType(models.TextChoices):
    """The states a job can be observed in.

    Stored as strings rather than ints: readable straight out of the database
    and straight off the wire, and adding a state is a no-op at the column level
    — `choices` is Django metadata, so CANCELED arrived without a schema change.

    CANCELED is deliberately distinct from deleting the job. Deleting removes
    the record; cancelling stops the work and *keeps* it. A cancelled job still
    consumed compute time, and that is exactly the history you want to audit.
    """

    PENDING = "PENDING", "Pending"
    RUNNING = "RUNNING", "Running"
    COMPLETED = "COMPLETED", "Completed"
    FAILED = "FAILED", "Failed"
    CANCELED = "CANCELED", "Canceled"


class Job(models.Model):
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # --- projection of the JobStatus log; see module docstring ---------------
    current_status = models.CharField(
        max_length=16,
        choices=StatusType.choices,
        default=StatusType.PENDING,
        help_text="Denormalized from the latest JobStatus. Written only by services.record_status().",
    )
    current_status_at = models.DateTimeField(
        default=timezone.now,
        help_text="Timestamp of the JobStatus row that produced current_status.",
    )

    class Meta:
        ordering = ("-created_at", "-id")
        indexes = [
            # Keyset pagination on the default ordering. The `id` tiebreaker
            # makes the ordering *total*: without it, two jobs created in the
            # same microsecond could be skipped or repeated across pages.
            models.Index(fields=["-created_at", "-id"], name="job_created_desc_idx"),
            # Filtering by status without scanning the table — the query the
            # projection exists to serve.
            models.Index(
                fields=["current_status", "-created_at", "-id"],
                name="job_status_created_idx",
            ),
            # The trigram index serving `?search=` is deliberately *not*
            # declared here. It lives in migration 0004 as explicit DDL, for two
            # reasons both worth knowing:
            #
            # 1. It has to be built on `UPPER(name::text)`, not on `name`,
            #    because that is what Django compiles `name__icontains` to on
            #    PostgreSQL. An index on the bare column cannot serve a
            #    predicate whose left side is a function call: it would pay the
            #    full GIN write cost on every insert and every rename while the
            #    search stayed a sequential scan — precisely what the index
            #    exists to prevent.
            # 2. `GinIndex(OpClass(Upper("name"), name="gin_trgm_ops"))` renders
            #    the operator class *inside* the expression parentheses, which
            #    Postgres rejects. Hand-written DDL is the version that both
            #    works and shows a reader exactly what was created.
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.current_status})"


class JobStatus(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name="statuses")
    status_type = models.CharField(max_length=16, choices=StatusType.choices)
    timestamp = models.DateTimeField(default=timezone.now)

    class Meta:
        verbose_name_plural = "job statuses"
        ordering = ("-timestamp", "-id")
        indexes = [
            # Serves "latest status for this job" and "history for this job",
            # and keeps the ON DELETE CASCADE cheap.
            models.Index(fields=["job", "-timestamp", "-id"], name="jobstatus_job_ts_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.job_id} → {self.status_type} @ {self.timestamp.isoformat()}"
