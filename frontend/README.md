# Frontend — React + TypeScript

Vite build, served by nginx, which also reverse-proxies `/api` to Django. One
origin, so there is no CORS configuration anywhere and no API base URL baked in
at build time — the same image runs in any environment.

State is TanStack Query. There is no Redux, no context, and no global store:
server data lives in the query cache, and the handful of things that are genuinely
local (which chip is selected, what is typed, which dialog is open) live in
`useState` in `App.tsx`.

---

## Four layers, strictly one-directional

```
api/client.ts       →  the only place that calls fetch()
api/jobs.ts         →  endpoints as typed functions
hooks/              →  query keys, caching, optimistic writes
components/         →  render only; never touch the network
```

Nothing below reaches up. A component cannot make a request without going through
the layer above it, which is what keeps error handling in one place.

---

## Files

| File | What lives there |
|---|---|
| `api/client.ts` | The `fetch` wrapper and `ApiError`. **Every** failure — offline, HTTP error, unparseable body — arrives at the UI as one type with a message worth showing a person |
| `api/jobs.ts` | The endpoint surface, and the query-string builder for `?status=` / `?search=` |
| `api/types.ts` | `Job`, `Page<T>`, `StatusType`, and the display labels. Mirrors the DRF serializers so drift is a compile error |
| `hooks/useJobs.ts` | Query keys and the infinite list. **Read the key comments** — key structure is what makes filtering hit the server rather than the loaded page |
| `hooks/useJobMutations.ts` | Create, status change, delete. The optimistic writes and their rollbacks. The most interesting file here |
| `hooks/useDebounced.ts` | Trails a value so typing is one query, not one per keystroke |
| `App.tsx` | Composition root: filter state, search input, dialog state, and which errors go to the page banner versus beside an input |
| `components/JobList.tsx` | Loading / empty / error states, and the expanded-history state |
| `components/JobRow.tsx` | One row: badge, status editor, re-run, delete, history toggle |
| `components/ConfirmDeleteDialog.tsx` | In-app confirmation. Focus trap, Escape, focus restore |
| `components/CreateJobForm.tsx` | Client-side validation that blocks the request before it is sent |
| `components/StatusTimeline.tsx` | The status log for one row, paged |
| `components/ErrorBanner.tsx` | Retry versus dismiss |
| `components/StatusBadge.tsx` | The coloured pill |
| `lib/format.ts` | Timestamps (local, with zone) and zero-padded ids |
| `index.css` | All styling. No CSS-in-JS, no framework. Ported from the signed-off mockup |
| `nginx.conf` | Static serving, SPA fallback, `/api` proxy |

---

## Where to start reading

**`api/client.ts`** first. The design claim is that every failure mode becomes one
`ApiError`: offline becomes status 0, a proxy's HTML error page becomes a readable
sentence, and DRF's `{detail, errors}` becomes `.fields` so a message can sit next
to the input that caused it. If that abstraction leaks, everything above gets more
complicated.

**`hooks/useJobMutations.ts`** second — the most interesting logic in the app, and
where two rounds of review concentrated.

---

## Things that will look odd without the reason

**Status changes deliberately do not use `useMutation`.** One `useMutation`
observer reports a single aggregate state and holds a single set of per-call
callbacks, so a second change would take the "saving…" hint from the first and
discard its error. Two rows in flight have to be two independent pieces of state,
which closures give and one observer cannot. `useStatusChange()` keeps per-id
state instead.

**The optimistic write moves `current_status` and nothing else.** It does *not*
guess `allowed_transitions` or `can_retry` — those are the server's answer, and
computing them client-side would be a second copy of the state machine. Instead
the row stays busy until the reconciling refetch lands, so the stale pair is never
actionable.

**Optimistic writes target `jobKeys.lists`, never `jobKeys.all`.** `all` also
matches the history queries, whose cached value is a plain page with no `pages`
array. Reaching one throws inside the updater — and because that runs *before* the
request, a throw means the mutation never fires while the badge still moves. That
was a real bug; there is a spec for it now.

**A 404 does not roll back.** Restoring the snapshot would put back a row the
server says is gone. The refetch reconciles instead, and the message says "this job
no longer exists" rather than the ORM's "No Job matches the given query."

**Search is trimmed before it reaches the query key.** `""`, `"   "` and
`"combustor "` produce identical URLs; leaving them distinct gave each its own
cache entry, so typing one space discarded the loaded list and refetched page 1.

**No `window.confirm`, ever.** A native dialog blocks the event loop, so Playwright
stops receiving commands and the suite *hangs* rather than fails. There is a spec
asserting no native dialog is ever opened.

**No virtualization.** Server cost is flat, but DOM cost grows with rows *loaded* —
and loading is an explicit 25-row click, not infinite scroll. Reasoning and the
threshold that would change it are in the [root README](../README.md#performance-considerations).

---

## Running it

```bash
make up                               # whole stack, app on :8080
make test-spec SPEC=05-job-list-ui    # one Playwright spec, no rebuild
cd frontend && npx tsc --noEmit       # typecheck without Docker
```

The image is the artifact — `src/` is **not** bind-mounted, so a change needs
`--build` to appear. Playwright specs *are* mounted, which is what makes
`make test-spec` a seconds-long check.
