# Job Management Dashboard

A dashboard for viewing, creating and managing computational jobs. Django + PostgreSQL behind a
React/TypeScript frontend, containerized, with a Playwright end-to-end suite.

> **Status: in progress.** The backend is complete and cold-verified; the UI is being built.
> See [What's built](#whats-built).

---

## Quick start

Requires only `make`, `docker`, `docker compose` and `bash`. Every image comes from DockerHub.

```bash
make test    # build, start the stack, run the Playwright E2E suite
make up      # start the stack and print the URLs
make clean   # remove containers, volumes and locally built images
```

`make up` prints where everything is:

| | |
|---|---|
| App | <http://localhost:8080> |
| API | <http://localhost:8000/api/health/> |
| Database | `postgresql://jobs:jobs@127.0.0.1:55432/jobs` (also `make db-url`) |

Postgres is published on **55432**, not 5432, because a development machine very often already
has a local Postgres on the default port. Override with `POSTGRES_HOST_PORT` if 55432 is taken.

<details>
<summary>All commands</summary>

| Command | What it does |
|---|---|
| `make build` | Build all Docker images |
| `make up` | Start the stack and wait until healthy |
| `make test` | **The gate.** Build, start, run the Playwright E2E suite |
| `make test-spec SPEC=03-update-job-api` | Run one spec against the running stack |
| `make test-backend` | Backend unit tests (pytest-django) |
| `make test-all` | Backend unit tests and the E2E suite |
| `make seed N=250000` | Seed jobs with realistic status histories |
| `make db-url` / `make psql` | Connection string / a psql shell |
| `make logs` / `make ps` / `make shell` | Tail logs / service status / Django shell |
| `make stop` / `make down` / `make clean` | Stop / remove containers / full reset |
| `make time` | Print the project time log |

</details>

### A note on ports

`make test` **publishes no host ports at all**. The Playwright container reaches the app over the
compose network, so the gate needs none — and a port already in use on the grader's machine
therefore cannot fail the build. Host ports live in `docker-compose.dev.yml`, which `make up`
overlays for humans.

---

## What's built

Work is sliced so each piece is independently shippable and independently green. Each slice ships
with the spec that proves it; full matrix in [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md).

| # | Slice | Spec | |
|---|---|---|---|
| 0 | Walking skeleton — compose, Makefile, `/api/health/` | `00-smoke` | ✅ |
| 1 | Models, indexes, cursor-paginated list | `01-jobs-list-api` | ✅ |
| 1.5 | UI mockup — design & test-plan sign-off | — | ✅ |
| 2 | `POST` + automatic PENDING | `02-create-job-api` | ✅ |
| 3 | `PATCH` + the state machine | `03-update-job-api` | ✅ |
| 4 | `DELETE` + cascade, status history | `04-delete-job-api` | ✅ |
| 5 | UI: job list, badges, loading/empty/error, status filter | `05-job-list-ui` | ✅ |
| 6 | UI: create form + validation | `06-create-job-ui` | ✅ |
| 7 | ⭐ UI: status update — the critical flow | `07-update-status-ui` | ✅ |
| 8 | UI: delete + in-app confirm, and the `client.ts` failure branches | `08-delete-job-ui` | ✅ |
| 9 | Scale: pagination and filter at 250k rows | `09-pagination-scale` | ✅ |
| 10 | Fault-injection pass | `10-fault-injection` | ⏳ |
| 11 | README, writeups, final cold gate | full suite | ⏳ |

Currently green: **96 E2E specs, 43 backend unit tests.**

---

## Architecture

```mermaid
flowchart LR
    user(["<b>Browser</b><br/>localhost:8080"])

    subgraph runtime["docker compose — the running application"]
        direction LR
        fe["<b>frontend</b><br/>nginx:alpine<br/>serves the Vite build<br/>+ reverse-proxies /api"]
        be["<b>backend</b><br/>gunicorn + Django + DRF"]
        db[("<b>db</b><br/>postgres:16-alpine")]
    end

    subgraph testing["profile 'test' — started only by make test, then exits"]
        e2e["<b>e2e</b> — Playwright runner<br/>node:22-bookworm + Chromium"]
    end

    user --> fe
    fe -->|"/api/* proxy"| be
    be -->|"psycopg"| db
    e2e -.->|"UI + API specs, same origin"| fe
```

nginx serves the built frontend **and** proxies `/api` to Django, so the browser and the tests
see a single origin — no CORS configuration anywhere, and no API base URL baked in at build time.

The Playwright suite is packaged as a compose service behind a `test` profile. `make up` never
starts it; `make test` builds it, runs it once against the live stack, and it exits with the
suite's status code. That is what makes `make test` self-contained.

### Data model

`JobStatus` is an **append-only event log** and the source of truth. `Job.current_status` and
`Job.current_status_at` are a **projection** of that log, written only by
`services.record_status()` inside the same transaction as the event.

```mermaid
erDiagram
    JOB ||--o{ JOB_STATUS : "has many (cascade)"
    JOB {
        bigint   id PK
        varchar  name
        datetime created_at
        datetime updated_at
        varchar  current_status "PROJECTION"
        datetime current_status_at "timestamp of the event behind it"
    }
    JOB_STATUS {
        bigint   id PK
        bigint   job_id FK
        varchar  status_type "PENDING | RUNNING | COMPLETED | FAILED | CANCELLED"
        datetime timestamp "server-stamped"
    }
```

The projection exists for one query in particular: `?status=RUNNING`. Deriving status on read is
perfectly normalized and fine for an unfiltered page, but *filtering* by it would make Postgres
compute the latest status for every job in the table before applying the predicate — a full scan
no index can help with.

### Status transitions

Enforced by `jobs/transitions.py` and mirrored in the UI, so an illegal move is *unreachable*
rather than merely rejected.

```
PENDING   → RUNNING, FAILED, CANCELLED
RUNNING   → COMPLETED, FAILED, CANCELLED
COMPLETED → ∅                          terminal: the work succeeded
FAILED    → ∅  + Re-run → PENDING      terminal, retryable
CANCELLED → ∅  + Re-run → PENDING      terminal, retryable
```

You retry work that did not finish. Re-running something that *succeeded* is a new job, not a
retry — so `COMPLETED` is a genuine dead end.

**Cancelling is not deleting.** Delete removes the record and cascades the log away; cancel stops
the work and keeps both. A cancelled job still consumed compute time, and that is exactly the
history worth auditing.

---

## API

| | |
|---|---|
| `GET /api/jobs/` | List, newest first, cursor-paginated. `?status=` (repeatable, OR-ed) is applied server-side across the whole table |
| `POST /api/jobs/` | Create. The job and its initial `PENDING` status are written in one transaction |
| `GET /api/jobs/<id>/` | Retrieve |
| `PATCH /api/jobs/<id>/` | Rename and/or change status. `status` is a write-only instruction to append to the log |
| `DELETE /api/jobs/<id>/` | Delete, cascading to the status log |
| `GET /api/jobs/<id>/statuses/` | The status history, newest first, cursor-paginated |
| `GET /api/health/` | Liveness + database readiness |

Every 4xx and 5xx uses one shape, so the frontend has a single parsing path:

```json
{ "detail": "human-readable summary", "errors": { "name": ["This field may not be blank."] } }
```

Jobs also carry `allowed_transitions` and `can_retry`, so the UI can disable illegal options
without re-implementing the state machine in TypeScript.

---

## Performance considerations

The brief asks what happens with **millions of jobs in the database**. The working assumption:
the dataset is large, a single user's viewport is not. Nobody scrolls a million rows. So the
engineering problem is making every query cost proportional to the **page**, not the **table**.

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

### Measured, not asserted

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

**Search by name: designed, deliberately not built.** It was scoped out — the assignment does not ask
for it, and it is not a text box. `name ILIKE '%combustor%'` **cannot use a btree index**: a leading
wildcard forces a sequential scan, which is precisely the query shape that falls over at the scale this
section is about. Doing it honestly means a `pg_trgm` extension migration and a GIN trigram index
(`pg_trgm` ships with the `postgres:16` image, so it is a migration rather than a deployment
prerequisite) — and even then, a highly unselective term still has to sort a large candidate set, so
trigram makes substring search viable rather than free. An unindexed version would have contradicted the
performance claim it was meant to support, so the analysis is here and the feature is not.

**No N+1.** `current_status` is a column, so listing jobs touches one table. History is fetched
only when a row is expanded.

**Known limits, not hidden.** Deleting a row inside a `created_at` tie group can still skip a row
during a paginated walk: DRF's cursor is built from `ordering[0]` alone and pages ties with an
integer offset, so the `id` tiebreaker never reaches the cursor itself. Collisions require two
inserts in the same microsecond. The fix, if it ever mattered, is a `CursorPagination` subclass
encoding a composite position.

**Described but not built** — honestly out of scope for a few-hour build: read replicas, a
caching layer, `JobStatus` partitioned by time, approximate counts from `pg_class.reltuples`.

### Counts by status — designed, deliberately not built

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

## Testing

`make test` runs the **Playwright E2E suite and nothing else**, which is exactly what the brief
specifies. Backend unit tests run separately under `make test-backend`, deliberately outside the
gate — folding them in would let an unrelated unit failure block everything.

Backend-only slices are still tested through Playwright's `request` fixture rather than a second
framework, so there is one runner and one `make test` from slice 0 onward.

Three validation tiers:

| Tier | Command | When |
|---|---|---|
| **T1** | `make test-spec SPEC=…` — one spec, no rebuild | while iterating |
| **T2** | `make test` — the full suite | at the close of every slice |
| **T3** | `make clean && make build && make test` from pruned Docker, an amd64 build check, then eyeball the database | slices 0, 4, 7, 11 and any change to the build surface |

T1→T2 is a scope axis. **T2→T3 is not** — they run identical assertions. What changes is the
starting state, so T3 validates the build and provision path rather than the application: files
that exist only in a stale image layer, migrations that assume an already-migrated database,
dependencies resolving from a warm cache. That class of defect passes warm and fails cold.

E2E runs against a real Postgres, so no spec assumes an empty database. Each namespaces its
fixtures with a run-unique prefix, which is what makes the suite re-runnable without `make clean`.

### Failure paths are tested per slice, not deferred to one pass

Error handling is part of each slice's definition of done, so the specs that prove it ship with the
feature rather than in a single sweep at the end: the create form's 500 lives in `06`, the optimistic
rollback and its 404 case in `07`, the list's error banner and recovery in `05`. Faults are injected
with Playwright's `page.route()` — no fault-injection library, no test-only code path in the app.

A final **fault-injection pass** (`10-fault-injection`) runs after the scale slice rather than before
it, so it covers the pagination surfaces in the same pass. It is verification only and ships no
runtime code — worth saying explicitly, because the *sweeper* described under
[counts by status](#counts-by-status--designed-deliberately-not-built) is a different thing entirely: a
scheduled production reconciler, designed and deliberately not built.

If the pass has to be cut for time, the per-slice failure specs still stand on their own; what is lost
is the systematic per-verb coverage, not the error handling itself.

---

## Design decisions

Recorded with their reasoning in [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) — what was
asked, what was decided, and what was assumed without asking. A few worth surfacing:

- **The projection guard compares against `current_status_at`, never `updated_at`.** Any save
  bumps `updated_at` — including a rename — so guarding on it would let renaming a job silently
  discard a later status event.
- **Sequential bigint ids, kept for readability.** "Job 3284917 is stuck" is usable in a support
  ticket; a UUID is not. The trade-off is enumerability, which matters once auth exists — and the
  answer then is UUIDv7, not v4.
- **Status is stored as text, not an int or a native Postgres `ENUM`.** Readable in psql, in
  logs, and on the wire; adding `CANCELLED` was a genuine no-op migration.
- **No authentication, no multi-tenancy.** The brief never introduces a user concept.

Design and planning docs: [`SPEC.md`](docs/SPEC.md) · [`PLAN.md`](docs/PLAN.md) ·
[`TEST_PLAN.md`](docs/TEST_PLAN.md) · [`OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) ·
[UI mockup](docs/mockup/dashboard-mockup.html)

---

## Project layout

```
backend/jobs/          the application
  models.py            Job, JobStatus, StatusType, indexes
  services.py          the only writer of the projection
  transitions.py       the state machine
  serializers.py       API shapes and validation
  views.py             the ViewSet — thin by design
  pagination.py        cursor pagination
  exceptions.py        one error shape for the whole API
  tests/               backend unit tests
frontend/src/          React + TypeScript
  api/                 typed client — the only place that talks to the network
  components/          JobList, JobRow, StatusBadge, StatusTimeline, ErrorBanner
e2e/tests/             Playwright specs, one per slice
docs/                  spec, plan, test plan, open questions, UI mockup
```

---

## AI usage & prompt engineering

<!-- TODO(nina) -->

---

## Time spent

<!-- TODO(nina): final figure from `make time` at slice 11. Currently 1h 19m logged. -->

Tracked as work happened rather than reconstructed afterwards — `scripts/timelog.sh` records each
session and `make time` renders the ledger to [`docs/TIME_LOG.md`](docs/TIME_LOG.md).
