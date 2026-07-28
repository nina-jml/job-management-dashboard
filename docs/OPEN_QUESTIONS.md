# Open Questions & Assumptions

The prompt leaves a number of things unspecified. This file records what was asked, what was decided, and
what was assumed without asking — so the reasoning is reviewable rather than buried in code.

Status: **all blocking questions resolved 2026-07-25.** Assumptions in §2 are documented, not built for.

---

## 1. Resolved with the assignment owner

### Q1 · "Millions of jobs" — what is actually being asked?

**Decision:** the dataset is large; a single user's viewport is not. Millions of rows live in the database;
no one user scrolls them. The engineering problem is therefore making every query cost proportional to the
**page**, not the **table** — which is a real constraint that shapes indexes, pagination, and the fetch
strategy, without pretending the UI must render a million rows.

Implemented: cursor (keyset) pagination, composite indexes covering the exact `ORDER BY` + `WHERE`,
server-side filter and search, one page fetched at a time, virtualization if rendered rows grow large.

Described in the README but not implemented (honestly out of scope for a few-hour build): read replicas,
a caching layer, `JobStatus` partitioned by time, approximate counts from `pg_class.reltuples`.

See `SPEC.md` §4 for the full analysis, including why `OFFSET` and DRF's default `COUNT(*)`-per-page are
the two things that actually break at this scale.

### Q2 · How is current status derived and stored?

**Decision:** `JobStatus` is an append-only event log and the source of truth. `Job.current_status` /
`Job.current_status_at` are a **denormalized projection** of it, written only by
`jobs/services.py::record_status()`, inside the same transaction as the event.

The deciding factor is `?status=RUNNING`. Deriving status on read (a `Subquery` for the latest status per
job) is perfectly normalized and fine for an unfiltered 25-row page — but to *filter* by status Postgres
must compute the latest status for every job in the table before it can apply the predicate. That's a full
scan over millions of rows and no index can help. The projection turns it into an indexed column read.

**Update guard:**

```python
if new_status.timestamp >= job.current_status_at:
    job.current_status    = new_status.status_type
    job.current_status_at = new_status.timestamp
```

Compared against **`current_status_at`, not `updated_at`**. `updated_at` moves on every save — a rename
bumps it — so guarding on it would let a rename cause a subsequent legitimate status event to be judged
stale and silently dropped. `current_status_at` expresses the invariant we actually want: *the projection
always reflects the newest event the log has seen.*

The log is appended unconditionally; only the projection is conditional. That's what makes the write
idempotent under replay.

### Q3 · Where do status timestamps come from?

**Decision: server-stamped** (`timezone.now()`). The API does not accept a client-supplied timestamp.

Consequence: with server stamping plus the `select_for_update()` row lock, the guard in Q2 is inert today —
events cannot arrive out of order. It ships anyway because it costs one comparison and it is the thing that
makes the design correct the moment status events come from somewhere other than a human clicking a
dropdown: a real scheduler emitting `RUNNING`/`COMPLETED` webhooks, a retried delivery, a backfill.

### Q4 · Is the status history exposed?

**Decision: yes** — `GET /api/jobs/<id>/statuses/` plus an expandable per-row timeline in the UI.

Not required by the prompt, but it's the only way to *demonstrate* rather than merely assert the two claims
the design rests on: that the log is genuinely append-only (the old `PENDING` row survives a status change)
and that `DELETE` cascaded (history 404s afterward). TEST_PLAN cases C1, C4, C8, D2 and E6 depend on it.

### Q5 · How is the frontend served?

**Decision:** Vite production build served by nginx, which also reverse-proxies `/api` to Django.

Single origin for both the browser and Playwright: no CORS configuration, and no API base URL baked in at
build time. The alternative (shipping the Vite dev server) would mean delivering a dev server as the
production artifact.

### Q6 · What does `make test` run?

**Decision:** `make test` runs the Playwright E2E suite and nothing else — exactly what the prompt
specifies. `make test-backend` runs pytest-django; `make test-all` runs both.

The prompt is explicit that a failing `make test` ends the evaluation. Folding backend unit tests into that
one gate would mean an unrelated unit failure blocks everything, for no gain in the thing being gated.

### Q7 · Should status transitions be constrained by a state machine?

**Decision: yes — strict, with an explicit re-run.** `jobs/transitions.py` enforces:

