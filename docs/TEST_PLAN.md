# Test Plan

**Status: ✅ signed off 2026-07-25** by Nina, together with the UI mockup and design. Reviewed against a
working harness, the models and list endpoint, and a clickable mockup rather than in the abstract.
Slices 2–11 build against this plan.

Related: [SPEC.md](./SPEC.md) · [PLAN.md](./PLAN.md) · [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)

---

## Slices at a glance

Every slice ships with the spec that proves it. Case IDs refer to §3; validation tiers to §2.
Slice detail lives in [PLAN.md](./PLAN.md).

| # | Slice | Spec file | Positive cases | Negative cases | Tier | Status |
|---|---|---|---|---|---|---|
| 0 | Walking skeleton: compose, Dockerfiles, Makefile, `/api/health/`, React shell | `00-smoke` | A1, A2, A4–A6 | — | T3 | ✅ done |
| 1 | Models, indexes, cursor-paginated `GET /api/jobs/`, error handler, seed command | `01-jobs-list-api` | E1, E2 | E7, E8 | T2 | ✅ done |
| **1.5** | 🔍 **UI mockup — design & test-plan sign-off.** Every UI state on one page, no backend | — | — | — | review gate | ✅ **signed off** |
| 2 | `POST /api/jobs/` + automatic PENDING, atomic, name validation | `02-create-job-api` | B1, B6, B7 | B2, B3, B4 | T2 | ✅ done |
| 3 | `PATCH` appends event, projection guard, `select_for_update`, transition policy | `03-update-job-api` | C1, C5, C6, C10, C11, C14–C16 | C3, C4, C7, C8, C13, C17 | T2 | ✅ done |
| 4 | `DELETE` + cascade, `GET /api/jobs/<id>/statuses/` | `04-delete-job-api` | D1, D2, D3 | D4 | **T3** | ✅ done |
| 5 | UI: list, badges, typed client, `ErrorBanner`, loading/empty states | `05-job-list-ui` | E1, E3, E6 | — † | T2 | pending |
| 6 | UI: create form + client-side validation | `06-create-job-ui` | B1 | B2, B3 | T2 | pending |
| 7 | ⭐ UI: status update — **the prompt's required critical flow** | `07-update-status-ui` | C1, C2, C12 | C9 | **T3** | pending |
| 8 | UI: delete (in-app confirm, never `window.confirm`) | `08-delete-job-ui` | D1, D6 | D5 | T2 | pending |
| 9 | Fault-injection sweep: 500 per verb, abort, slow, rollback, recovery | `09-fault-injection` | — ‡ | B5, C9, D5, E4, E5 | T2 | pending |
| 10 | Scale: load-more, status filter, debounced search, 250k seeded | `10-pagination-scale` | F1–F4, F6–F10 | F5 | T2 | pending |
| 11 | README, performance + prompt-engineering writeups, final tidy | full suite | A1–A4 | — | **T3 ×2** | pending |

† Slice 5 builds the error-handling machinery (`ApiError`, `ErrorBanner`, query error states); the failure
paths it enables are exercised systematically in slice 9. ‡ Slice 9 is negative by construction — its one
positive assertion is recovery (E5: the error clears and a retry succeeds once the fault is removed).

Slices 0–4 deliver a complete, demonstrable backend before any UI exists; slice 1.5 is the single gate
where both the design and this plan are signed off, reviewed while 2–4 continue. If time runs short the fallback is a smaller UI, never a
broken `make test`.

**Coverage as of slice 4 (backend complete, plus the CANCELLED state):** 57 E2E specs and 43 backend
unit tests passing; T3 cold
gate green from pruned Docker, suite re-runnable without `make clean`, and all three images build on
`linux/amd64`. Cases A1–A4, B1–B4, B6, B7, C1–C8, C10, C11, C13–C17, D1–D4 covered; the rest are UI-facing.

---

## 1. Strategy

**One runner: Playwright.** Backend-only slices are tested through Playwright's `request` fixture
(`APIRequestContext`) rather than a second framework, so there is a single `make test` from slice 0 onward
and no divergence between "the tests I run" and "the tests the evaluator runs".

`pytest-django` covers backend units — the projection guard, serializer validation, cascade behaviour — but
runs under `make test-backend`, deliberately outside the `make test` gate (see OPEN_QUESTIONS Q6).

**Error handling is tested throughout, not at the end.** Handling is built into each slice's definition of
done; the fault-injection sweep (slice 9) then systematically proves it holds. Negative cases appear in
every functional group below, not clustered in one.

**Isolation.** E2E runs against a real Postgres, so no spec may assume an empty database. Every spec
namespaces fixtures with a run-unique prefix (`e2e-<uuid>-…`), scopes assertions to those rows, and cleans
up after itself. The suite must pass twice in a row without `make clean` (case A3).

