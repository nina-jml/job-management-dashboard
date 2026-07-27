# Backend — Django + DRF

A JSON API over two tables. No auth, no sessions, no admin, no templates: the
middleware stack is trimmed to what a JSON API actually needs (see
[OPEN_QUESTIONS A1](../docs/OPEN_QUESTIONS.md)).

Runs under gunicorn on `:8000`, reached by the browser only through nginx's
`/api` proxy — so there is a single origin, no CORS anywhere, and no base URL
baked in at build time.

---

## The one idea worth understanding first

`JobStatus` is an **append-only event log** — "at time T, this job was observed
in state S". Nothing updates or deletes a status row; a status *change* is a new
row.

`Job.current_status` and `Job.current_status_at` are a **projection** of that
log. They exist so `?status=RUNNING` can be an indexed column read instead of a
per-row subquery over the log, which at scale is a full scan no index can help.

Everything below follows from that split. The log is the truth; the projection is
a cache with exactly one writer.

```
POST /api/jobs/          create_job()          → Job + first PENDING event, one transaction
PATCH /api/jobs/<id>/    apply_status_change() → checks the state machine
                              └─ record_status() → appends the event, advances the projection
```

---

## Files

| File | What lives there |
|---|---|
| `jobs/models.py` | `Job`, `JobStatus`, `StatusType`, and the composite indexes. Read the `Meta.indexes` comments — each index exists for one named query |
| `jobs/services.py` | **The only writer of the projection.** `record_status()`, `apply_status_change()`, `create_job()` |
| `jobs/transitions.py` | The state machine: `ALLOWED`, `RETRYABLE`, and the errors they raise. No other module decides what is legal |
| `jobs/views.py` | `JobViewSet` — thin. Composed from explicit DRF mixins, plus the `?status=` / `?search=` filtering and the `statuses` history action |
| `jobs/serializers.py` | Wire shapes and validation. `status` is a **write-only instruction**, not a field |
| `jobs/pagination.py` | Cursor pagination for jobs and for history, and the 400-not-404 fix for a malformed cursor |
| `jobs/exceptions.py` | One handler giving every 4xx/5xx the same `{detail, errors}` shape |
| `jobs/management/commands/seed_jobs.py` | Bulk seeding for scale work. Deliberately bypasses `record_status()` — see below |
| `config/settings.py` | Settings. Small on purpose |
| `entrypoint.sh` | Waits for Postgres, applies migrations, starts gunicorn |

### Tests

`jobs/tests/` runs under `make test-backend` — **deliberately outside the
`make test` gate**, so a backend unit failure cannot block the evaluation
([OPEN_QUESTIONS Q6](../docs/OPEN_QUESTIONS.md)). 43 tests.

They cover what the E2E suite structurally cannot distinguish: `test_delete.py`
proves no orphan `JobStatus` rows survive a cascade, which looks identical from
the API to a cascade that worked. `test_transitions.py` is the state machine's
truth table.

---

## Things that will look odd without the reason

**`services.record_status()` takes the row lock, and takes it twice.**
`apply_status_change()` locks before reading the status it validates against, or
two concurrent requests could both validate against a stale value.
`record_status()` then locks again — free within the same transaction, and it
keeps `record_status()` correct when called on its own, which `create_job()` does.

**The projection guard compares `current_status_at`, never `updated_at`.** Any
save bumps `updated_at`, including a rename — so guarding on it would let renaming
a job silently discard a later status event. There is a regression test for
exactly that.

**The event is appended unconditionally; only the projection is conditional.**
That is what makes the write safe to replay, and what keeps the log authoritative
if the projection ever has to be rebuilt.

**`JobViewSet` is composed from explicit mixins** rather than `ModelViewSet`, so
each verb arrived with the step whose spec covered it. An untested endpoint was
never reachable.

**Filtering is scoped to the list action.** `get_object()` reads the same
queryset, so an unscoped filter turns into an existence predicate: `/api/jobs/5/?status=RUNNING`
would 404 a job that plainly exists. Found in review.

**The trigram index is on `UPPER(name::text)`, not `name`.** Django compiles
`icontains` to `UPPER(name::text) LIKE UPPER(…)`, and an index on the bare column
cannot serve a predicate whose left side is a function call — it would exist, cost
writes, and leave the search a sequential scan. Also found in review; see
`migrations/0004_search_trgm.py`.

**`seed_jobs` bypasses `record_status()` on purpose.** 250k jobs cannot be a
quarter of a million round trips, so it `bulk_create`s and computes the projection
in Python. Safe because nothing is concurrent there and the guard has nothing to
guard against.

---

## Migrations

| | |
|---|---|
| `0001_initial` | The two tables and their indexes |
| `0002_…status_type` | Added `CANCELED` — a no-op at the column level, because `choices` is Django metadata |
| `0003_canceled_spelling` | Respelled `CANCELLED` → `CANCELED`, **including the data**. Reversible |
| `0004_search_trgm` | `pg_trgm` + the GIN trigram index for search |

`0002` and `0003` together are the whole trade-off of string enums: adding a state
is free, renaming one costs a data migration.

---

## Running it

```bash
make test-backend                     # the 43 unit tests
make shell                            # Django shell
make psql                             # psql against the running database
make seed N=250000                    # bulk data for scale work
docker compose exec backend python manage.py <anything>
```

The image is the artifact — source is **not** bind-mounted, unlike the e2e specs.
A code change needs `--build` to take effect, which is also why `makemigrations`
inside the container cannot write back to the host.
