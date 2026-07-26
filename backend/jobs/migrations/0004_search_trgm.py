"""Trigram index for substring search on `Job.name`.

`name ILIKE '%combustor%'` cannot use a btree index — the leading wildcard means
there is no prefix to seek on, so Postgres falls back to a sequential scan. That
is the one query shape this design otherwise avoids everywhere, and at a few
hundred thousand rows it is the difference between a search box and a timeout.

A GIN index over trigrams can serve it. `pg_trgm` ships with the official
`postgres:16` image, so enabling it is a migration rather than a deployment
prerequisite — which is the whole reason this is affordable here.

The costs, stated rather than hidden: the index is larger than a btree and adds
write amplification on every insert and name change, and a highly unselective
term still has to sort a large candidate set. Trigram makes substring search
viable, not free.
"""

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.operations import TrigramExtension
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("jobs", "0003_canceled_spelling"),
    ]

    operations = [
        # Must come first: the index references gin_trgm_ops, which does not
        # exist until the extension does.
        TrigramExtension(),
        migrations.AddIndex(
            model_name="job",
            index=GinIndex(
                fields=["name"],
                name="job_name_trgm_idx",
                opclasses=["gin_trgm_ops"],
            ),
        ),
    ]
