# Performance & scope decisions

The brief asks what happens with **millions of jobs in the database**. This is the
long form of the answer, and of the things deliberately left out because of it.
The [README](../README.md#performance) carries the headline numbers.

Working assumption: the dataset is large, a single user's viewport is not. Nobody
scrolls a million rows. So the engineering problem is making every query cost
proportional to the **page**, not the **table**.

---

**Cursor (keyset) pagination, never offset.** Two things break page-number pagination at scale,
and cursor pagination avoids both:

- `OFFSET 500000` makes Postgres walk and discard half a million rows before returning anything.
  A keyset predicate — `WHERE (created_at, id) < (…)` — is an index seek, so page 20,000 costs
  what page 1 costs.
- DRF's `PageNumberPagination` issues a `COUNT(*)` on **every** request to build the `count`
  field. On a multi-million-row table that is a full index scan per page load, on the hot path,
  for a number nobody reads. Cursor pagination has none.

The trade-off, stated plainly: no "jump to page 47". For a feed-shaped dashboard that is the
right trade — nobody navigates a large list by page number; they narrow it.

## Measured, not asserted

Seeded to **250,000 jobs** (`make seed N=250000`, ~1m50s) with roughly 640,000 status rows behind
them. Query cost from `EXPLAIN ANALYZE`, on the same table, for the same 25 rows 200,000 deep:

| Query | Execution time |
|---|---|
| Keyset seek — `WHERE created_at < … ORDER BY … LIMIT 25` | **0.101 ms** |
| `OFFSET 200000 LIMIT 25` — the same page, the other way | **39.703 ms** |
| `COUNT(*)` — what `PageNumberPagination` adds to *every* request | **30.557 ms** |

The keyset seek is **~390× faster** than the offset it replaces, and the count DRF would have run
on every page load costs more on its own than serving the page. Neither number is a guess about
what happens at a million rows; both are measured at a quarter of one, and the shapes are what
matter — the seek is flat in depth, the other two are linear in table size.

End to end over HTTP, including Django and serialization:

| Rows in table | First page | 200,000 rows deep | Filtered by status |
|---|---|---|---|
| 100 | 10.6 ms | 10.0 ms | 10.1 ms |
| 250,000 | 19.0 ms | 28.3 ms | 16.7 ms |

Medians of 15 samples. The 2,500× increase in table size costs roughly 8 ms, and walking 200,000
rows in costs about 9 ms more than the first page — the depth-independence the design claims,
rather than a promise about it. The residual difference is buffer-cache behaviour on a larger
index, not the pagination strategy.

**Virtualization: judged unnecessary, not overlooked.** Server cost is flat, but DOM cost is linear
in what the user has *loaded* — and loading is an explicit "Load more" click of 25 rows, not
infinite scroll. Reaching even 500 rendered rows takes 20 deliberate actions. Virtualizing would
add a dependency and complicate every spec that addresses rows by selector, to fix a cost this UI
does not reach. If load-more became infinite scroll, or the page size grew, the threshold worth
acting on is somewhere near 1,000 rendered rows.

**Composite indexes covering the exact `ORDER BY` and `WHERE`:**

| Index | Serves |
|---|---|
| `Job (created_at DESC, id DESC)` | the default keyset walk |
| `Job (current_status, created_at DESC, id DESC)` | `?status=` without a scan |
| `JobStatus (job_id, timestamp DESC, id DESC)` | history lookups, and a cheap cascade delete |

`id` is the tiebreaker everywhere so the ordering is **total**. Without it, two rows sharing a
timestamp can be skipped or repeated across page boundaries.

**The status filter runs server-side, across the whole table** — never over the loaded page. Narrowing
client-side would mean a job that matches on page 400 simply does not appear and the user concludes it
does not exist: a wrong answer delivered quickly. The filter is repeatable and OR-ed
(`?status=RUNNING&status=FAILED`), and `IN` over the leading column of the composite index stays a set
of range seeks, so selecting four statuses costs about what selecting one does.

**Search by name is indexed for the query it actually runs.** `name ILIKE '%combustor%'` **cannot use a
btree index**: a leading wildcard leaves no prefix to seek on, so Postgres falls back to a sequential scan
— precisely the shape that falls over at the scale this section is about. So search ships with a GIN
trigram index built for it (`0004_search_trgm`), and `pg_trgm` comes with the `postgres:16` image, making
it a migration rather than a deployment prerequisite.

It was cut for time earlier in the build and added back, because at large job counts it is the control
that makes the list usable — five categorical chips cannot find "the combustor run from Tuesday". The
version that shipped is the indexed one; an unindexed substring scan would have contradicted the very
claim this section makes.

Debounced at 300ms, so a burst of typing is one query rather than one per keystroke, each of which would
be a trigram scan the next character immediately makes irrelevant.

The costs, named rather than hidden: a GIN index is larger than a btree and adds write amplification on
every insert and every name change, and a highly unselective term still has to sort a large candidate set.
Trigram makes substring search viable, not free.

**The index is on `UPPER(name::text)`, not on `name`** — because that is what Django compiles
`name__icontains` to on PostgreSQL. An index on the bare column cannot serve a predicate whose left side
is a function call: it would exist, look correct, pay the full GIN write cost on every insert and rename,
and leave the search as the sequential scan it was meant to prevent. Quiet, expensive, and easy to ship.

**Measured at 250,000 rows, through the ORM's own query** — `QuerySet.explain(analyze=True)` rather than
hand-written SQL, which is the only way to know the application's query uses the index rather than one that
merely resembles it:

| Term | Indexed | Index disabled | Plan chosen |
|---|---|---|---|
| `Combustion Optimization #1234` — 1 match | **30.6 ms** | 116.5 ms | Bitmap Index Scan on `job_name_trgm_idx` |
| `Combustion` — ~18,000 matches | **0.304 ms** | 138.6 ms | Index Scan on `job_created_desc_idx`, filtering |

The planner picks a *different* index for each, and both beat the sequential scan by a wide margin — but
for opposite reasons. A **rare** term is where the trigram index earns its place: nothing else finds one
row in a quarter of a million without reading them all. A **common** term does not use the trigram index at
all — walking the existing `created_at` ordering index and filtering satisfies `LIMIT 25` within a few
dozen rows, long before a bitmap over 18,000 matches would have finished.

So the unselective case, usually cited as trigram's weakness, is the fast one here. That is a consequence
of pagination rather than of the index: the query only ever needs the first 25 matches, and common terms
hand those over immediately. The selective case is the slower of the two at 30.6 ms, because a rare term
forces most of the GIN index to be read — still ~4× faster than the scan it replaces, and the case that
would otherwise be unusable.

**Sorting by column: declined, and the reason is the interesting part.** It looks like the smallest
of the features left out and is actually the largest, because the cursor encodes a position *in a
specific ordering*. Three consequences:

- Every sortable column needs its **own composite index** ending in `-id`, or sorting is a full sort
  of the table — the precise cost this section exists to avoid.
- Changing sort has to **reset the cursor**. A position in one ordering is meaningless in another, so
  "sort by name" cannot preserve where you were.
- **Sorting by status would be incorrect**, not merely slow. Per the limitation recorded below, DRF
  builds its cursor predicate from `ordering[0]` alone and pages rows sharing that value by integer
  offset. Ordering by `created_at`, a collision needs two inserts in the same microsecond. Ordering by
  `current_status` there are **five distinct values in the entire table**, so every page boundary
  falls inside a tie group and the offset path becomes the only path — rows get skipped and repeated
  during an ordinary walk.

Sorting by `name` or a timestamp is a migration and an index away. Sorting by status requires the
composite-cursor subclass described below first. Offering the first and quietly omitting the second
would have been the worst option: a control that works on four columns and silently corrupts
pagination on the fifth.

**No N+1.** `current_status` is a column, so listing jobs touches one table. History is fetched
only when a row is expanded.

**Known limits, not hidden.** Deleting a row inside a `created_at` tie group can still skip a row
during a paginated walk: DRF's cursor is built from `ordering[0]` alone and pages ties with an
integer offset, so the `id` tiebreaker never reaches the cursor itself. Collisions require two
inserts in the same microsecond. The fix, if it ever mattered, is a `CursorPagination` subclass
encoding a composite position.

**Described but not built** — honestly out of scope for a few-hour build: read replicas, a
caching layer, `JobStatus` partitioned by time, approximate counts from `pg_class.reltuples`.

## Why "showing 25 of 1,204" is not in the footer

The footer reports what is loaded, never a total, and that is a consequence of cursor pagination
rather than an oversight — a total means `COUNT(*)` on the hot path, which is the second of the two
reasons cursor pagination was chosen at all.

A total *can* be had cheaply, but only while filtering stays categorical. With per-status counters
maintained in `record_status()`, the total for any status selection is arithmetic over five rows —
no count, no scan. That design is written up under
[counts by status](#counts-by-status--designed-deliberately-not-built).

That stopped being available the moment search shipped. No counter can answer "how many names match
`%combustor%`"; that needs a real `COUNT(*)` over a trigram match, on every keystroke, on the hot path.
The escapes are a capped count ("25 of 1000+") or an approximation from `pg_class.reltuples`, and both are
less honest than the number the footer shows now.

So this is a decision search *made*, not one taken alongside it. The two pull against each other and
search is the more useful half: a total tells you how much you did not look at, while search gets you to
the row you wanted. Given one, the footer reporting what is loaded is the truthful option.

## Counts by status — designed, deliberately not built

A dashboard wants a total and a per-status breakdown. The obvious implementation is the one this
design specifically rules out: `SELECT current_status, COUNT(*) … GROUP BY current_status` on
every page load is a scan of the whole table for a number that changes by one at a time, on the
hot path, exactly like the `COUNT(*)` that cursor pagination exists to avoid.

The answer is to **maintain the counts on write instead of deriving them on read**, and the
architecture already has the one thing that makes it cheap: `services.record_status()` is the
sole writer of the projection, so the counter moves inside the transaction that is already open
and already holds the job's row lock.

| Path | Effect on the counters |
|---|---|
| `create_job()` | `PENDING` +1 |
| `record_status()`, when the projection advances | old −1, new +1 |
| delete | current −1 |
| `seed_jobs` | tallies each batch it builds and applies one update per batch |
| `seed_jobs --clear` | resets to zero |

Note the seed row. It bypasses `record_status()` by design — 250k jobs cannot be a quarter of a
million round trips — so the naive version of this feature drifts every time the database is
seeded. It tallies instead, which costs about four lines and keeps the counts exact on every path
the application actually uses.

Two things would still be true, and both are the interesting part of the conversation rather than
the code:

- **Drift is possible, just not from the app.** Raw SQL or a shell session that writes around the
  services can desynchronize the counters. Production wants a periodic reconciler recomputing from
  the projection and reporting the delta — cheap to write, and its output is a genuine health
  signal, since a non-zero delta means something is writing outside the service layer.
- **One row per status is a hot row.** Every concurrent transition into `RUNNING` serializes on
  the same counter row. Fine here, a real bottleneck at write volume; the standard fix is a
  sharded counter — *N* rows per status, summed on read — trading a slightly more expensive read
  for contention that scales.

The same reconciler answers a second question this design leaves open: **orphaned `JobStatus`
rows.** The cascade is Django's ORM collector rather than an `ON DELETE CASCADE` constraint, which
is sufficient while every write goes through the ORM but leaves nothing at the database level to
prevent orphans if a delete fails partway. A sweeper reaping status rows whose job no longer
exists covers it, and is the same shape of job.

Left out because the assignment is a few hours and this is a systems-design discussion, not a
requirement — but the design is settled rather than hand-waved, which is why it is written down
here.

---

