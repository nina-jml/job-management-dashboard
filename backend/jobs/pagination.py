"""
Cursor (keyset) pagination — the core of the "millions of jobs" answer.

Two things break page-number pagination at that scale, and cursor pagination
avoids both:

1. `OFFSET 500000` makes Postgres walk and discard half a million rows before
   returning anything. A keyset predicate — `WHERE (created_at, id) < (…)` —
   is an index seek, so page 20,000 costs what page 1 costs.
2. DRF's PageNumberPagination issues a `COUNT(*)` on every request to build the
   `count` field. On a multi-million-row table that is a full index scan per
   page load, on the hot path, for a number nobody reads.

The trade-off, stated honestly in the README: no "jump to page 47". For a
feed-shaped dashboard that is the right trade — filter and search are how users
actually narrow a large list.
"""

from rest_framework.pagination import CursorPagination


class JobCursorPagination(CursorPagination):
    # Must match Job.Meta.ordering. The `-id` tiebreaker makes the ordering
    # total, which keyset pagination requires for correctness: with ties, rows
    # can be skipped or repeated across page boundaries (TEST_PLAN case F2).
    #
    # Known limitation, verified against DRF 3.15.2: the cursor predicate is
    # built from `ordering[0]` alone — here `created_at` — and rows sharing that
    # value are paged with an integer offset rather than by the tiebreaker. So
    # `-id` makes the SQL ORDER BY total but never reaches the cursor itself. If
    # two jobs share a `created_at` to the microsecond and one is deleted
    # between page fetches, the offset lands a row further along and one row is
    # skipped. `created_at` is microsecond-precision auto_now_add, so a
    # collision needs two inserts in the same microsecond; the exposure is
    # accepted and documented rather than fixed. The fix, if this ever mattered,
    # is an override encoding a composite (created_at, id) position.
    ordering = ("-created_at", "-id")

    page_size_query_param = "page_size"
    # Uncapped page size is a trivial denial-of-service against your own API.
    max_page_size = 100


class JobStatusCursorPagination(CursorPagination):
    """History pages for a single job.

    Same reasoning as above, one level down: a job polled by a scheduler can
    accumulate a large log, and an unpaginated "it's only a history" endpoint is
    how that turns into an unbounded response.
    """

    # Matches JobStatus.Meta.ordering, with `id` as the tiebreaker so events
    # recorded in the same microsecond still page deterministically.
    ordering = ("-timestamp", "-id")

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200
