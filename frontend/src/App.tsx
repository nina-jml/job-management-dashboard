import { useState } from "react";

import { useJobs } from "./hooks/useJobs";
import { JobList } from "./components/JobList";
import { ErrorBanner } from "./components/ErrorBanner";
import { STATUS_LABELS, STATUS_TYPES, type StatusType } from "./api/types";

type Filter = StatusType | "ALL";

export function App() {
  const [status, setStatus] = useState<Filter>("ALL");

  // Filtering is a different query key, so it round-trips to the server rather
  // than narrowing the rows already loaded (SPEC §2).
  const filters = { status };
  const { data, isPending, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useJobs(filters);

  const jobs = data?.pages.flatMap((page) => page.results) ?? [];
  const isFiltered = status !== "ALL";

  return (
    <main className="page">
      <header className="page__header">
        <h1>Job Management Dashboard</h1>
        <p>Monitor and manage computational jobs.</p>
      </header>

      <div className="app">
        <div className="toolbar">
          <div className="field">
            <label id="status-filter-label">Status</label>
            <div className="filters" role="group" aria-labelledby="status-filter-label">
              {(["ALL", ...STATUS_TYPES] as Filter[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="chip"
                  aria-pressed={status === option}
                  onClick={() => setStatus(option)}
                >
                  {option === "ALL" ? "All" : STATUS_LABELS[option]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <ErrorBanner error={error} onRetry={() => void refetch()} />}

        <div className="row-head">
          <span>Job</span>
          <span>ID</span>
          <span>History</span>
          <span>Status</span>
          <span className="col-actions">Actions</span>
        </div>

        <JobList jobs={jobs} isLoading={isPending} isFiltered={isFiltered} />

        <div className="foot">
          <span className="count">
            {jobs.length} loaded{hasNextPage ? "" : " · no more results"}
          </span>
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={!hasNextPage || isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      </div>
    </main>
  );
}
