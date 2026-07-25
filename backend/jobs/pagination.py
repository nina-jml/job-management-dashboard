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
    # can be skipped or repeated across page boundaries (TEST_PLAN case E2).
    ordering = ("-created_at", "-id")

    page_size_query_param = "page_size"
    # Uncapped page size is a trivial denial-of-service against your own API.
    max_page_size = 100
