# Test Plan

**Status: awaiting sign-off.** Slice 0 (the containerized test pipeline) ships first so this plan is
reviewed against a working harness rather than in the abstract. Feature work starts after sign-off.

Related: [SPEC.md](./SPEC.md) · [PLAN.md](./PLAN.md) · [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)

---

## Slices at a glance

Every slice ships with the spec that proves it. Case IDs refer to §3; validation tiers to §2.
Slice detail lives in [PLAN.md](./PLAN.md).

| # | Slice | Spec file | Cases | Tier | Status |
|---|---|---|---|---|---|
| 0 | Walking skeleton: compose, Dockerfiles, Makefile, `/api/health/`, React shell | `00-smoke` | F1, F2, F4 | T3 | ✅ done |
| 1 | Models, indexes, cursor-paginated `GET /api/jobs/`, error handler, seed command | `01-jobs-list-api` | D1, D2 | T2 | ✅ done |
| — | **Test plan sign-off** | — | — | — | ⏳ **awaiting review** |
| 2 | `POST /api/jobs/` + automatic PENDING, atomic, name validation | `02-create-job-api` | A1–A4, A6, A7 | T2 | pending |
| 3 | `PATCH` appends event, projection guard, `select_for_update` | `03-update-job-api` | B1, B3–B6, B8, B9 | T2 | pending |
| 4 | `DELETE` + cascade, `GET /api/jobs/<id>/statuses/` | `04-delete-job-api` | C1, C2, C3 | **T3** | pending |
| 5 | UI: list, badges, typed client, `ErrorBanner`, loading/empty states | `05-job-list-ui` | D1, D3, D6 | T2 | pending |
| 6 | UI: create form + client-side validation | `06-create-job-ui` | A1, A2, A3 | T2 | pending |
| 7 | ⭐ UI: status update — **the prompt's required critical flow** + optimistic rollback | `07-update-status-ui` | B1, B2, B7 | **T3** | pending |
| 8 | UI: delete (in-app confirm, never `window.confirm`) | `08-delete-job-ui` | C1, C4, C5 | T2 | pending |
| 9 | Fault-injection sweep: 500 per verb, abort, slow, rollback, recovery | `09-fault-injection` | A5, B7, C4, D4, D5 | T2 | pending |
| 10 | Scale: load-more, status filter, debounced search, 250k seeded | `10-pagination-scale` | E1–E7 | T2 | pending |
| 11 | README, performance + prompt-engineering writeups, final tidy | full suite | all | **T3 ×2** | pending |

Slices 0–4 deliver a complete, demonstrable backend before any UI exists — if time runs short the fallback
is a smaller UI, never a broken `make test`. Slice 9 verifies error handling rather than introducing it;
the handling itself is built into slices 1–8 (see §1).

**Coverage as of slice 1:** 12 E2E specs and 14 backend unit tests passing; infrastructure gate F1–F4 green.

---

## 1. Strategy

**One runner: Playwright.** Backend-only slices are tested through Playwright's `request` fixture
(`APIRequestContext`) rather than a second framework, so there is a single `make test` from slice 0 onward
and no divergence between "the tests I run" and "the tests the evaluator runs".

`pytest-django` covers backend units — the projection guard, serializer validation, cascade behaviour — but
runs under `make test-backend`, deliberately outside the `make test` gate (see OPEN_QUESTIONS Q6).

**Error handling is tested throughout, not at the end.** Handling is built into each slice's definition of
done; the fault-injection sweep (slice 9) then systematically proves it holds. Negative cases appear in
every group below, not clustered in one.

**Isolation.** E2E runs against a real Postgres, so no spec may assume an empty database. Every spec
namespaces fixtures with a run-unique prefix (`e2e-<uuid>-…`), scopes assertions to those rows, and cleans
up after itself. The suite must pass twice in a row without `make clean` (case F3).

---

## 2. Validation tiers

| Tier | Command | Cost | When |
|---|---|---|---|
| **T1 — lightweight** | `make test-spec SPEC=03-update-job-api` — one spec against the already-running stack, no rebuild. Plus `make test-backend` during backend slices. | seconds | after every meaningful change, inside a slice |
| **T2 — suite** | `make test` — rebuild + full Playwright suite | ~1–2 min | at the close of **every** slice; catches cross-slice regressions |
| **T3 — cold gate** | `make clean && make build && make test` from pruned Docker, plus a `--platform linux/amd64` build | several min | slices **0, 4, 7, 11**, and any slice touching Docker, compose, the Makefile, or a dependency |

T3 is the evaluator's exact path. It's slow, so it runs at the four points where a cold-build regression
would be most expensive to discover late — and unconditionally whenever the build surface itself changes,
since that's the class of change that passes warm and fails cold.

---

## 3. Case matrix

`+` positive · `−` negative. 34 cases, 15 negative. Each ID maps to an assertion in the named spec file.

### A · Create job — `02-create-job-api`, `06-create-job-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| A1 | + | Submit valid name | 201; `current_status=PENDING`; `current_status_at` set | row appears at top **without refresh**; log has exactly 1 entry; input clears |
| A2 | − | Submit empty name | inline validation message | **zero network requests fired**; no row created |
| A3 | − | Submit `"   "` | rejected as blank (trimmed) | as A2 |
| A4 | − | Name > 200 chars | rejected, message visible | no row created; API returns 400 when forced directly |
| A5 | − | POST returns 500 | error banner shown | **typed name preserved**; no phantom row after reload |
| A6 | + | Unicode / emoji / quotes / `<script>` in name | persists verbatim | renders escaped — no injection, no mangling |
| A7 | + | Two jobs, identical names | both created | independently addressable; no uniqueness constraint |

