# Code review — slice 7 touchpoint

Level **high** · 4 finders · 36 candidates · 36 verified · 3 refuted · 10 reported.

Findings 1–10 are from the automated review, in severity order. Finding 11 came out of
discussion afterwards and is not in the tool's output.

All 11 were spot-checked against the working tree after the review ran — none were
displaced by the slice 5–7 changes that landed in parallel.

---

## 1. `frontend/src/hooks/useJobMutations.ts:49`

**The optimistic `setQueriesData` filter `["jobs"]` also matches the history query cache entries, whose data has no `pages` array, so `cached.pages.map(...)` throws inside `onMutate`.**

A user expands any row's status history (caching `["jobs","history",id]` as a raw `Page<StatusEntry>` = `{next, previous, results}`), then changes any job's status. `onMutate` calls `setQueriesData<JobPages>({queryKey: ["jobs"]}, ...)`; the prefix filter matches the history entry, `cached` is truthy but `cached.pages` is undefined, and the updater throws `TypeError: Cannot read properties of undefined (reading 'map')`. Verified against the installed @tanstack/query-core: a throwing `onMutate` means `mutationFn` is never called, so the PATCH is never sent — and `context` is undefined so no rollback runs. The badge flashes the optimistic status, an ErrorBanner appears reading the generic "Something went wrong.", and after `onSettled` invalidates and refetches the badge snaps back to the old status. The core assignment flow (change a job's status) silently fails for any user who looked at a history panel first. No spec covers expand-history-then-update, so the suite stays green.

<sub>correctness · CONFIRMED</sub>

---

## 2. `backend/jobs/views.py:56`

**`get_queryset` applies the `?status=` list filter to detail routes as well, since `get_object()` reads the same queryset.**

`GET/PATCH/DELETE /api/jobs/5/?status=RUNNING` on a job whose `current_status` is PENDING returns 404 "Not found" rather than acting on job 5, and `/api/jobs/5/statuses/?status=bogus` returns a 400 about an invalid status filter from a history endpoint that has no status filter. A list-scoped filter silently becomes an existence predicate on every detail verb, including the `statuses` action, which calls `self.get_object()`.

<sub>correctness · CONFIRMED</sub>

---

## 3. `frontend/src/components/JobList.tsx:21`

**Loading skeletons reuse the `.row` class inside `.rows`, so `.rows .row` locators in spec 05 can match skeletons instead of real rows.**

In `05-job-list-ui.spec.ts` "matches the API payload exactly (E1)", `await expect(page.locator(".rows .row").first()).toBeVisible()` is satisfied by a `LoadingRows` skeleton (same `.rows` > `.row` markup, no `data-job-id`). If the app is still pending when `evaluateAll` runs, `rendered` is `[{id: NaN, status: null}, ...]` and the comparison against the API results fails. On a cold machine — the exact "passes warm, fails cold" class the project calls out — this fails `make test`, which the graders run once. The same collision makes "renders without console errors" pass without ever having loaded data.

<sub>correctness · CONFIRMED</sub>

---

## 4. `frontend/src/components/JobRow.tsx:27`

**The optimistic update advances `current_status` but deliberately leaves `allowed_transitions`/`can_retry` stale, and `JobRow` derives `isTerminal` and the option `disabled` flags from those stale fields, so the UI keeps offering transitions the server will reject.**

A PENDING job is set to "Cancelled". `onMutate` writes `current_status: "CANCELLED"` into the list cache but leaves `allowed_transitions: ["CANCELLED","FAILED","RUNNING"]` and `can_retry: false`. Between the PATCH resolving (which clears `isSaving`) and the `onSettled` invalidation refetch landing, `isTerminal` is still false and `can_retry` still false, so the row renders an enabled "Edit" button with Running/Failed selectable. Clicking through in that window PATCHes CANCELLED→RUNNING, which the server rejects with 400 "CANCELLED is a terminal state." — an error banner for an action the UI itself offered, contradicting the TEST_PLAN C12 claim that illegal transitions are unreachable rather than merely rejected.

<sub>correctness · CONFIRMED</sub>

---

## 5. `frontend/src/App.tsx:19`

**A single shared `useSetStatus()` instance backs every row, so a second status change discards the first's error state and misattributes the "saving…" hint.**

Click Edit→Running on job A, then Edit→Failed on job B before A's PATCH resolves. `onStatusChange` calls `statusMutation.reset()` and `mutate()`, so the observer now tracks B: `savingJobId` jumps from A to B while A is still in flight, and if A's PATCH then fails the badge silently rolls back with no banner explaining why — the user sees a status change vanish with no error at all.

<sub>cleanup · CONFIRMED</sub>

---

## 6. `frontend/src/App.tsx:88`

**When the job list request fails, `isPending` is false and `jobs` is empty, so `JobList` renders the "No jobs yet" empty state alongside the error banner.**

The list endpoint returns 500 (or the user is offline). App renders the ErrorBanner, then still renders `<JobList jobs={[]} isLoading={isPending} isFiltered={false} />`; in TanStack Query v5 an errored query has `status === "error"`, so `isPending` is false and JobList falls through to the empty branch. The user is told "No jobs yet — Create your first job using the field above", plus a footer reading "0 loaded · no more results" — an affirmative, false claim that their jobs do not exist, when the truth is that the fetch failed. Spec 05's E4 case only asserts the alert and heading are visible, so this is not caught.

<sub>correctness · CONFIRMED</sub>

---

## 7. `frontend/src/components/StatusTimeline.tsx:33`

**`jobsApi.history` fetches a single page at the paginator's `max_page_size` of 200 and the timeline ignores `next`, but renders `entries.length` as the job's total entry count.**

A job polled by a scheduler accumulates 250 JobStatus events. `GET /api/jobs/{id}/statuses/?page_size=200` returns the newest 200 plus a non-null `next`, which `useJobHistory`'s `select` discards. The panel reads "Status history · 200 entries · newest first" with no indication of truncation and no way to page further, so the 50 oldest events — including the original PENDING that demonstrates the log is append-only — are invisible and the displayed count is wrong. This is the one endpoint whose stated purpose is to prove the log is complete.

<sub>correctness · CONFIRMED</sub>

---

## 8. `frontend/src/components/CreateJobForm.tsx:35`

**A server field error on create is read from `createJob.error`, which is only cleared by `createJob.reset()` — and `App` hides the banner (the only thing wired to `reset`) precisely when the error is a field error, so the message can never be dismissed.**

`POST /api/jobs/` returns 400 with `errors: {name: [...]}`. `App`'s `createBannerError` evaluates to null, so no banner (and therefore no Dismiss button calling `createJob.reset()`) is rendered. `CreateJobForm` shows the message under the input. The user edits the field: `onChange` clears only `clientError`, while `serverError` is recomputed from the still-populated `createJob.error`, so the stale message stays visible with `aria-invalid="true"` and the `invalid` styling on a name that is now fine — telling the user their new input is rejected before it has been submitted.

<sub>correctness · CONFIRMED</sub>

---

## 9. `frontend/src/components/CreateJobForm.tsx:25`

**The client-side length check counts UTF-16 code units while Django's `CharField(max_length=200)` counts characters, so names with astral-plane characters are rejected client-side even though the API accepts them.**

`validate()` uses `trimmed.length > 200`, which counts surrogate pairs as two. A job named with, say, 120 emoji (or any name mixing emoji past ~100 characters) is 120 characters to Postgres and Django but >200 to JavaScript, so the form shows "Names are limited to 200 characters." and, per the B4 spec's own contract, fires zero network requests — the user simply cannot create a job the server would have accepted with a 201. The B6 spec proves emoji names are a supported case (`Δp «flow» 🔥 …`), and the B4 spec only exercises `"x".repeat(201)`, where code units and characters coincide, so the divergence is invisible to the suite.

<sub>correctness · CONFIRMED</sub>

---

## 10. `docs/TEST_PLAN.md:43`

**The coverage paragraph was re-headed "as of slice 7" but its case list was left at the slice-4 backend set, and the `†` footnote it dropped from row 5 is now dangling.**

Line 42 now claims "Coverage as of slice 7 (backend + the required critical flow): 87 E2E specs", but line 43 still enumerates only `A1–A4, B1–B4, B6, B7, C1–C8, C10, C11, C13–C17, D1–D4` and ends "the rest are UI-facing" — a sentence that was true at slice 4 and is now false, since E1, E3–E6, B5, C9 and C12 are covered by the three specs added in this diff. Separately, row 5's negative column changed from `— †` to `E4, E5`, but footnote † ("Slice 5 builds the error-handling machinery … exercised systematically in slice 9") survives at line 32 with no referent, and slice 9 still lists E4/E5/B5 as its own cases. A grader reading TEST_PLAN.md — an explicit deliverable — sees a coverage claim that contradicts the table two lines above it and a footnote attached to nothing.

<sub>correctness · CONFIRMED</sub>

---

## 11. `frontend/src/hooks/useJobMutations.ts` — acting on a job deleted elsewhere

**A 404 from a mutation is treated as a generic failure, so `onError` restores the pre-mutation snapshot — putting a row that no longer exists back on screen.**

Two tabs, or one tab plus `make test` (which clears the jobs table before seeding), is enough: change a status on a row that has since been deleted and the sequence is optimistic update → 404 → rollback resurrects the phantom row → an error banner reading the ORM's "No Job matches the given query." → the row finally disappears when `onSettled`'s refetch lands. Note this is not a narrow race: `staleTime: 10_000` means `refetchOnWindowFocus` declines to refetch at all while the data is under ten seconds old, so the stale window is wide and deliberate.

### Required behaviour (decided — implement this, do not re-derive)

**On a 404, do not roll back. Refetch and show the server's current state instead.**

The snapshot is not a safe fallback here. Rolling back restores a row the server says does not
exist, so the recovery is as wrong as the failure — it just looks calmer. The correct response to
"that is gone" is to go and find out what is actually there.

Concretely, in `useSetStatus`:

```ts
onError: (error, _variables, context) => {
  // A 404 means the row is gone, not that our value was wrong. Restoring the
  // snapshot would resurrect it; let onSettled's refetch reconcile instead.
  if (error instanceof ApiError && error.status === 404) return;

  context?.snapshot.forEach(([key, data]) => queryClient.setQueryData<JobPages>(key, data));
}
```

`onSettled` already calls `invalidateQueries`, so skipping the rollback is sufficient — the list
refetches and the row disappears because the server said so, which is the whole point.

Three details that go with it:

1. **The message names the cause.** "This job no longer exists — it was deleted." Not the ORM's
   "No Job matches the given query."
2. **A 404 on delete is success.** The user wanted the row gone and it is gone. Reconcile
   silently; do not show an error for an outcome that matches the intent.
3. **The same rule applies to the history panel.** An expanded timeline whose job was deleted
   should close and drop out of cache, not sit there showing a log for a job that no longer
   exists.

Reachable with two tabs and no fault injection, which makes it a better slice 9 case than another
fabricated 500: delete a job through the API, then act on the stale row in the browser. Assert the
row disappears, the message names the cause, and nothing is resurrected in between.

<sub>correctness · found in review discussion</sub>

---

## Refuted — investigated, not defects

- `frontend/src/api/jobs.ts:21` — The cursor `next` URL is rewritten with a greedy regex (`cursor.replace(/^.*\/api/, "")`) instead of URL parsing; `e2e/tests/helpers.ts` already has the correct `toPath()`.
- `frontend/src/main.tsx:11` — `refetchOnWindowFocus: true` restates TanStack Query's own default value.
- `frontend/src/App.tsx:31` — The "is this a `name` field error?" decision is implemented twice — once in App to suppress the banner, once in CreateJobForm to show it beside the input.

Worth knowing what was checked and dismissed: the greedy cursor regex (no reachable trigger against DRF's URL building), `refetchOnWindowFocus` restating a default, and the field-error check appearing in two components.
---

## Resolution

**All 11 fixed**, in commit `710710b` ("address slice 7 review: eleven findings, and the mutation
lifecycle reworked"). Gate green at 107 E2E + 43 unit at that point.

Findings 1, 4, 5 and 11 turned out to be one defect with four faces — the status-change lifecycle —
and the fix removed `useMutation` from status changes entirely, because a single observer cannot
hold per-row state. The first attempt at fixing #5 used per-call `mutate(vars, { onError })`
callbacks and was wrong in the same way as the bug: TanStack stores one `mutateOptions` per
observer, so the second call overwrote the first's. The test caught it.

Two defects were found while fixing these that the review had not raised:

- Case E5's row claimed "backend unreachable (route abort)" while its spec fulfilled a 500. The
  matrix and the test disagreed, and `route.abort()` was exercised nowhere. Became cases E9/E10,
  shipped in slice 8.
- B6 located its row by the substring `«flow»` rather than its unique prefix, so it collided with
  its own fixtures whenever the suite ran twice without `make clean` — the isolation property case
  A3 promises. `make test` seeds with `--clear`, which is why it never showed.
