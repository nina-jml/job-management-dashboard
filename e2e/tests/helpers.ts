import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

/**
 * Test isolation.
 *
 * The suite runs against a real Postgres, not a fixture database, so no spec
 * may assume an empty table or a specific row count. Every spec namespaces the
 * rows it creates and scopes its assertions to them — which is what makes the
 * suite safe to re-run without `make clean` (TEST_PLAN case A3).
 */
export function uniquePrefix(label: string): string {
  return `e2e-${label}-${randomUUID().slice(0, 8)}-`;
}

export const STATUS_TYPES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

export interface Job {
  id: number;
  name: string;
  current_status: StatusType;
  current_status_at: string;
  created_at: string;
  updated_at: string;
  /** States reachable from current_status — the UI disables everything else. */
  allowed_transitions: StatusType[];
  /** Only FAILED or CANCELLED jobs can be re-run (OPEN_QUESTIONS Q7, Q10). */
  can_retry: boolean;
}

export interface Page<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Field set every job payload must carry, per SPEC.md §2. */
export const JOB_FIELDS = [
  "id",
  "name",
  "current_status",
  "current_status_at",
  "created_at",
  "updated_at",
  "allowed_transitions",
  "can_retry",
] as const;

export async function listJobs(
  request: APIRequestContext,
  params: Record<string, string | number> = {},
): Promise<Page<Job>> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const response = await request.get(`/api/jobs/${query ? `?${query}` : ""}`);
  if (!response.ok()) {
    throw new Error(`GET /api/jobs/ failed: ${response.status()} ${await response.text()}`);
  }
  return response.json() as Promise<Page<Job>>;
}

export interface StatusEntry {
  id: number;
  status_type: StatusType;
  timestamp: string;
}

/** A job's status history — the append-only log behind `current_status`. */
export async function history(
  request: APIRequestContext,
  jobId: number,
): Promise<Page<StatusEntry>> {
  const response = await request.get(`/api/jobs/${jobId}/statuses/?page_size=200`);
  if (!response.ok()) {
    throw new Error(
      `GET /api/jobs/${jobId}/statuses/ failed: ${response.status()} ${await response.text()}`,
    );
  }
  return response.json() as Promise<Page<StatusEntry>>;
}

/** Follow an absolute `next` URL, returning just the path so baseURL still applies. */
export function toPath(url: string): string {
  return new URL(url).pathname + new URL(url).search;
}
