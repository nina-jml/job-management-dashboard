import { useState } from "react";

import type { Job, StatusType } from "../api/types";
import { JobRow } from "./JobRow";
import { StatusTimeline } from "./StatusTimeline";

interface Props {
  jobs: Job[];
  isLoading: boolean;
  isFiltered: boolean;
  /** Set when the list query failed — "no rows" then means unknown, not none. */
  isError?: boolean;
  onStatusChange?: (job: Job, status: StatusType) => void;
  onRetry?: (job: Job) => void;
  onDelete?: (job: Job) => void;
  savingIds?: ReadonlySet<number>;
  deletingIds?: ReadonlySet<number>;
}

/**
 * Row-shaped skeletons, so the layout does not jump when data lands.
 *
 * They carry `.skel-row`, never `.row`: specs address rows as `.rows .row`, and
 * a skeleton that answers to the same selector lets an assertion pass against
 * placeholder markup on a slow machine — green warm, red cold.
 */
function LoadingRows() {
  return (
    <div className="rows" aria-busy="true" aria-label="Loading jobs">
      {[0, 1, 2].map((index) => (
        <div className="skel-row" key={index}>
          <div className="skel w2" />
          <div className="skel w3" />
          <div className="skel w4" />
          <div className="skel w1" />
          <div />
        </div>
      ))}
    </div>
  );
}

export function JobList({
  jobs,
  isLoading,
  isFiltered,
  isError = false,
  onStatusChange,
  onRetry,
  onDelete,
  savingIds,
  deletingIds,
}: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <LoadingRows />;

  // A failed fetch is not an empty list. Claiming "No jobs yet" when the
  // request never succeeded tells the user their data does not exist, which is
  // a confident wrong answer; the error banner above is the honest one.
  if (jobs.length === 0 && isError) return null;

  if (jobs.length === 0) {
    return (
      <div className="empty">
        <b>{isFiltered ? "No jobs match those filters" : "No jobs yet"}</b>
        <p>
          {isFiltered
            ? "Clear the search, or release a status chip, to see everything."
            : "Create your first job using the field above."}
        </p>
      </div>
    );
  }

  // Derived rather than stored: a row can vanish under an open timeline — the
  // job deleted in another tab, or the table reseeded — and a panel showing the
  // log of a job that no longer exists is worse than no panel.
  const expandedId = jobs.some((job) => job.id === expanded) ? expanded : null;

  return (
    <div className="rows">
      {jobs.map((job) => (
        <div key={job.id}>
          <JobRow
            job={job}
            expanded={expandedId === job.id}
            onToggleHistory={() => setExpanded(expandedId === job.id ? null : job.id)}
            onStatusChange={onStatusChange ? (status) => onStatusChange(job, status) : undefined}
            onRetry={onRetry ? () => onRetry(job) : undefined}
            onDelete={onDelete ? () => onDelete(job) : undefined}
            isSaving={savingIds?.has(job.id) ?? false}
            isDeleting={deletingIds?.has(job.id) ?? false}
          />
          {expandedId === job.id && <StatusTimeline jobId={job.id} />}
        </div>
      ))}
    </div>
  );
}