---

## 2. Validation tiers

| Tier | Command | Cost | When |
|---|---|---|---|
| **T1 — lightweight** | `make test-spec SPEC=03-update-job-api` — one spec against the already-running stack, no rebuild. Plus `make test-backend` during backend slices. | seconds | after every meaningful change, inside a slice |
| **T2 — suite** | `make test` — rebuild + full Playwright suite | ~1–2 min | at the close of **every** slice; catches cross-slice regressions |
| **T3 — cold gate** | `make clean && make build && make test` from pruned Docker; a `--platform linux/amd64` build; then `make up` and eyeball the database through a GUI client on the URL it prints | several min | slices **0, 4, 7, 11**, and any slice touching Docker, compose, the Makefile, or dependencies |

T1→T2 is a **scope** axis: one spec versus the whole suite. T2→T3 is **not** — they run identical
assertions. What changes is the starting state, so T3 validates the *build and provision path* rather than
the application: files that live only in a stale image layer, migrations that assume an already-migrated
database, dependencies resolving from a warm cache. That class of defect passes warm and fails cold, which
is exactly the failure the evaluator's one-shot `make test` would surface.

---

## 3. Case matrix

`+` positive · `−` negative. **48 cases, 17 negative.** Each ID maps to an assertion in the named spec file.

### A · Infrastructure gate — `00-smoke` + manual

Positive-only by nature: these assert the harness itself works. A failure here is not a bug in a feature,
it is the evaluation not starting.

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| A1 | + | `make clean && make test` on pruned Docker | full suite passes | the evaluator's exact path |
| A2 | + | Stack startup | tests wait for `/api/health/` | no race with Postgres init |
| A3 | + | Re-run suite without `clean` | passes again | isolation holds; no leftover-state dependency |
| A4 | + | Build `--platform linux/amd64` | succeeds | prompt targets "modern Linux or Mac" |
| A5 | + | `make up`, then connect a GUI client to the printed URL | tables and rows visible | a manual sanity check that the data matches what the API reports. Part of T3 |
| A6 | + | `make test` with 8080, 8000 and 55432 all occupied | still passes | the gate publishes no host ports, so it cannot fail on a port collision on the grader's machine |

### B · Create job — `02-create-job-api`, `06-create-job-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| B1 | + | Submit valid name | 201; `current_status=PENDING`; `current_status_at` set | row appears at top **without refresh**; log has exactly 1 entry; input clears |
| B2 | − | Submit empty name | inline validation message | **zero network requests fired**; no row created |
| B3 | − | Submit `"   "` | rejected as blank (trimmed) | as B2 |
| B4 | − | Name > 200 chars | rejected, message visible | no row created; API returns 400 when forced directly |
| B5 | − | POST returns 500 | error banner shown | **typed name preserved**; no phantom row after reload |
| B6 | + | Unicode / emoji / quotes / `<script>` in name | persists verbatim | renders escaped — no injection, no mangling |
| B7 | + | Two jobs, identical names | both created | independently addressable; no uniqueness constraint |

### C · Update status — `03-update-job-api`, `07-update-status-ui`

Transitions are enforced against the map in `jobs/transitions.py` (OPEN_QUESTIONS Q7 and Q10):
`PENDING → {RUNNING, FAILED, CANCELLED}`, `RUNNING → {COMPLETED, FAILED, CANCELLED}`, and `COMPLETED`,
`FAILED` and `CANCELLED` are all terminal. **Re-run** is the only way out of a terminal state, and only
from `FAILED` or `CANCELLED` — the two that describe work which did not finish. `COMPLETED` is a genuine
dead end.

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| C1 | + | PENDING → RUNNING | allowed; badge updates immediately | **persists across reload**; log has 2 entries, `PENDING` still present; **`current_status_at` and `updated_at` both advance** |
| C2 | + | Full lifecycle reaches all four states | PENDING → RUNNING → FAILED, then Re-run → PENDING → RUNNING → COMPLETED | every state is reachable, none by accident; the log records all six steps in order and ends terminal |
| C3 | − | COMPLETED → RUNNING | **400** | terminal states cannot be edited; log unchanged, projection unchanged |
| C4 | − | PENDING → COMPLETED (skipping RUNNING) | **400** | the map allows `PENDING → {RUNNING, FAILED}` only; a job cannot finish without having run |
| C5 | + | Re-run a **failed** job | 200; status becomes `PENDING` | appends a `PENDING` event — the earlier `FAILED` entry survives, since the log is append-only; timestamps advance |
| C6 | + | Same status re-applied (double-submit / retry race) | **200, idempotent no-op** | no event appended; `current_status_at` unchanged; explicitly **not** a 400, so a double click is harmless |
| C7 | − | `status: "NOT_A_STATUS"` | 400 | log unchanged; projection unchanged |
| C8 | − | PATCH nonexistent id | 404 | no side effects |
| C9 | − | PATCH returns 500 | **optimistic badge rolls back** to prior value | error shown; log unchanged after reload |
| C10 | + | Rename only, no `status` key | name changes | **no status event appended**; **`updated_at` advances but `current_status_at` does not** — the exact divergence the projection guard depends on |
| C11 | + | Two concurrent PATCHes | serialized by the row lock | both outcomes are individually legal under the map; no lost update; log and projection agree |
| C12 | + | UI: controls offered per state | `FAILED`/`CANCELLED` → **Re-run**; `COMPLETED` → delete only; `RUNNING` → select with `COMPLETED`/`FAILED`/`CANCELLED` enabled and the rest disabled | invalid transitions are *unreachable*, not merely rejected; driven by the API's `allowed_transitions`, never a second copy of the map in TypeScript |
| C13 | − | Re-run a **completed** job | **400** | done is done; a re-run of a success is a new job, not a resurrection. The UI never offers the action |
| C14 | + | Cancel a **queued** job | 200; status becomes `CANCELLED` | terminal, but `can_retry` is true — the work never finished |
| C15 | + | Cancel a **running** job | 200; status becomes `CANCELLED` | the main use case: stop work in flight |
| C16 | + | Re-run a **cancelled** job | 200; back to `PENDING` | the `CANCELLED` entry survives in the log — cancelling is not deleting, and the job's compute time stays on the record |
| C17 | − | Cancel a **completed** or **failed** job | **400** | nothing left to stop; a cancellation must not rewrite why a job ended |

