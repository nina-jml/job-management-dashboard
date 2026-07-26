# Time Log

Rendered from `docs/time_log.tsv` by `scripts/timelog.sh report` (or `make time`).
Do not edit by hand — edit the ledger instead.

| Date | Start | End | Duration | Work |
|---|---|---|---|---|
| 2026-07-25 | 15:08 | 15:33 | 0h 25m | planning — spec, step plan, test plan, tracker — steps 0 and 1 shipped; cold gate green |
| 2026-07-25 | 16:41 | 16:50 | 0h 09m | steps 2-4 — create, update, delete — step 2 — POST + auto PENDING; 23 e2e, 14 unit green |
| 2026-07-25 | 16:50 | 17:01 | 0h 10m | step 3 — PATCH + transitions — step 3 — PATCH + state machine; 38 e2e, 31 unit green |
| 2026-07-25 | 17:01 | 17:23 | 0h 22m | step 4 — DELETE + cascade + history — step 4 — DELETE + cascade + history; T3 cold gate green |
| 2026-07-25 | 18:48 | 19:00 | 0h 11m | CANCELLED state — CANCELLED state — 57 e2e, 43 unit green |
| 2026-07-25 | 19:37 | 20:02 | 0h 25m | review fixes + db port — step 5 — job list UI; 67 e2e, 43 unit green |
| 2026-07-25 | 20:02 | 20:11 | 0h 08m | step 6 — create form — step 6 — create form; 77 e2e green |
| 2026-07-25 | 20:11 | 20:50 | 0h 39m | step 7 — status update — step 7 — status update; T3 green, 87 e2e + 43 unit |
| 2026-07-25 | 21:12 | 21:37 | 0h 25m | step 7.5 — review fixes — tz on timestamps, multi-select filter, counts deferred to README; 96 e2e + 43 unit green (start reconstructed: timelog start hit a tool error) |
| 2026-07-25 | 23:21 | 23:34 | 0h 13m | step 8 — delete UI + client.ts fault cases — step 8 — delete UI + E9/E10; 116 e2e green, no flakes |
| 2026-07-25 | 23:34 | 23:50 | 0h 16m | step 9 — scale: pagination at 250k — step 9 — pagination at 250k; 125 e2e green, latency measured |
| 2026-07-25 | 23:51 | 00:00 | 0h 09m | step 10 — fault-injection pass — step 10 — fault-injection pass; 135 e2e green |
| 2026-07-26 | 00:09 | 00:24 | 0h 14m | step 10.5 — code review fixes — 8 findings incl. F8 deleting other specs' rows and D5 not testing its own rollback; sorting/counts writeups; 137 e2e green (start reconstructed) |
| 2026-07-26 | 15:12 | 15:30 | 0h 18m | step 10.6 — dialog copy, CANCELED spelling, slice→step — step 9.5 — search: pg_trgm + GIN index, debounced; 144 e2e green |

**Total logged: 4h 10m**

This total is the figure reported in `README.md` as time spent on the assignment.
