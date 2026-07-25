import { useMutation, useQueryClient } from "@tanstack/react-query";

import { jobsApi } from "../api/jobs";
import { jobKeys } from "./useJobs";

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