**On timestamps.** `updated_at` and `current_status_at` are asserted separately throughout this group
because they are *meant* to diverge: any save moves `updated_at`, but only a status event moves
`current_status_at`. C10 pins that down — and it is precisely why `record_status()` guards on
`current_status_at`. Guarding on `updated_at` would let a rename make a later legitimate status event look
stale and be silently dropped.

**Why C3 and C4 are negative cases now.** An earlier draft shipped a permissive policy, where the
equivalent of C3 asserted that a backwards transition was *allowed*. Enforcing the map turns those into
rejections, and adds C12 — because a rule the UI still offers is a worse experience than no rule at all.

### D · Delete — `04-delete-job-api`, `08-delete-job-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| D1 | + | Delete a job | 204; the row disappears | two separate claims: **(a)** the row leaves the list with no manual refresh — the "UI updates dynamically" requirement; **(b)** after a full page reload it is *still* absent, and `GET /api/jobs/<id>/` → 404 — proving the delete reached the server rather than only the client cache |
| D2 | + | Cascade — history unreachable | `GET /api/jobs/<id>/statuses/` → 404 | proves the history is gone **through the API**. See the note below on what this does *not* prove |
| D3 | + | Cascade — no orphan rows (backend unit) | `JobStatus.objects.filter(job_id=<deleted>)` is empty | the real cascade assertion; runs under `make test-backend` |
| D4 | − | Delete nonexistent id | 404 | no side effects |
| D5 | − | DELETE returns 500 | **row restored in UI** | error shown; job still present after reload |
| D6 | + | Delete while another row's timeline is expanded | unrelated rows unaffected | expanded state preserved |

**Why D2 alone is not enough.** The `…/statuses/` route is nested under the job, so it 404s on the *parent*
lookup. A job whose status rows were orphaned rather than deleted would return a byte-identical 404 —
the E2E assertion cannot tell the two apart. Detecting orphans requires querying `JobStatus` by a `job_id`
that no longer resolves, which needs direct database access; hence D3 as a backend unit test. Related: the
cascade is enforced by Django's ORM collector, **not** by an `ON DELETE CASCADE` clause on the Postgres
constraint (see SPEC.md §2).

### E · List & read — `01-jobs-list-api`, `05-job-list-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| E1 | + | Load dashboard | each job shows name + current status | matches API payload exactly |
| E2 | + | Ordering | newest first | stable across reloads (total ordering via `id` tiebreaker) |
| E3 | + | No jobs match | empty state renders | not a spinner, not a blank page |
| E4 | − | GET returns 500 | error message visible | **no blank screen**; app still interactive |
| E5 | − | Backend unreachable (route abort) | error message visible | **retry after recovery succeeds and clears the error** |
| E6 | + | Expand history timeline | events chronological | matches the sequence of changes made in-test |
| E7 | − | Unknown job id | 404 | body uses the standard `{detail, errors}` shape |
| E8 | − | `page_size` above the cap | clamped to 100 | a client cannot ask for the whole table |

