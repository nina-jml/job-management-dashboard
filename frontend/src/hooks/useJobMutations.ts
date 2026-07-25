import { useCallback, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import { jobsApi } from "../api/jobs";
import type { Job, Page, StatusType } from "../api/types";
import { jobKeys } from "./useJobs";

/** Shape of an infinite-query cache entry, for optimistic edits. */
type JobPages = { pages: Page<Job>[]; pageParams: unknown[] };

/**
 * Mutations invalidate the list rather than patching it by hand.
 *
 * A created job's position depends on the server's ordering and the active
 * filters; recomputing that in the client is a second implementation of the
 * query, and it would be wrong the moment either changes.
 */
export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => jobsApi.create(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

/** The status a job currently shows in the cache, or null if it isn't loaded. */
function cachedStatus(queryClient: QueryClient, id: number): StatusType | null {
  for (const [, data] of queryClient.getQueriesData<JobPages>({ queryKey: jobKeys.lists })) {
    for (const page of data?.pages ?? []) {
      const match = page.results.find((job) => job.id === id);
      if (match) return match.current_status;
    }
  }
  return null;
}

/**
 * Write one job's status across every cached list page.
 *
 * Used for both the optimistic write and the rollback, and scoped to the single
 * row: restoring a whole-cache snapshot would undo a *different* row's
 * in-flight change that happened to land in between.
 *
 * `jobKeys.lists`, never `jobKeys.all` — the latter also matches the history
 * entries, whose cached value is a plain page with no `pages` array. Reaching
 * one of those throws inside the updater, and because this runs before the
 * request, a throw means the PATCH is never sent while the badge still moves.
 */
function writeCachedStatus(queryClient: QueryClient, id: number, status: StatusType) {
  queryClient.setQueriesData<JobPages>({ queryKey: jobKeys.lists }, (cached) =>
    !cached?.pages
      ? cached
      : {
          ...cached,
          pages: cached.pages.map((page) => ({
            ...page,
            results: page.results.map((job) =>
              job.id === id
                ? {
                    ...job,
                    current_status: status,
                    // Deliberately not guessed: allowed_transitions and
                    // can_retry are the server's answer, and inventing them
                    // here would be a second copy of the state machine. The row
                    // stays busy until the refetch lands, which is what keeps
                    // the stale pair from being acted on.
                  }
                : job,
            ),
          })),
        },
  );
}

/**
 * Change job statuses, optimistically, with per-row state.
 *
 * Deliberately not `useMutation`: one observer reports a single aggregate
 * state and holds a single set of per-call callbacks, so a second change
 * overwrites the first's — the first row's "saving…" hint moves to the second
 * and its failure is never reported at all. Two rows in flight have to be two
 * independent pieces of state, which closures give and one observer cannot.
 *
 * The badge moves immediately because waiting on a round trip to acknowledge a
 * dropdown choice feels broken. The obligation that creates is the rollback: if
 * the server refuses, the row goes back to the status it had.
 */
export function useStatusChange() {
  const queryClient = useQueryClient();
  const [savingIds, setSavingIds] = useState<ReadonlySet<number>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<number, unknown>>(() => new Map());

  const dismissError = useCallback((id: number) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const changeStatus = useCallback(
    async (id: number, status: StatusType) => {
      setSavingIds((current) => new Set(current).add(id));
      dismissError(id);

      // Stop in-flight refetches from overwriting the optimistic value.
      await queryClient.cancelQueries({ queryKey: jobKeys.lists });

      const previous = cachedStatus(queryClient, id);
      writeCachedStatus(queryClient, id, status);

      try {
        await jobsApi.setStatus(id, status);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) {
          // A 404 means the row is gone, not that our value was wrong. Putting
          // the old status back would resurrect a job the server says does not
          // exist — a recovery as wrong as the failure, just calmer looking.
          // The refetch below lets it disappear because the server said so.
          queryClient.removeQueries({ queryKey: jobKeys.history(id) });
        } else if (previous) {
          writeCachedStatus(queryClient, id, previous);
        }
        setErrors((current) => new Map(current).set(id, failure));
      } finally {
        // The projection, timestamps and log have all moved. Awaited, because
        // the row is stale until this returns: `allowed_transitions` and
        // `can_retry` still describe the old status until the refetch lands,
        // and a row that looked settled in that window would offer moves the
        // server is about to reject.
        await queryClient.invalidateQueries({ queryKey: jobKeys.lists });
        await queryClient.invalidateQueries({ queryKey: jobKeys.history(id) });
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [queryClient, dismissError],
  );

  return { changeStatus, savingIds, errors, dismissError };
}

/** Drop one job from every cached list page. */
function removeCachedJob(queryClient: QueryClient, id: number) {
  queryClient.setQueriesData<JobPages>({ queryKey: jobKeys.lists }, (cached) =>
    !cached?.pages
      ? cached
      : {
          ...cached,
          pages: cached.pages.map((page) => ({
            ...page,
            results: page.results.filter((job) => job.id !== id),
          })),
        },
  );
}

/**
 * Delete a job, optimistically, with per-row state.
 *
 * Optimistic for the same reason the status change is: the row leaving
 * immediately is the "UI updates dynamically" requirement, and the user has
 * already committed through a confirmation dialog.
 *
 * Rollback restores a snapshot rather than re-inserting the row, because a
 * removal has no single field to put back — position within the page matters.
 * The cost is that a concurrent status change landing in the same instant would
 * be reverted with it; the awaited invalidation below corrects that within one
 * refetch, and two mutations on different rows inside the same tick is a much
 * narrower case than the one this avoids.
 */
export function useDeleteJob() {
  const queryClient = useQueryClient();
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<number>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<number, unknown>>(() => new Map());

  const dismissError = useCallback((id: number) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const deleteJob = useCallback(
    async (id: number) => {
      setDeletingIds((current) => new Set(current).add(id));
      dismissError(id);

      await queryClient.cancelQueries({ queryKey: jobKeys.lists });
      const snapshot = queryClient.getQueriesData<JobPages>({ queryKey: jobKeys.lists });
      removeCachedJob(queryClient, id);

      try {
        await jobsApi.remove(id);
      } catch (failure) {
        // A 404 is success. The user asked for this job to be gone and it is
        // gone — someone else got there first. Surfacing an error for an
        // outcome that matches the intent teaches people to ignore errors.
        if (!(failure instanceof ApiError && failure.status === 404)) {
          snapshot.forEach(([key, data]) => {
            queryClient.setQueryData<JobPages>(key, data);
          });
          setErrors((current) => new Map(current).set(id, failure));
        }
      } finally {
        // Its history describes a job that no longer exists either way: on
        // success because it cascaded, on a 404 because it already had.
        queryClient.removeQueries({ queryKey: jobKeys.history(id) });
        await queryClient.invalidateQueries({ queryKey: jobKeys.lists });
        setDeletingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [queryClient, dismissError],
  );

  return { deleteJob, deletingIds, errors, dismissError };
}

/**
 * What to tell the user when a status change fails.
 *
 * DRF's 404 body is "No Job matches the given query." — the ORM's sentence,
 * not one that explains anything to a person looking at a row that just
 * vanished.
 */
export function statusErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This job no longer exists — it was deleted.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
