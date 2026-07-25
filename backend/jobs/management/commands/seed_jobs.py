"""
Seed realistic jobs, in bulk.

Used two ways:
  * a handful of rows so the dashboard isn't empty during development
  * hundreds of thousands of rows to substantiate the performance claims in the
    README rather than merely assert them (TEST_PLAN case F7)

At 250k rows the naive approach — one `create_job()` per job — is a quarter of
a million round trips. This uses `bulk_create` in batches instead, and computes
the projection in Python, which is the one place it is legitimate to bypass
`record_status()`: nothing is concurrent here, and the guard has nothing to
guard against.
"""

import random
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from jobs.models import Job, JobStatus, StatusType

BATCH_SIZE = 5_000

NAME_PARTS = (
    ("Fluid Dynamics", "ML Model", "Structural", "Thermal", "Monte Carlo", "Crash", "Acoustic",
     "Electromagnetic", "Combustion", "Aerodynamic", "Molecular", "Seismic"),
    ("Simulation", "Training", "Analysis", "Optimization", "Sweep", "Validation", "Benchmark",
     "Calibration", "Study", "Solve"),
)

# Plausible lifecycles, so filtering and history views have something real to
# show. Weighted toward terminal states, as a real queue would be. Every entry
# is a legal walk through jobs.transitions.ALLOWED — seeded data that the state
# machine would reject makes for very confusing debugging.
LIFECYCLES = (
    ([StatusType.PENDING], 14),
    ([StatusType.PENDING, StatusType.RUNNING], 18),
    ([StatusType.PENDING, StatusType.RUNNING, StatusType.COMPLETED], 40),
    ([StatusType.PENDING, StatusType.RUNNING, StatusType.FAILED], 16),
    # Called off mid-flight, and called off before it ever started.
    ([StatusType.PENDING, StatusType.RUNNING, StatusType.CANCELLED], 8),
    ([StatusType.PENDING, StatusType.CANCELLED], 4),
)


class Command(BaseCommand):
    help = "Create N jobs with plausible status histories."

    def add_arguments(self, parser):
        parser.add_argument("-n", "--count", type=int, default=50, help="How many jobs to create.")
        parser.add_argument("--prefix", default="", help="Prefix every job name (useful for test isolation).")
        parser.add_argument("--clear", action="store_true", help="Delete all existing jobs first.")
        parser.add_argument("--seed", type=int, default=None, help="RNG seed, for reproducible data.")

    def handle(self, *args, **options):
        count: int = options["count"]
        prefix: str = options["prefix"]
        rng = random.Random(options["seed"])

        if options["clear"]:
            deleted, _ = Job.objects.all().delete()
            self.stdout.write(f"Cleared {deleted} rows.")

        lifecycles = [lc for lc, weight in LIFECYCLES for _ in range(weight)]
        now = timezone.now()
        created = 0

        for batch_start in range(0, count, BATCH_SIZE):
            batch_size = min(BATCH_SIZE, count - batch_start)
            jobs, histories = [], []

            for i in range(batch_size):
                index = batch_start + i
                # Spread creation times backwards so the default ordering has
                # something meaningful to sort by.
                created_at = now - timedelta(seconds=index * rng.uniform(30, 120))
                lifecycle = rng.choice(lifecycles)

                events, cursor = [], created_at
                for status_type in lifecycle:
                    events.append((status_type, cursor))
                    cursor += timedelta(seconds=rng.uniform(60, 3600))

                final_status, final_at = events[-1]
                name = f"{prefix}{rng.choice(NAME_PARTS[0])} {rng.choice(NAME_PARTS[1])} #{index + 1}"

                jobs.append(
                    Job(
                        name=name,
                        created_at=created_at,
                        updated_at=final_at,
                        current_status=final_status,
                        current_status_at=final_at,
                    )
                )
                histories.append(events)

            with transaction.atomic():
                # auto_now_add / auto_now would overwrite our backdated values on
                # a normal save(); bulk_create bypasses them, which is exactly
                # what we want here.
                Job.objects.bulk_create(jobs)
                JobStatus.objects.bulk_create(
                    [
                        JobStatus(job=job, status_type=status_type, timestamp=ts)
                        for job, events in zip(jobs, histories)
                        for status_type, ts in events
                    ]
                )

            created += batch_size
            self.stdout.write(f"  … {created}/{count}")

        self.stdout.write(self.style.SUCCESS(f"Seeded {created} jobs."))
