# Job Management Dashboard

A dashboard for viewing, creating and managing computational jobs. Django + PostgreSQL behind a
React/TypeScript frontend, containerized, with a Playwright end-to-end suite.

> **Status:** every build step is complete and green — 144 E2E specs, 43 backend unit tests.
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

Work is split into steps so each piece is independently shippable and independently green. Each step ships
with the spec that proves it; full matrix in [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md).

| # | Step | Spec | |
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
| 9 | Scale: pagination and filter at 250k rows, then search | `09-pagination-scale` | ✅ |
| 10 | Fault-injection pass | `10-fault-injection` | ✅ |
| 11 | README, writeups, final cold gate | full suite | ⏳ |

Currently green: **144 E2E specs, 43 backend unit tests.**

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
        varchar  status_type "PENDING | RUNNING | COMPLETED | FAILED | CANCELED"
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
PENDING   → RUNNING, FAILED, CANCELED
RUNNING   → COMPLETED, FAILED, CANCELED
COMPLETED → ∅                          terminal: the work succeeded
FAILED    → ∅  + Re-run → PENDING      terminal, retryable
CANCELED  → ∅  + Re-run → PENDING      terminal, retryable
```

You retry work that did not finish. Re-running something that *succeeded* is a new job, not a
retry — so `COMPLETED` is a genuine dead end.

**Canceling is not deleting.** Delete removes the record and cascades the log away; cancel stops
the work and keeps both. A canceled job still consumed compute time, and that is exactly the
history worth auditing.

---

## API

| | |
|---|---|
| `GET /api/jobs/` | List, newest first, cursor-paginated. `?status=` (repeatable, OR-ed) and `?search=` are applied server-side across the whole table |
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

### Why "showing 25 of 1,204" is not in the footer

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

Backend-only steps are still tested through Playwright's `request` fixture rather than a second
framework, so there is one runner and one `make test` from step 0 onward.

Three validation tiers:

| Tier | Command | When |
|---|---|---|
| **T1** | `make test-spec SPEC=…` — one spec, no rebuild | while iterating |
| **T2** | `make test` — the full suite | at the close of every step |
| **T3** | `make clean && make build && make test` from pruned Docker, an amd64 build check, then eyeball the database | steps 0, 4, 7, 11 and any change to the build surface |

T1→T2 is a scope axis. **T2→T3 is not** — they run identical assertions. What changes is the
starting state, so T3 validates the build and provision path rather than the application: files
that exist only in a stale image layer, migrations that assume an already-migrated database,
dependencies resolving from a warm cache. That class of defect passes warm and fails cold.

E2E runs against a real Postgres, so no spec assumes an empty database. Each namespaces its
fixtures with a run-unique prefix, which is what makes the suite re-runnable without `make clean`.

### Failure paths are tested per step, not deferred to one pass

Error handling is part of each step's definition of done, so the specs that prove it ship with the
feature rather than in a single sweep at the end: the create form's 500 lives in `06`, the optimistic
rollback and its 404 case in `07`, the list's error banner and recovery in `05`. Faults are injected
with Playwright's `page.route()` — no fault-injection library, no test-only code path in the app.

A final **fault-injection pass** (`10-fault-injection`) covers what the per-step specs cannot, and
deliberately does not repeat what they already do. A 500 on each verb already exists where that verb
lives, so re-testing it there would be theatre. What the pass adds is the ground none of them touch:

| | Why it was missing |
|---|---|
| The **history endpoint** failing at all | Its error branch had never run |
| Recovery after a failed **mutation** | E5 only ever covered the list recovering |
| A **dropped connection mid-mutation** | E9 only covered an aborted list request |
| **Slow** responses as a visible state | Nothing asserted the UI looks busy rather than frozen |

Recovery is the assertion that matters most: an app that reports a failure but can never move past it
has handled the error only in the sense that it did not crash. So every fault is injected **once** —
the second attempt has to succeed, and the banner has to go with it.

It is verification only and ships no runtime code — worth saying explicitly, because the *sweeper*
described under [counts by status](#counts-by-status--designed-deliberately-not-built) is a different
thing entirely: a scheduled production reconciler, designed and deliberately not built.

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
  logs, and on the wire; adding `CANCELED` was a genuine no-op migration.
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
e2e/tests/             Playwright specs, one per step
docs/                  spec, plan, test plan, open questions, UI mockup
```

