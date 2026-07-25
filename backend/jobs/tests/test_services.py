"""
Unit coverage for the one invariant the whole design rests on: the projection
on `Job` always reflects the newest event in the `JobStatus` log.

These run under `make test-backend`, deliberately outside the `make test` gate
(docs/OPEN_QUESTIONS.md Q6).
"""

from datetime import timedelta

import pytest
from django.utils import timezone

from jobs.models import Job, JobStatus, StatusType
from jobs.services import create_job, record_status

pytestmark = pytest.mark.django_db


def test_create_job_writes_exactly_one_pending_event():
    job = create_job("Fluid Dynamics Simulation")

    assert job.current_status == StatusType.PENDING
    events = list(job.statuses.all())
    assert len(events) == 1
    assert events[0].status_type == StatusType.PENDING


def test_a_job_never_exists_without_a_status():
    # The projection is meaningless if the log it projects is empty, so the two
    # writes are atomic by construction.
    job = create_job("ML Model Training")

    assert JobStatus.objects.filter(job=job).exists()
    assert job.current_status_at is not None


def test_record_status_appends_and_advances_the_projection():
    job = create_job("Thermal Analysis")

    record_status(job, StatusType.RUNNING)

    job.refresh_from_db()
    assert job.current_status == StatusType.RUNNING
    assert job.statuses.count() == 2
    # The log is append-only: the earlier PENDING observation survives.
    assert job.statuses.filter(status_type=StatusType.PENDING).exists()


def test_repeating_a_status_appends_an_event_and_advances_the_timestamp():
    # "Still RUNNING at 10:42" is information, not a no-op (TEST_PLAN case C4).
    job = create_job("Monte Carlo Sweep")
    record_status(job, StatusType.RUNNING)
    first_at = Job.objects.get(pk=job.pk).current_status_at

    record_status(job, StatusType.RUNNING)

    job.refresh_from_db()
    assert job.statuses.count() == 3
    assert job.current_status == StatusType.RUNNING
    assert job.current_status_at > first_at


def test_a_stale_event_is_logged_but_does_not_move_the_projection():
    """The guard from docs/OPEN_QUESTIONS.md Q2.

    Inert while timestamps are server-stamped, load-bearing the moment events
    arrive from a scheduler, a retry, or a backfill.
    """
    job = create_job("Seismic Solve")
    record_status(job, StatusType.COMPLETED)
    job.refresh_from_db()
    current_at = job.current_status_at

    record_status(job, StatusType.RUNNING, timestamp=current_at - timedelta(hours=1))

    job.refresh_from_db()
    assert job.statuses.count() == 3, "the stale event must still be recorded"
    assert job.current_status == StatusType.COMPLETED, "the projection must not regress"
    assert job.current_status_at == current_at


def test_renaming_does_not_append_a_status_event():
    # updated_at moves on a rename, which is exactly why the guard compares
    # against current_status_at instead (TEST_PLAN case C8).
    job = create_job("Acoustic Study")
    before = job.statuses.count()

    job.name = "Acoustic Study (revised)"
    job.save(update_fields=["name", "updated_at"])

    assert job.statuses.count() == before


def test_a_rename_cannot_make_a_later_status_look_stale():
    """Regression guard for the updated_at-vs-current_status_at decision.

    If the guard compared against `updated_at`, the rename below would push it
    past the incoming event's timestamp and the status change would be lost.
    """
    job = create_job("Combustion Benchmark")

    job.name = "Combustion Benchmark v2"
    job.save(update_fields=["name", "updated_at"])
    job.refresh_from_db()
    assert job.updated_at > job.current_status_at

    record_status(job, StatusType.RUNNING, timestamp=timezone.now())

    job.refresh_from_db()
    assert job.current_status == StatusType.RUNNING


def test_deleting_a_job_cascades_to_its_status_log():
    job = create_job("Crash Simulation")
    record_status(job, StatusType.RUNNING)
    job_id = job.pk

    job.delete()

    assert not JobStatus.objects.filter(job_id=job_id).exists()