### B · Update status — `03-update-job-api`, `07-update-status-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| B1 | + | PENDING → RUNNING | badge updates immediately | **persists across reload**; log has 2 entries, `PENDING` still present |
| B2 | + | Reach all four states | each selectable and persisted | badge label + colour correct per state |
| B3 | + | COMPLETED → RUNNING (backwards) | allowed | asserts the no-state-machine decision (OQ A2); log grows |
| B4 | + | Same status applied twice | new event appended | log grows; `current_status` unchanged; `current_status_at` advances |
| B5 | − | `status: "NOT_A_STATUS"` | 400 | log unchanged; projection unchanged |
| B6 | − | PATCH nonexistent id | 404 | no side effects |
| B7 | − | PATCH returns 500 | **optimistic badge rolls back** to prior value | error shown; log unchanged after reload |
| B8 | + | Rename only, no `status` key | name changes | **no status event appended** — log length unchanged |
| B9 | + | Two concurrent PATCHes | both events logged | `current_status` = the later event; no lost update (row lock holds) |

### C · Delete — `04-delete-job-api`, `08-delete-job-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| C1 | + | Delete a job | 204; row disappears | no refresh needed; **still gone after reload** |
| C2 | + | Cascade | all `JobStatus` rows removed | `GET …/statuses/` → 404; no orphans |
| C3 | − | Delete nonexistent id | 404 | no side effects |
| C4 | − | DELETE returns 500 | **row restored in UI** | error shown; job still present after reload |
| C5 | + | Delete while another row's timeline is expanded | unrelated rows unaffected | expanded state preserved |

### D · List & read — `01-jobs-list-api`, `05-job-list-ui`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| D1 | + | Load dashboard | each job shows name + current status | matches API payload exactly |
| D2 | + | Ordering | newest first | stable across reloads (total ordering via `id` tiebreaker) |
| D3 | + | No jobs match | empty state renders | not a spinner, not a blank page |
| D4 | − | GET returns 500 | error message visible | **no blank screen**; app still interactive |
| D5 | − | Backend unreachable (route abort) | error message visible | **retry after recovery succeeds and clears the error** |
| D6 | + | Expand history timeline | events chronological | matches the sequence of changes made in-test |

### E · Pagination & scale — `10-pagination-scale`

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| E1 | + | First render, N ≫ page size | exactly one page requested | network log: 1 list request, 25 rows |
| E2 | + | Load more | next page appended | **no duplicate ids, no skipped ids** across the full walk |
| E3 | + | Filter by status | list narrows | **server-side request issued** — not a client-side filter |
| E4 | + | Type a search burst | debounced | requests ≪ keystrokes |
| E5 | − | Tampered / invalid cursor | 400 | graceful UI error, no crash |
| E6 | + | Job created mid-pagination | walk stays consistent | no dupes/skips from the shifting head |
| E7 | + | 250k rows seeded | page latency ≈ flat vs 100 rows | measured; the number goes in the README |

### F · Infrastructure gate — `00-smoke` + manual

| ID | ± | Action | Expected behaviour | Validation |
|---|---|---|---|---|
| F1 | + | `make clean && make test` on pruned Docker | full suite passes | the evaluator's exact path |
| F2 | + | Stack startup | tests wait for `/api/health/` | no race with Postgres init |
| F3 | + | Re-run suite without `clean` | passes again | isolation holds; no leftover-state dependency |
| F4 | + | Build `--platform linux/amd64` | succeeds | prompt targets "modern Linux or Mac" |

---

## 4. Requirement traceability

Every requirement in the prompt maps to at least one positive **and** one negative case.

| Prompt requirement | Positive | Negative |
|---|---|---|
| `GET /api/jobs/` includes current status | D1, D2 | D4, D5 |
| `POST /api/jobs/` auto-creates PENDING | A1 | A2, A3, A4, A5 |
| `PATCH` creates a new JobStatus entry | B1, B4, B8 | B5, B6, B7 |
| `DELETE` cascades to JobStatus | C1, C2 | C3, C4 |
| Frontend lists jobs with status | D1, D3 | D4 |
| Create form | A1, A6, A7 | A2, A3 |
| Status update control | B1, B2, B3 | B7 |
| Delete button | C1, C5 | C4 |
| API error handling | D5 (recovery) | A5, B7, C4, D4, E5 |
| Client-side validation | A1 | A2, A3, A4 |
| UI updates dynamically | A1, B1, C1 | B7, C4 (rollback) |
| **Required E2E critical flow** | **B1** (create → PENDING → RUNNING) | B7 |
| Performance at scale | E1–E4, E6, E7 | E5 |
| `make test` from clean | F1, F2, F3, F4 | — |

---

## 5. Known gaps

Stated rather than hidden — each is a deliberate scope call, not an oversight.

- **No load/soak testing.** E7 measures single-request latency against a seeded 250k-row table; it is not a
  concurrency benchmark.
- **B9 (concurrency) is a two-in-flight check, not a stress test.** It proves the row lock serializes
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
| Date | _pending_ |
| Decision | ☐ approved ☐ approved with changes ☐ revise |