```python
ALLOWED = {
    StatusType.PENDING:   {StatusType.RUNNING, StatusType.FAILED, StatusType.CANCELED},
    StatusType.RUNNING:   {StatusType.COMPLETED, StatusType.FAILED, StatusType.CANCELED},
    StatusType.COMPLETED: set(),   # terminal — done is done
    StatusType.FAILED:    set(),   # terminal, but retryable (below)
    StatusType.CANCELED: set(),   # terminal, but retryable (below)
}

# Re-run is the only way out of a terminal state, and only from the two that
# represent work which did not finish.
RETRYABLE = {StatusType.FAILED, StatusType.CANCELED}
```

A disallowed transition is a `400`, not a silent no-op. The UI never offers one: the dropdown disables
what the map forbids, so invalid transitions are *unreachable* rather than merely rejected.

`COMPLETED → RUNNING` is meaningless in a real scheduler — a job that finished does not un-finish, and a
retry is a new attempt, not a backwards edit of the old one. Modelling that honestly is worth more than the
flexibility of arbitrary edits.

**The escape hatch, and its limit.** A **failed** or **canceled** job offers an explicit **Re-run** action
that moves it to `PENDING` and appends that event to the log. A **completed** job offers nothing — its only
remaining action is delete.

That asymmetry is the point. You retry a failure; you do not re-run a success. Re-running something that
already succeeded is not a retry, it is a *new job* — which is exactly how a user should express it, and
how real schedulers model it (Rescale clones a job rather than resurrecting one).

So every state remains **reachable** — a job's lifecycle can visit all four — but `COMPLETED` is a genuine
dead end rather than a way back round. Re-running a completed job is a `400`, not a hidden button
(TEST_PLAN case C13).

*Superseded:* an earlier draft shipped a permissive policy with the strict map written beside it as
documentation. Enforcing the map is the better call — a rule that is only commentary is not a rule.

### Q8 · What happens when the same status is applied twice?

**Decision: an idempotent no-op.** `PATCH {"status": "RUNNING"}` on a job already `RUNNING` returns `200`
with the unchanged job. No event is appended, `current_status_at` does not move, and it is **not** a `400`.

This follows from Q7. Under strict transitions the map has no self-edges, so a literal reading would reject
a repeat as an invalid transition — which would turn an accidental double-click, or a retried request after
a dropped response, into a visible error for a request that asked for the state the job is already in.
Idempotency is the correct response to a duplicate, not a rejection.

It also reverses an earlier decision. Under the permissive model, `JobStatus` was framed as a log of
*observations*, where "still RUNNING at 10:42" carried information. Under a strict workflow model there are
no observers — only deliberate transitions — so a duplicate entry is timeline noise rather than a data
point. TEST_PLAN case C6.

### Q9 · Sequential integer ids, or UUIDs?

**Decision: sequential `BigAutoField`.** Readability wins here, and it is an operational argument rather
than an aesthetic one: "job 3284917 is stuck" is a usable thing to say in a support ticket, a log line or
across a desk. `018f2c9a-7b3e-7cd1-9f42-6a1b8e5d0c37` is not.

Capacity was never the question — `BigAutoField` reaches 9.2 × 10¹⁸, which is not the binding constraint at
any plausible scale. Sequential ids are also *better* for this design: monotonic inserts append to the
right-hand edge of the btree instead of scattering, and `id` is the tiebreaker that makes the list ordering
total (SPEC §1).

**The trade-off, stated plainly.** Sequential ids are enumerable. With no auth (assumption A1), anyone can
walk `/api/jobs/1, /2, /3`, and the magnitude of an id leaks roughly how many jobs the platform has ever
run — a real business-intelligence leak for a multi-tenant product.

That matters once tenancy and auth exist, not before. If it ever does, the answer is **UUIDv7** rather than
UUIDv4: v7 is time-ordered, so it stays non-enumerable *without* destroying the insert locality and index
size that v4 costs. Noted in the README as the hardening step.

### Q10 · Should there be a CANCELED state?

**Decision: yes.** `CANCELED` is reachable from `PENDING` and `RUNNING` — you can call off work that is
queued as readily as work that is running — and is terminal but **retryable**, exactly like `FAILED`. It
needs no special affordance: it is an ordinary option in the status control.

Not reachable from `COMPLETED` or `FAILED`: there is nothing left to stop, and allowing it would let a
cancellation rewrite *why* a job ended.

**Canceling is not deleting**, and that distinction is the point of the feature:

| | Delete | Cancel |
|---|---|---|
| The record | removed entirely | kept |
| The status log | cascaded away | preserved, with the cancellation appended |
| Answers "did this ever run?" | no — no trace | yes, and for how long |

A canceled job consumed compute time and may have been billed for it. Deleting it erases the evidence;
canceling records the outcome. In a scheduler those are different operations with different meanings, not
two routes to the same end.

