"""
The single writer of the status projection.

Every path that records a status — job creation, PATCH, re-run, the seed
command — goes through `record_status()`. That is the whole point: one function
can drift from the log, six cannot.
"""

from django.db import transaction
from django.utils import timezone

from . import transitions
from .models import Job, JobStatus, StatusType


@transaction.atomic
def record_status(job: Job, status_type: str, *, timestamp=None) -> JobStatus:
    """Append a status event and advance the projection if the event is newer.

    The event is *always* appended — the log is the source of truth and never
    loses information. Only the projection on `Job` is conditional.

    Locks the job row for the duration, so two concurrent status changes
    serialize instead of racing (TEST_PLAN case C11).

    This is the low-level writer: it enforces no transition rules, because the
    seed command and job creation legitimately write states the state machine
    would not permit as *edits*. Callers that act on user input go through
    `apply_status_change()`.

    `timestamp` is not accepted from API clients (OPEN_QUESTIONS Q3); it exists
    for the seed command, which backdates rows to build realistic histories.
    """
    timestamp = timestamp or timezone.now()

    # Two instances of the same row are in play, deliberately:
    #   `job`        — the caller's, possibly read before another writer committed
    #   `locked_job` — re-read under SELECT ... FOR UPDATE, so its projection is
    #                  current and no one else can change it until we commit
    # The guard below compares against the locked copy; the caller's is synced at
    # the end so it does not silently hold stale values.
    locked_job = Job.objects.select_for_update().get(pk=job.pk)

    event = JobStatus.objects.create(job=locked_job, status_type=status_type, timestamp=timestamp)

    # Guard on current_status_at, never updated_at: updated_at moves on every
    # save (a rename bumps it), which would make a later legitimate event look
    # stale and get silently dropped.
    if timestamp >= locked_job.current_status_at:
        locked_job.current_status = status_type
        locked_job.current_status_at = timestamp
        locked_job.save(update_fields=["current_status", "current_status_at", "updated_at"])

    # Keep the caller's instance consistent with what was just committed.
    job.current_status = locked_job.current_status
    job.current_status_at = locked_job.current_status_at
    job.updated_at = locked_job.updated_at

    return event


@transaction.atomic
def apply_status_change(job: Job, target: str) -> JobStatus | None:
    """Move a job to `target`, enforcing the state machine.

    Returns the appended event, or `None` when the request was a no-op.

    Three cases, in order:

    1. `target` is the status the job already has → **idempotent no-op**. Nothing
       is appended and no error is raised. A double-click or a retried request
       after a dropped response asked for a state the job is already in; that is
       not a failure (OPEN_QUESTIONS Q8, TEST_PLAN case C6).
    2. The job is FAILED and `target` is PENDING → a **re-run**.
    3. Otherwise the transition must satisfy `transitions.ALLOWED`, or
       `TransitionError` propagates and the view turns it into a 400.
    """
    # Lock before reading the status the decision is based on, or two concurrent
    # requests could both validate against a stale value.
    #
    # `record_status()` below takes the same lock again. Within this transaction
    # that re-acquisition is free — the row is already held — and it costs one
    # extra SELECT. Worth it: `record_status()` stays correct when called on its
    # own, which `create_job()` does.
    locked_job = Job.objects.select_for_update().get(pk=job.pk)
    current = locked_job.current_status

    if target == current:
        return None

    if transitions.can_retry(current) and target == transitions.RETRY_TARGET:
        transitions.check_retry(current)
    else:
        transitions.check(current, target)

    return record_status(job, target)


@transaction.atomic
def create_job(name: str) -> Job:
    """Create a job together with its initial PENDING status.

    Atomic by construction: a job must never exist with an empty status log,
    because `current_status` would then be a projection of nothing.
    """
    job = Job.objects.create(name=name)
    record_status(job, StatusType.PENDING, timestamp=job.created_at)
    return job
