import { useMutation, useQueryClient } from "@tanstack/react-query";

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

/**
 * Change a job's status, optimistically.
 *
 * The badge moves immediately because waiting on a round trip to acknowledge a
 * dropdown choice feels broken. The obligation that creates is the rollback: if
 * the server refuses — an illegal transition, a 500 — every cached page is put
 * back exactly as it was, so the UI never claims a state the server rejected.
 */
export function useSetStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: StatusType }) =>
      jobsApi.setStatus(id, status),

    onMutate: async ({ id, status }) => {
      // Stop in-flight refetches from overwriting the optimistic value.
      await queryClient.cancelQueries({ queryKey: jobKeys.all });

      const snapshot = queryClient.getQueriesData<JobPages>({ queryKey: jobKeys.all });

      queryClient.setQueriesData<JobPages>({ queryKey: jobKeys.all }, (cached) =>
        !cached
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
                        // here would be a second copy of the state machine. The
                        // controls settle when the response lands.
                      }
                    : job,
                ),
              })),
            },
      );

      return { snapshot };
    },

    onError: (_error, _variables, context) => {
      // Put every page back the way it was.
      context?.snapshot.forEach(([key, data]) => {
        queryClient.setQueryData<JobPages>(key, data);
      });
    },

    onSettled: (_data, _error, { id }) => {
      // Refetch regardless: the projection, timestamps and the log all moved.
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
      void queryClient.invalidateQueries({ queryKey: jobKeys.history(id) });
    },
  });
}