**Why retryable.** `COMPLETED` is a dead end because the work succeeded — running it again is a *new* job.
`FAILED` and `CANCELED` both describe work that *did not finish*, so "try that again" is a coherent thing
to ask for. The unit tests encode this as an invariant rather than a list: every retryable state must be
terminal, so there is never more than one way out of a given state.

---

## 2. Assumed without asking — documented in the README, not built

| # | Ambiguity | Assumption | Rationale |
|---|---|---|---|
| A1 | No mention of users or auth | No authentication, no multi-tenancy — one shared job list | The prompt never introduces a user concept. Adding one invents scope. Noted in the README as the natural next step, since it's also where an `owner_id` would need to lead the composite indexes. |
| A2 | Repeat PATCH of the same status | Appends a new event; `current_status` unchanged, timestamps advance | It's a log of *observations*, not a diff. Promoted to a discussed decision — see Q8. TEST_PLAN case C4. |
| A3 | Name uniqueness | Not unique | Nothing suggests it should be, and real job names collide constantly. TEST_PLAN case B7. |
| A4 | Deletion semantics | Hard delete; cascade enforced by Django's ORM collector | The prompt says delete and says associated statuses must go; soft delete would contradict that. The cascade is *not* an `ON DELETE CASCADE` clause on the Postgres constraint — see SPEC.md §2 and TEST_PLAN cases D2/D3. |
| A5 | Timezone handling | Store UTC (`USE_TZ=True`), render in the browser's locale | Standard practice; avoids a whole class of off-by-hours bugs. |
| A6 | Page size | 25 default, `?page_size=` capped at 100 | Uncapped page size is a trivial denial-of-service against your own API. TEST_PLAN case E8. |
| A7 | Job "running" behaviour | None — no scheduler, no execution | Explicitly excluded by the prompt (§6). |

---

## 3. Risks being tracked

| Risk | Mitigation |
|---|---|
| **The standard Playwright image is not on DockerHub.** `mcr.microsoft.com/playwright` is a Microsoft registry; the prompt only guarantees DockerHub access. Using it would fail `make test` on the evaluator's machine — which per the prompt ends the evaluation. | Build the e2e image from `node:22-bookworm` (DockerHub) with `npx playwright install --with-deps chromium`. Verified by TEST_PLAN case A1 on a pruned Docker. |
| Tests racing Postgres initialization — the classic intermittent CI failure. | `GET /api/health/` checks the DB connection; compose healthchecks and `make test` both gate on it. TEST_PLAN case A2. |
| E2E state leaking between runs, making the suite pass once and fail on re-run. | Every spec namespaces its fixtures with a run-unique prefix and scopes assertions to them. TEST_PLAN case A3. |
| Apple Silicon build that doesn't work on the evaluator's amd64 Linux. | Explicit `--platform linux/amd64` build check at steps 0 and 11. TEST_PLAN case A4. |

### Root-owned e2e artifacts on Linux

On Linux, bind mounts pass UIDs through untranslated. The e2e container runs as root, so the
`playwright-report/` and `test-results/` it writes to the bind-mounted working tree are owned by
root — and the invoking user then cannot delete them. macOS hides this: Docker Desktop's file
sharing remaps ownership to the host user. The failure mode that matters is a grader's: `make
test`, then `rm -rf` the checkout to clean up, and the delete stops on "Permission denied".

**What ships.** The reports stay bind-mounted — a failing run's HTML report and traces are worth
having on the host — and `make test` chowns `playwright-report/` and `test-results/` back to the
invoking user after the run, from inside a container (`docker run --rm -v "$(CURDIR)/e2e:/work"
alpine chown …`), so no `sudo` on either platform. The run captures the suite's exit code and
re-exits with it, so the chown never masks a red run. A fresh clone → `make test` → `rm -rf` then
just works, and you keep the report. The chown is a no-op on macOS.

`make test-spec` chowns its output the same way. `make clean` still deletes `playwright-report/`
and `test-results/` from inside a container as a safety net — for a run interrupted (Ctrl-C) before
the chown — again without `sudo`.

**The alternative, not taken.** Run the e2e service as the invoking user from the start —
`user: "${HOST_UID}:${HOST_GID}"`, plus moving the Playwright browser cache off `/root`
(`ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, world-readable) since a non-root user cannot read
`/root/.cache/ms-playwright`. That avoids creating the files root-owned at all, but makes the gate's
success depend on uid-mapping quirks (HOME, cache paths) that vary across hosts. A post-run chown
leaves the container itself unchanged and keeps the gate simple, so it was the safer call.
