import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { jobsApi, type JobFilters } from "../api/jobs";
import type { Job, Page, StatusEntry } from "../api/types";

/**
 * Query keys are structured so a filter change is a different query — which is
 * what makes filtering hit the server rather than the loaded page.
 */
export const jobKeys = {
  all: ["jobs"] as const,
  list: (filters: JobFilters) => ["jobs", "list", filters] as const,
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

/** A job's status log. Only fetched when a row's history is expanded. */
export function useJobHistory(id: number, enabled: boolean) {
  return useQuery({
    queryKey: jobKeys.history(id),
    queryFn: () => jobsApi.history(id),
    enabled,
    select: (page: Page<StatusEntry>) => page.results,
  });
}