### F · Pagination & scale — `10-pagination-scale`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| F1 | + | First render, N ≫ page size | exactly one page requested | network log: 1 list request, 25 rows |
| F2 | + | Load more | next page appended | **no duplicate ids, no skipped ids** across the full walk |
| F3 | + | Filter by status | list narrows | **server-side request issued** — not a client-side filter |
| F10 | + | Search a term whose only match is far outside the first page | the match is returned | **the assertion that proves search is whole-table, not page-local.** Seed 250k, search a name known to live ~page 400, expect one result. A client-side filter returns nothing here |
| F4 | + | Type a search burst | debounced | requests ≪ keystrokes |
| F5 | − | Tampered / invalid cursor | 400 | graceful UI error, no crash |
| F6 | + | Job created mid-pagination | walk stays consistent | no dupes/skips from the shifting head |
| F7 | + | 250k rows seeded | page latency ≈ flat vs 100 rows | measured; the number goes in the README |
| F8 | + | **Delete rows already returned**, mid-walk — including the exact row the cursor encodes | remaining pages unaffected | no skipped and no duplicated ids across the full walk. The cursor holds a *value*, not a position, so removing rows behind it changes nothing — this is the case where `OFFSET` pagination would silently skip one row per deletion |
| F9 | + | **Delete a row on a page not yet fetched** | that row is simply absent | no *other* row skipped or duplicated; the walk completes normally |

**Why deletion is the sharper pagination test.** Creating a row mid-walk (F6) shifts the head of the list,
which keyset pagination is immune to by construction. Deleting rows *behind* the cursor is the case that
breaks offset pagination outright — every deletion shifts the window and a row is skipped at each
subsequent boundary. F8 is therefore the case that demonstrates the choice of cursor pagination was
load-bearing rather than stylistic. See §5 for the one situation where our implementation is still
vulnerable.

---

## 4. Requirement traceability

Every **functional** requirement maps to at least one positive and one negative case. The infrastructure
gate (group A) is positive-only by nature — there is no meaningful "negative" for "the build works".

| Prompt requirement | Positive | Negative |
|---|---|---|
| `GET /api/jobs/` includes current status | E1, E2 | E4, E7 |
| `POST /api/jobs/` auto-creates PENDING | B1 | B2, B3, B4, B5 |
| `PATCH` creates a new JobStatus entry | C1, C5, C10, C11, C14–C16 | C3, C4, C7, C8, C9, C13, C17 |
| `DELETE` cascades to JobStatus | D1, D2, D3 | D4, D5 |
| Frontend lists jobs with status | E1, E3 | E4 |
| Create form | B1, B6, B7 | B2, B3 |
| Status update control | C1, C2, C5, C12, C14–C16 | C3, C4, C9, C13, C17 |
| Delete button | D1, D6 | D5 |
| API error handling | E5 (recovery) | B5, C9, D5, E4, F5 |
| Client-side validation | B1 | B2, B3, B4 |
| UI updates dynamically | B1, C1, D1 | C9, D5 (rollback) |
| **Required E2E critical flow** | **C1** (create → PENDING → RUNNING) | C9 |
| Performance at scale | F1–F4, F6–F10 | F5, E8 |
| `make test` from clean | A1–A6 | — |

---

## 5. Known gaps

Stated rather than hidden — each is a deliberate scope call, not an oversight.

- **Deletion inside a `created_at` tie group can still skip a row.** Verified against DRF 3.15.2: the
  cursor predicate is built from `self.ordering[0]` alone (`created_at`), and rows sharing that value are
  paged with an integer `offset`. Our `-id` tiebreaker makes the SQL `ORDER BY` total — which is what
  guarantees deterministic ordering — but it never reaches the cursor. So if two jobs share a `created_at`
  to the microsecond and one is deleted between page fetches, the offset lands one row further along and a
  row is skipped. F8 and F9 cover the dominant non-tie case; this residual is documented rather than
  fixed, because `created_at` is microsecond-precision `auto_now_add` and collisions require two inserts
  in the same microsecond. The real fix is a `CursorPagination` subclass encoding a composite
  `(created_at, id)` position — noted in the README as the hardening step.
- **No load/soak testing.** F7 measures single-request latency against a seeded 250k-row table; it is not a
  concurrency benchmark.
- **C11 (concurrency) is a two-in-flight check, not a stress test.** It proves the row lock serializes
  writers; it does not characterize behaviour under sustained contention.
- **Single browser (Chromium).** Cross-browser adds CI time for little signal on a prototype.
- **No accessibility audit.** Semantic HTML and labelled controls are used throughout, but there is no
  automated a11y assertion.
- **No visual regression testing.** Out of proportion for a few-hour build.

---

## Sign-off

| | |
|---|---|
| Author | Claude (agent) |
| Reviewer | Nina |
| Date | 2026-07-25 |
| Decision | ☑ **approved** — test plan, UI mockup and design all signed off together at slice 1.5 |