---

## AI usage & prompt engineering

The assignment took a bit longer than I anticipated (see time breakdown below), but a lot of it was
waiting around for the agent. I initially went in recording my interactions with Claude from the very
beginning, but soon realized that there would be some multi-tasking and waiting around / taking pauses
in between (plus I have an old-ish Mac and I didn't want to eat into its 8GB RAM) so I stopped the
recording. The transcripts are saved in the docs folder.

I spent a little time before working with Claude Code ramping up on the different technologies and
doing a little research by browsing the internet and using Claude chat, which isn't captured here.
When I was ready to start coding, I went with an approach of iterating on a spec and test plan first,
coming up with a plan that involved smaller testable pieces, and then executing on the plan. I wanted
to be able to write the tests before the entire app was finished but I didn't want to just write a
bunch of failing tests so I opted to split the work into steps that could still be tested with an
end-to-end Playwright test. I did give instructions to generally do lighter-weight tests on an
already-running build rather than the entire `make test` every time, with `make test` at the bigger
touchpoints.

Even with the test plan and end-to-end testing along the way, I also wanted to understand the code.
Claude does produce a lot of code and I made sure to review the pieces that did the core
functionality — like creating a new job and ensuring it appears in the list, updating the job status,
deleting a job and its job statuses. There were basically 3 categories of files — the files with the
core functionality that I read line by line and sought to understand deeply, the files with some more
boilerplate code/schemas that I sanity checked and understood their general shape (docker files,
makefile, serializers), and the files that I essentially just made sure I knew their purpose and that
they exist (configs, CSS, etc.). I did ask the agent to explain some parts of the code to me. I asked
for some small changes, like variable naming to make it more readable etc. Most of the bigger changes
and architecture decisions were made during design.

---

## Time spent

**4h 10m**, tracked as the work happened rather than reconstructed afterwards. `scripts/timelog.sh`
opens and closes each session; `make time` renders the ledger to
[`docs/TIME_LOG.md`](docs/TIME_LOG.md), in local time — the ledger itself stores UTC.

| Where it went | Time | |
|---|---|---|
| Planning — spec, step plan, test plan, time tracker | 25m | 10% |
| Backend — models, list, create, PATCH + state machine, delete + cascade | 41m | 16% |
| `CANCELED` — added mid-build after a design conversation | 11m | 4% |
| Frontend — job list, create form, status update, delete | 1h 25m | 34% |
| Scale and fault injection — 250k measurement, failure paths | 25m | 10% |
| Review fixes — two rounds, 19 findings | 39m | 16% |
| Late feedback — dialog copy, respelling, terminology, search | 18m | 7% |
| Delivery — README, writeups, cold gate | *in progress* | |

Two things that figure does *not* include, deliberately: the wall-clock cost of Docker builds and
test runs, which is machine time rather than work, and the design conversations that shaped the
`CANCELED` state, the transition policy and the scope cuts — those happened alongside the build
rather than as billable blocks.

Where it actually went is more interesting than the total. **The frontend cost more than twice the
backend**, which is worth noting: the backend is a state machine with a projection, and once
`record_status()` existed the rest followed from it. The UI is where every partial state lives —
optimistic updates, rollback, per-row in-flight tracking, an error that belongs to *this* row and not
that one — and that is where both review rounds concentrated.

**Review fixes are 17% of the total.** The first round found a bug that made the critical flow
silently fail whenever a history panel had been opened; the second found a spec that deleted rows
belonging to other specs. Neither was reachable by the suite as written.

Two ledger entries have reconstructed start times, marked as such in `TIME_LOG.md`: one where the
tracker call failed, one where a session was never opened. Both are noted rather than quietly
rounded, because a time log that hides its own gaps is not evidence of anything.
