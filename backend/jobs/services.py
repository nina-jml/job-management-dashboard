"""
The single writer of the status projection.

Every path that records a status — job creation, PATCH, the seed command —
goes through `record_status()`. That is the whole point: one function can drift
from the log, six cannot.
"""

from django.db import transaction
from django.utils import timezone

from .models import Job, JobStatus, StatusType


@transaction.atomic
def record_status(job: Job, status_type: str, *, timestamp=None) -> JobStatus:
    """Append a status event and advance the projection if the event is newer.

    The event is *always* appended — the log is the source of truth and never
    loses information. Only the projection on `Job` is conditional.

    Locks the job row for the duration, so two concurrent status changes
    serialize instead of racing (TEST_PLAN case B9).

    `timestamp` is not accepted from API clients (OPEN_QUESTIONS Q3); it exists
    for the seed command, which backdates rows to build realistic histories.
    """
    timestamp = timestamp or timezone.now()

    # Re-read under the lock: `job` may have been fetched before another writer
    # committed, and we need the current projection to compare against.
    locked = Job.objects.select_for_update().get(pk=job.pk)

    event = JobStatus.objects.create(job=locked, status_type=status_type, timestamp=timestamp)

    # Guard on current_status_at, never updated_at: updated_at moves on every
    # save (a rename bumps it), which would make a later legitimate event look
    # stale and get silently dropped.
    if timestamp >= locked.current_status_at:
        locked.current_status = status_type
        locked.current_status_at = timestamp
        locked.save(update_fields=["current_status", "current_status_at", "updated_at"])

    # Keep the caller's instance consistent with what was just committed.
    job.current_status = locked.current_status
    job.current_status_at = locked.current_status_at
    job.updated_at = locked.updated_at

    return event


@transaction.atomic
def create_job(name: str) -> Job:
    """Create a job together with its initial PENDING status.

    Atomic by construction: a job must never exist with an empty status log,
    because `current_status` would then be a projection of nothing.
    """
    job = Job.objects.create(name=name)
    record_status(job, StatusType.PENDING, timestamp=job.created_at)
    return job
