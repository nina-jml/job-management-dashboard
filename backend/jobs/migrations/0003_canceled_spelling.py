"""Respell CANCELLED to CANCELED, in the data as well as the choices.

`choices` is Django metadata, so altering it alone is a no-op against Postgres —
and that is exactly the trap. The status is stored as a *string*, so every
existing row would keep saying `CANCELLED` while the application no longer
recognises the value: the frontend could not map it to a label, the state
machine would not find it in `ALLOWED`, and a filter on `?status=CANCELED` would
silently miss those jobs.

So the data has to move too. Reversible in both directions, because a migration
you cannot roll back is a migration you cannot deploy with any confidence.
"""

from django.db import migrations, models


def to_canceled(apps, schema_editor):
    _respell(apps, "CANCELLED", "CANCELED")


def to_cancelled(apps, schema_editor):
    _respell(apps, "CANCELED", "CANCELLED")


def _respell(apps, old: str, new: str) -> None:
    # Both tables: the append-only log *and* the projection over it. Updating one
    # would leave `Job.current_status` disagreeing with its own latest event,
    # which is the invariant the whole design rests on.
    Job = apps.get_model("jobs", "Job")
    JobStatus = apps.get_model("jobs", "JobStatus")

    JobStatus.objects.filter(status_type=old).update(status_type=new)
    Job.objects.filter(current_status=old).update(current_status=new)


CHOICES = [
    ("PENDING", "Pending"),
    ("RUNNING", "Running"),
    ("COMPLETED", "Completed"),
    ("FAILED", "Failed"),
    ("CANCELED", "Canceled"),
]


class Migration(migrations.Migration):
    dependencies = [
        ("jobs", "0002_alter_job_current_status_alter_jobstatus_status_type"),
    ]

    operations = [
        migrations.AlterField(
            model_name="job",
            name="current_status",
            field=models.CharField(
                choices=CHOICES,
                default="PENDING",
                help_text=(
                    "Denormalized from the latest JobStatus. "
                    "Written only by services.record_status()."
                ),
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="jobstatus",
            name="status_type",
            field=models.CharField(choices=CHOICES, max_length=16),
        ),
        migrations.RunPython(to_canceled, to_cancelled),
    ]
