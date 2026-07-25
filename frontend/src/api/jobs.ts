import { api } from "./client";
import type { Job, Page, StatusEntry, StatusType } from "./types";

export interface JobFilters {
  /** Server-side, across the whole table — never a filter over loaded rows. */
  status?: StatusType | "ALL";
  search?: string;
}

function query(filters: JobFilters, pageSize: number): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "ALL") params.set("status", filters.status);
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  params.set("page_size", String(pageSize));
  return params.toString();
}

export const jobsApi = {
  /** `cursor` is an opaque `next` URL from a previous page. */
  list: (filters: JobFilters = {}, pageSize = 25, cursor?: string): Promise<Page<Job>> =>
    api.get<Page<Job>>(cursor ? cursor.replace(/^.*\/api/, "") : `/jobs/?${query(filters, pageSize)}`),

  retrieve: (id: number): Promise<Job> => api.get<Job>(`/jobs/${id}/`),

  create: (name: string): Promise<Job> => api.post<Job>("/jobs/", { name }),

  /** `status` is an instruction to append to the log, not a field on the job. */
  setStatus: (id: number, status: StatusType): Promise<Job> =>
    api.patch<Job>(`/jobs/${id}/`, { status }),

  rename: (id: number, name: string): Promise<Job> => api.patch<Job>(`/jobs/${id}/`, { name }),

  remove: (id: number): Promise<void> => api.delete(`/jobs/${id}/`),

  history: (id: number): Promise<Page<StatusEntry>> =>
    api.get<Page<StatusEntry>>(`/jobs/${id}/statuses/?page_size=200`),
};
