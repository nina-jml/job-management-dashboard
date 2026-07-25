/** Mirrors the DRF serializers. Kept in one place so drift is a compile error. */

export const STATUS_TYPES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export type StatusType = (typeof STATUS_TYPES)[number];

export const STATUS_LABELS: Record<StatusType, string> = {
  PENDING: "Pending",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export interface Job {
  id: number;
  name: string;
  current_status: StatusType;
  current_status_at: string;
  created_at: string;
  updated_at: string;
  /**
   * States reachable from `current_status`, straight from the server.
   *
   * The state machine lives in `jobs/transitions.py` and is *not* duplicated
   * here — a second copy in TypeScript is exactly the thing that drifts. The UI
   * disables whatever this list omits.
   */
  allowed_transitions: StatusType[];
  /** True for FAILED and CANCELLED — work that did not finish (OPEN_QUESTIONS Q10). */
  can_retry: boolean;
}

export interface StatusEntry {
  id: number;
  status_type: StatusType;
  timestamp: string;
}

/** Cursor-paginated envelope. No `count` — see `jobs/pagination.py`. */
export interface Page<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}
