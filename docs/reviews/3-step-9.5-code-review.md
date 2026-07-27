# Code review — steps 10.6 and 9.5 (dialog copy, CANCELED respelling, rename, search)

**Scope:** commits `1062911` (delete dialog copy, `CANCELED` respelling, slice→step rename) and
`42227be` (search: `pg_trgm`, `?search=`, debounce, 4 specs).

**Outcome: 8 findings, 8 fixed.** Gate green at 144 E2E + 43 unit, zero flaky.

This was the most valuable of the three reviews, because finding 1 was a **shipped defect with a
false claim published about it in a graded deliverable**. Not a style issue and not hypothetical.

---

## 1. The trigram index could not serve the query — HIGH — FIXED

`backend/jobs/views.py`, `backend/jobs/migrations/0004_search_trgm.py`

Django compiles `name__icontains` to `UPPER("jobs_job"."name"::text) LIKE UPPER(%…%)` on PostgreSQL.
Verified directly:

```
WHERE UPPER("jobs_job"."name"::text) LIKE UPPER(%combustor%)
```

A `gin_trgm_ops` index on the bare `name` column cannot serve a predicate whose left side is a
function call. So the migration paid full GIN write amplification on every insert and every rename
while contributing **nothing** to the read path, and search at 250k rows was exactly the sequential
scan the index existed to prevent.

**Why it got through:** the verification measured hand-written `ILIKE` in `psql`. That query *does*
use an index on the bare column. The application's query never could. The index existed, `EXPLAIN`
looked right, and none of it applied to the code path that runs.

**Fix:** index `UPPER(name::text)`. Written as raw DDL rather than
`GinIndex(OpClass(Upper("name"), name="gin_trgm_ops"))`, because that renders the operator class
*inside* the expression parentheses — `USING gin ((UPPER("name") gin_trgm_ops))` — which Postgres
rejects with a syntax error. Found while fixing this; the model Meta now carries a comment saying so.

**Re-verified** with `QuerySet.explain(analyze=True)` on the ORM's own query:

```
Bitmap Index Scan on job_name_trgm_idx
  Index Cond: (upper((name)::text) ~~ '%COMBUSTION OPTIMIZATION #1234%'::text)
```

## 2. The README reported a plan the shipped query cannot produce — MEDIUM — FIXED

Direct consequence of 1. Every number in the benchmark table was measured on the wrong query.
Re-measured through the ORM at 250k rows:

| Term | Indexed | Index disabled | Was published as |
|---|---|---|---|
| 1 match | 30.6 ms | 116.5 ms | 39.7 ms / 171.2 ms |
| ~18k matches | 0.304 ms | 138.6 ms | 0.42 ms / 163.2 ms |

The qualitative story survived — different index per selectivity, both beating the scan — but that
was luck, not verification. The README now states the *method* (`QuerySet.explain()`, not
hand-written SQL), because the method is what failed.

## 3. "All" chip un-pressed in a state it could not clear — MEDIUM — FIXED

`frontend/src/App.tsx`. `aria-pressed={!isFiltered}` began including `search`, while `onClick` still
only cleared statuses. Typing a search term flipped All to un-pressed — advertising "click me to
clear" — and clicking did nothing. Now tracks `statuses.length === 0`, which is what it controls.

## 4. Untrimmed search in the query key — MEDIUM — FIXED

`frontend/src/hooks/useJobs.ts`. `jobKeys.list` spread `filters` raw while `query()` trimmed, so
`""`, `"   "` and `"combustor "` were three cache keys producing byte-identical URLs. Concretely:
load three pages, type one space, and the whole list is replaced by skeletons while page 1 is
refetched for a response already cached. Now trimmed before it reaches the key.

## 5. Empty-state copy named a control the user may not be using — LOW — FIXED

Told anyone with any narrowing active to "clear the search", including someone filtering by status
with an empty box. Now branches on which narrowings are actually in effect.

## 6. The signed-off mockup contradicted the shipped dialog — LOW — FIXED

`docs/mockup/dashboard-mockup.html` still showed `Cancel` / `Delete job`, lacked the new question,
and — worst — showed the "cancel it instead" hint on a **FAILED** job, the exact case the new guard
suppresses. Updated, and it now shows both variants side by side, since the conditional is the point.
`frontend/src/index.css`'s header claim about matching the reviewed design is honest again.

## 7. The debounce test sat on its own boundary — LOW — FIXED

Typed 9 characters at 30ms (~270ms, inside one 300ms window) and asserted `< 9`. It only separated
debounced from not-debounced while the whole burst fit in a window. Now 20 characters over ~800ms
asserting `<= 3`, and it waits on an actual search response rather than on rows that already existed.

## 8. Stale enum spelling in a doc comment — LOW — FIXED

`frontend/src/api/types.ts` said "FAILED and CANCELLED", naming a value that no longer exists, in the
file whose header promises drift is a compile error.

---

## A mistake made while fixing these

The fix for a flaky delete-recovery test introduced a deterministic failure. I asserted
`getByRole("button", { name: /^Delete$/ })`, but that button's accessible name comes from
`aria-label="Delete <job name>"`, so an exact match never resolves. It failed 3/3 against a healthy
button.

**Same shape as finding 1**: verifying against what I assumed the system emits rather than what it
emits. Once on SQL, once on an accessible name. Both caught only by running it.

The underlying flake was real. After a failed delete the rollback restores the row *before*
`useDeleteJob`'s awaited invalidation refetches, so the second attempt could act on a node about to
be detached. It now waits for the Delete button to be enabled — the observable signal that
`deletingIds` has cleared. 30/30 across repeats.

## Verified independently by the reviewer

- Migration `0003` moved live data correctly; no `CANCELLED` rows in either table; both directions
  reverse.
- TEST_PLAN counts accurate: 61 cases, 21 negative, 144 specs.
- `09-pagination-scale` 13/13 — search was functionally correct throughout, just unindexed.
