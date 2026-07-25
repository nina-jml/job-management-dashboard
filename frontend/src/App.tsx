import { useState } from "react";

import { useJobs } from "./hooks/useJobs";
import { statusErrorMessage, useCreateJob, useStatusChange } from "./hooks/useJobMutations";
import { JobList } from "./components/JobList";
import { CreateJobForm } from "./components/CreateJobForm";
import { ErrorBanner } from "./components/ErrorBanner";
import { STATUS_LABELS, STATUS_TYPES, type StatusType } from "./api/types";
import { ApiError } from "./api/client";

export function App() {
  const [statuses, setStatuses] = useState<StatusType[]>([]);

  // Filtering is a different query key, so it round-trips to the server rather
  // than narrowing the rows already loaded (SPEC §2).
  const filters = { statuses };
  const { data, isPending, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useJobs(filters);

  const createJob = useCreateJob();
  // Per-row state, not one mutation shared by every row — see useStatusChange.
  const { changeStatus, savingIds, errors: statusErrors, dismissError } = useStatusChange();

  const jobs = data?.pages.flatMap((page) => page.results) ?? [];
  const isFiltered = statuses.length > 0;

  // Selecting is a toggle in both directions: a chip that is on turns off, and
  // turning the last one off is how you get back to everything. A one-way
  // filter you can only escape through a separate "All" control is the version
  // of this that traps people.
  const toggleStatus = (status: StatusType) =>
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((each) => each !== status)
        : [...current, status],
    );

  // A field-level rejection belongs beside the input, not in the page banner.
  const createBannerError =
    createJob.error instanceof ApiError && createJob.error.fieldError("name")
      ? null
      : createJob.error;

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
              {/*
                "All" is the state of having nothing selected, so it reads as
                pressed when the list is unfiltered and clearing is what it
                does. It is not a sixth status.
              */}
              <button
                type="button"
                className="chip"
                aria-pressed={!isFiltered}
                onClick={() => setStatuses([])}
              >
                All
              </button>
              {STATUS_TYPES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="chip"
                  aria-pressed={statuses.includes(option)}
                  onClick={() => toggleStatus(option)}
                >
                  {STATUS_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <CreateJobForm
            onCreate={(name) => createJob.mutateAsync(name)}
            isSubmitting={createJob.isPending}
            error={createJob.error}
          />
        </div>

        {error && <ErrorBanner error={error} onRetry={() => void refetch()} />}
        {createBannerError && (
          <ErrorBanner error={createBannerError} onDismiss={() => createJob.reset()} />
        )}
        {[...statusErrors].map(([id, failure]) => (
          <ErrorBanner
            key={id}
            error={failure}
            message={statusErrorMessage(failure)}
            onDismiss={() => dismissError(id)}
          />
        ))}

        <div className="row-head">
          <span>Job</span>
          <span>ID</span>
          <span>History</span>
          <span>Status</span>
          <span className="col-actions">Actions</span>
        </div>

        <JobList
          jobs={jobs}
          isLoading={isPending}
          isFiltered={isFiltered}
          isError={Boolean(error)}
          savingIds={savingIds}
          onStatusChange={(job, status) => void changeStatus(job.id, status)}
          onRetry={(job) => {
            // Re-run is the same PATCH; the server decides whether PENDING is
            // reachable from where the job is (OPEN_QUESTIONS Q7, Q10).
            void changeStatus(job.id, "PENDING");
          }}
        />

        <div className="foot">
          <span className="count">
            {/* "0 loaded · no more results" after a failed fetch is the same
                false claim the empty state makes: we do not know what is there. */}
            {error && jobs.length === 0
              ? "Couldn't load jobs"
              : `${jobs.length} loaded${hasNextPage ? "" : " · no more results"}`}
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
