# Code review — slices 8–10

**Scope:** `git diff origin/main...HEAD` at the time — commits `9adb131` (slice 8, delete UI),
`ba65861` (slice 9, pagination scale), `8f2a545` (slice 10, fault injection). 15 files.

**Outcome: 8 findings, 8 fixed**, all in commit `d9d6481`. Gate green at 137 E2E + 43 unit,
no flaky tests.

The two worth remembering are #1 and #6 — neither was a bug in the application. Both were tests
that appeared to pass while proving something other than what they claimed.

---

## 1. F8 deleted rows it did not own — FIXED

`e2e/tests/09-pagination-scale.spec.ts`

`seen` comes from the unfiltered head of the table, so `seen.slice(0, 3)` meant "the three newest
jobs anywhere", not "the three newest of mine". The suite runs `fullyParallel` on two workers, so
any job another spec created between `seedJobs` returning and the first page GET was hard-deleted
underneath it. The `expect([204, 404])` guard passed either way, so F8 stayed green and the damage
surfaced in an unrelated spec.

Violates the isolation rule in CLAUDE.md and TEST_PLAN case A3, and could fail the one-shot gate.

**Fix:** intersect with the test's own fixture ids before deleting; assert a hard 204.

## 2. Unchecked re-fetch could compare NaN to NaN — FIXED

`e2e/tests/09-pagination-scale.spec.ts`

The `Promise.all` over `ids.slice(0, 30)` never checked `response.status()`. A row deleted between
the walk and the re-fetch yields an error body, `created_at` is `undefined`, and the ordering
assertion compares `NaN >= NaN` — failing with a confusing message about ordering rather than an
honest one about a missing row. Compounded by finding 1.

**Fix:** skip 404s explicitly, assert 200 on the rest.

## 3. History cache dropped on failure, contradicting its own comment — FIXED

`frontend/src/hooks/useJobMutations.ts`

`removeQueries(jobKeys.history(id))` sat in `finally`, so a 500 or aborted DELETE also wiped the
history of a job that still existed and whose row had just been restored — remounting an open
timeline for nothing. The comment justified it for success and 404 only.

**Fix:** moved into the success and 404 paths, so the code matches the comment.

## 4. The dialog's busy state was unreachable — FIXED

`frontend/src/App.tsx`, `frontend/src/components/ConfirmDeleteDialog.tsx`

`setPendingDelete(null)` runs before `deleteJob(id)`, so the dialog unmounts in the same tick the id
enters `deletingIds`. `isDeleting` was therefore always `false`: the prop, the `disabled` bindings,
the "Deleting…" label and the `!isDeleting` guards were all dead code.

**Fix:** removed rather than resurrected. The dialog closing immediately is the intended behaviour —
deletion is optimistic, so there is nothing left to confirm — and the spec already asserted it.

## 5. Escape stopped working once focus left the buttons — FIXED

`frontend/src/components/ConfirmDeleteDialog.tsx`

`onKeyDown` was bound to the `.dialog` div, which is not focusable. Clicking the explanatory
paragraph sent focus to `<body>`, after which the keydown no longer bubbled through the dialog and
Escape did nothing. No focus trap either, despite `aria-modal="true"`, and no focus restore on close.

The existing Escape test could not catch it: it presses Escape while Cancel still holds focus.

**Fix:** listener bound to `document` in an effect; Tab containment added so `aria-modal` is honest;
focus restored to the trigger on unmount. Two new specs cover the blur case and Tab containment.

## 6. D5 did not test the rollback it is named for — FIXED

`e2e/tests/08-delete-job-ui.spec.ts`

`useDeleteJob` invalidates the list in `finally`, so the row came back from the server whether or not
the snapshot restore ran. Deleting the rollback left the test green — it was a test of invalidation
wearing rollback's name.

**Fix:** stall the reconciling refetch, then assert the row returns inside that window, where the
only thing that can have restored it is the rollback. **Verified by removing the rollback and
watching D5 fail**, then restoring it.

## 7. Stale spec count in the README — FIXED

Said 96 while the slice table directly above had been updated to mark 8/9/10 done. Now 137.

## 8. TEST_PLAN coverage paragraph half-updated — FIXED

Heading still read "as of slice 7.5" and listed slices 9 and 10 as outstanding, while the status
table ten lines above marked them ✅ done in the same commit.

Worth noting this paragraph has now gone stale **twice** — it was finding #10 of the slice-7 review
too. It is the part of the docs most likely to drift, because it restates in prose what the table
above it already says.

---

## Checked and confirmed clean by the reviewer

- `BadCursorIsBadRequest` MRO and `super()` resolution; DRF only raises `NotFound` from
  `decode_cursor`, and the nested `statuses` action still 404s a missing parent because
  `get_object()` runs first.
- `removeCachedJob` correctly scopes to `jobKeys.lists`, not `all` — avoiding the history-shape
  crash that was finding #1 of the previous review.
- Playwright route globs in specs 08 and 10 do not accidentally intercept the list endpoint.
- `make test` seeds 30 jobs with `--clear`, so spec 09's "Load more" preconditions hold cold.

## Follow-up investigated separately — not a defect

Reported symptom: after re-running a failed job, PENDING did not appear immediately.

**Could not reproduce.** Two probes added to `07-update-status-ui.spec.ts` assert the badge flips
within **200 ms** of the click — one with the PATCH stalled 3s, one with a list refetch also stalled
and in flight. Both pass, so the optimistic write is not queued behind anything.

The likely explanation is the deliberate design from slice-7 review finding #4: the *row* stays busy
until the awaited reconciling refetch lands, so `allowed_transitions` is never acted on while stale.
The badge is immediate, but the "saving…" hint and the disabled control persist for the length of
that refetch — a window that grows with machine speed and table size, and the database held 250k
rows at the time of the observation.

The probes are kept as regression coverage: they pin the property that optimism stays immediate.
