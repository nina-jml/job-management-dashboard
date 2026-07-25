import { useInfiniteQuery } from "@tanstack/react-query";

import { jobsApi, type JobFilters } from "../api/jobs";
import type { Job, Page, StatusEntry } from "../api/types";

/**
 * Query keys are structured so a filter change is a different query — which is
 * what makes filtering hit the server rather than the loaded page.
 */
export const jobKeys = {
  all: ["jobs"] as const,
  // Every list query, and nothing else. `all` also matches the history
  // entries, whose cached shape is a plain page rather than `{pages: […]}` —
  // an optimistic writer filtering on `all` reaches them and blows up on a
  // `pages` array that was never there.
  lists: ["jobs", "list"] as const,
  // Statuses are sorted here rather than at the call site: the same selection
  // reached in a different click order has to be the same cache entry, and
  // sorting where the key is built is the one place it cannot be forgotten.
  list: (filters: JobFilters) =>
    ["jobs", "list", { ...filters, statuses: [...(filters.statuses ?? [])].sort() }] as const,
  history: (id: number) => ["jobs", "history", id] as const,
};

const PAGE_SIZE = 25;

/** One page at a time, appended on demand — never the whole table. */
export function useJobs(filters: JobFilters) {
  return useInfiniteQuery({
    queryKey: jobKeys.list(filters),
    queryFn: ({ pageParam }) => jobsApi.list(filters, PAGE_SIZE, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: Page<Job>) => lastPage.next ?? undefined,
    // A failed list is shown, not silently retried into a spinner that never ends.
    retry: 1,
  });
}

/**
 * A job's status log. Only fetched when a row's history is expanded.
 *
 * Paged like the job list, and for the same reason: a long-lived job's history
 * is unbounded. `select` flattens the pages so the component still sees one
 * array, but `hasNextPage` tells it honestly whether there is more.
 */
export function useJobHistory(id: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: jobKeys.history(id),
    queryFn: ({ pageParam }) => jobsApi.history(id, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: Page<StatusEntry>) => lastPage.next ?? undefined,
    enabled,
    select: (data) => data.pages.flatMap((page) => page.results),
  });
}
