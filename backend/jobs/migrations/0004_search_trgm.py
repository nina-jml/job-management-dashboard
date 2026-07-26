"""Trigram index for substring search on `Job.name`.

`name ILIKE '%combustor%'` cannot use a btree index — the leading wildcard leaves
no prefix to seek on, so Postgres falls back to a sequential scan. That is the
one query shape this design avoids everywhere else, and at a few hundred thousand
rows it is the difference between a search box and a timeout.

A GIN index over trigrams can serve it. `pg_trgm` ships with the official
`postgres:16` image, so enabling it is a migration rather than a deployment
prerequisite — which is the whole reason this is affordable here.

**The index is on `UPPER(name::text)`, not on `name`.** Django compiles
`name__icontains` to `UPPER("jobs_job"."name"::text) LIKE UPPER(%…%)` on
PostgreSQL, and an index on the bare column cannot serve a predicate whose left
side is a function call. That failure mode is quiet and expensive: the index
exists, `EXPLAIN` on hand-written `ILIKE` even shows it being used, and the
application's own query still scans the table while paying the full GIN write
cost on every insert and rename. It was caught in review, not by writing it
correctly first — hence the emphasis.

Written as raw DDL rather than `GinIndex(OpClass(Upper(...)))` because that
renders the operator class *inside* the expression parentheses —
`USING gin ((UPPER("name") gin_trgm_ops))` — which Postgres rejects with a syntax
error. The SQL below is what actually works, and reads unambiguously.

Costs, stated rather than hidden: the index is larger than a btree and adds write
amplification on insert and on any name change, and a highly unselective term
still has to sort a large candidate set. Trigram makes substring search viable,
not free.
"""

from django.contrib.postgres.operations import TrigramExtension
from django.db import migrations

# `name::text` matches the cast Django emits. Postgres matches functional index
# expressions structurally, so the indexed expression has to be spelled the way
# the query spells it.
CREATE_INDEX = """
    CREATE INDEX job_name_trgm_idx
        ON jobs_job
     USING gin ((UPPER(name::text)) gin_trgm_ops);
"""

DROP_INDEX = "DROP INDEX IF EXISTS job_name_trgm_idx;"


class Migration(migrations.Migration):
    dependencies = [
        ("jobs", "0003_canceled_spelling"),
    ]

    operations = [
        # Must come first: the index references gin_trgm_ops, which does not
        # exist until the extension does.
        TrigramExtension(),
        migrations.RunSQL(CREATE_INDEX, reverse_sql=DROP_INDEX),
    ]
