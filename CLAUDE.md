# Working agreements

Rescale EM take-home. Django + Postgres + React/TS job dashboard, containerized,
gated by `make test`. Read `docs/PLAN.md` for the slice order and
`docs/TEST_PLAN.md` for the case matrix before starting work.

## Non-negotiables

- **`make test` must pass on a clean machine** with only make, docker, docker compose
  and bash, and **DockerHub as the only reachable registry**. It also publishes **no
  host ports** — `docker-compose.dev.yml` adds those for `make up` — so the gate
  cannot fail because 8080 happens to be busy on the grader's machine. The graders run it once;
  if it fails they stop evaluating. Never introduce an image from another registry —
  in particular `mcr.microsoft.com/playwright`, which is why the e2e image is built
  from `node:22-bookworm`.
- **Every base image tag is pinned.** Verify `--platform linux/amd64` builds when the
  build surface changes.
- **No untested endpoint is reachable.** `JobViewSet` is composed from explicit DRF
  mixins so each verb ships with the slice whose spec covers it.

## Per-slice loop

Each slice is independently shippable and independently green. In order, every time:

1. Build the slice.
2. **T1** — `make test-spec SPEC=<name>` while iterating (seconds; specs are mounted,
   so no rebuild). `make test-backend` for backend-only work.
3. **T2** — `make test` at the close of every slice.
4. **T3** — `make clean && make build && make test` from pruned Docker, an amd64
   build check, then `make up` and eyeball the database through a GUI client on
   the URL it prints (`make db-url`). Slices **0, 4, 7, 11**, *and* any slice
   touching Docker, compose, the Makefile, or dependencies — that class of change
   passes warm and fails cold.
5. **Log the time**: `./scripts/timelog.sh start "<slice>"` / `stop "<note>"`.
   The README has to report a real figure, so it is logged as work happens, never
   reconstructed at the end.
6. **Commit** — one commit per slice, explaining *why* rather than restating the diff.

Do not start a slice until the previous one's validation passes.

## Review touchpoints

Nina reviews at **larger touchpoints**, not every commit — code review and push happen there; between
them the loop above runs at speed (small tests, quick iterations, a commit per slice).

The touchpoints are the **T3 slices**, which is not a coincidence: they are the points where a coherent
piece of work is finished and cold-verified.

| Touchpoint | What is up for review |
|---|---|
| slice 1.5 | design + test plan ✅ signed off |
| **slice 4** | the whole backend ✅ done — API, state machine, cascade |
| slice 7 | the UI through the required critical flow |
| slice 11 | delivery: README, writeups, final cold gate |

At a touchpoint: make sure T3 is green, summarize what changed since the last one, and **stop** rather
than rolling into the next slice. Between touchpoints, keep moving — do not wait for review to continue.

## Design decisions already settled

Full reasoning in `docs/OPEN_QUESTIONS.md` — do not relitigate these without asking:

- `JobStatus` is an **append-only event log**; `Job.current_status` /
  `current_status_at` are a **projection** written *only* by
  `services.record_status()`, inside the same transaction as the event.
- The projection guard compares against **`current_status_at`, never `updated_at`** —
  any save bumps `updated_at`, so guarding on it would let a rename silently drop a
  later status event.
- **Strict status transitions** (`jobs/transitions.py`):
  `PENDING → {RUNNING, FAILED, CANCELLED}`, `RUNNING → {COMPLETED, FAILED, CANCELLED}`;
  `COMPLETED`, `FAILED` and `CANCELLED` are terminal. **Re-run only from `FAILED` or
  `CANCELLED`** — the two that describe work which did not finish. Same status
  re-applied is an **idempotent 200 no-op**, not a 400.
- **Cancelling is not deleting.** Delete removes the record; cancel keeps it, because a
  cancelled job still consumed compute time and that history is worth auditing.
- **Cursor pagination, never offset.** No `COUNT(*)` on the hot path.
- **Filter and search are server-side across the whole table**, never the loaded page.
- Timestamps are **server-stamped**; the API takes no client timestamp.
- Sequential **bigint ids**, kept for readability.
- nginx serves the build and proxies `/api` — single origin, no CORS.
- `make test` runs **Playwright only**, so a backend unit failure cannot block the gate.

## Conventions

- Comments explain *why*, not *what*. Where a decision has a rationale in `docs/`,
  reference the case or question id (`TEST_PLAN case C8`, `OPEN_QUESTIONS Q7`).
- E2E runs against a real Postgres: **no spec may assume an empty database**. Namespace
  fixtures with `uniquePrefix()` and scope assertions to them, so the suite is
  re-runnable without `make clean`.
- Never use `window.confirm` — a native dialog blocks the event loop and hangs the
  Playwright suite. In-app dialogs only.
- Keep `docs/` in sync when a decision changes; the docs are a deliverable, not notes.
