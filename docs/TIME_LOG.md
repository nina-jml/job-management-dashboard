# Time Log

Rendered from `docs/time_log.tsv` by `scripts/timelog.sh report` (or `make time`).
Do not edit by hand — edit the ledger instead.

Times are **PDT** (`America/Los_Angeles`). The ledger stores UTC;
only this rendering is local.

| Date | Start | End | Duration | Work |
|---|---|---|---|---|
| 2026-07-25 | 08:08 | 08:33 | 0h 25m | planning — spec, step plan, test plan, tracker — steps 0 and 1 shipped; cold gate green |
| 2026-07-25 | 09:41 | 09:50 | 0h 09m | steps 2-4 — create, update, delete — step 2 — POST + auto PENDING; 23 e2e, 14 unit green |
| 2026-07-25 | 09:50 | 10:01 | 0h 10m | step 3 — PATCH + transitions — step 3 — PATCH + state machine; 38 e2e, 31 unit green |
| 2026-07-25 | 10:01 | 10:23 | 0h 22m | step 4 — DELETE + cascade + history — step 4 — DELETE + cascade + history; T3 cold gate green |
| 2026-07-25 | 11:48 | 12:00 | 0h 11m | CANCELLED state — CANCELLED state — 57 e2e, 43 unit green |
| 2026-07-25 | 12:37 | 13:02 | 0h 25m | review fixes + db port — step 5 — job list UI; 67 e2e, 43 unit green |
| 2026-07-25 | 13:02 | 13:11 | 0h 08m | step 6 — create form — step 6 — create form; 77 e2e green |
| 2026-07-25 | 13:11 | 13:50 | 0h 39m | step 7 — status update — step 7 — status update; T3 green, 87 e2e + 43 unit |
| 2026-07-25 | 14:12 | 14:37 | 0h 25m | step 7.5 — review fixes — tz on timestamps, multi-select filter, counts deferred to README; 96 e2e + 43 unit green (start reconstructed: timelog start hit a tool error) |
| 2026-07-25 | 16:21 | 16:34 | 0h 13m | step 8 — delete UI + client.ts fault cases — step 8 — delete UI + E9/E10; 116 e2e green, no flakes |
| 2026-07-25 | 16:34 | 16:50 | 0h 16m | step 9 — scale: pagination at 250k — step 9 — pagination at 250k; 125 e2e green, latency measured |
| 2026-07-25 | 16:51 | 17:00 | 0h 09m | step 10 — fault-injection pass — step 10 — fault-injection pass; 135 e2e green |
| 2026-07-25 | 17:09 | 17:24 | 0h 14m | step 10.5 — code review fixes — 8 findings incl. F8 deleting other specs' rows and D5 not testing its own rollback; sorting/counts writeups; 137 e2e green (start reconstructed) |
| 2026-07-26 | 08:12 | 08:30 | 0h 18m | steps 10.6 + 9.5 — dialog copy, CANCELED respelling with data migration, slice→step rename, then search (pg_trgm + GIN, debounced); 144 e2e green |

**Total logged: 4h 10m**

This total is the figure reported in `README.md` as time spent on the assignment.
