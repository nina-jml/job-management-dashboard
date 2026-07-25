"""
Cascade behaviour on delete — TEST_PLAN case D3.

This lives here rather than in the E2E suite for a specific reason. The nested
`/api/jobs/<id>/statuses/` route 404s on the *parent* lookup, so a job whose
status rows were orphaned rather than deleted would return a byte-identical 404.
Only a direct query can tell those two apart, which is exactly what "no orphans"
means.
"""

import pytest

from jobs.models import Job, JobStatus, StatusType
from jobs.services import apply_status_change, create_job

pytestmark = pytest.mark.django_db


def test_deleting_a_job_removes_every_status_row():
    job = create_job("Crash Pulse — Frontal Offset 40%")
    apply_status_change(job, StatusType.RUNNING)
    apply_status_change(job, StatusType.FAILED)
    job_id = job.pk
    assert JobStatus.objects.filter(job_id=job_id).count() == 3

    job.delete()

    # The assertion the E2E suite structurally cannot make: nothing is left
    # pointing at an id that no longer resolves.
    assert not JobStatus.objects.filter(job_id=job_id).exists()
    assert not Job.objects.filter(pk=job_id).exists()


def test_the_cascade_touches_only_the_deleted_job():
    keep = create_job("Rotor Blade Modal Analysis")
    apply_status_change(keep, StatusType.RUNNING)
    drop = create_job("Transonic Wing Sweep")
    apply_status_change(drop, StatusType.RUNNING)

    drop.delete()

    assert JobStatus.objects.filter(job_id=keep.pk).count() == 2
    assert not JobStatus.objects.filter(job_id=drop.pk).exists()


def test_bulk_delete_also_cascades():
    # Django's collector runs for queryset deletes too, but it is worth pinning:
    # this is the path a cleanup script or an admin action would take.
    jobs = [create_job(f"Job {index}") for index in range(3)]
    for job in jobs:
        apply_status_change(job, StatusType.RUNNING)
    ids = [job.pk for job in jobs]
    assert JobStatus.objects.filter(job_id__in=ids).count() == 6

    Job.objects.filter(pk__in=ids).delete()

    assert not JobStatus.objects.filter(job_id__in=ids).exists()


def test_no_orphan_status_rows_exist_anywhere():
    # A standing invariant rather than a scenario: every JobStatus must point at
    # a live job. If a future change introduced a delete path that bypassed the
    # collector, this is what would catch it.
    create_job("Aeroacoustic Far-Field Propagation")
    doomed = create_job("Turbine Disc Creep")
    apply_status_change(doomed, StatusType.RUNNING)
    doomed.delete()

    live_ids = set(Job.objects.values_list("pk", flat=True))
    referenced_ids = set(JobStatus.objects.values_list("job_id", flat=True))

    assert referenced_ids <= live_ids
