import { useState } from "react";

import type { Job, StatusType } from "../api/types";
import { JobRow } from "./JobRow";
import { StatusTimeline } from "./StatusTimeline";

interface Props {
  jobs: Job[];
  isLoading: boolean;
  isFiltered: boolean;
  onStatusChange?: (job: Job, status: StatusType) => void;
  onRetry?: (job: Job) => void;
  savingJobId?: number | null;
}

/** Row-shaped skeletons, so the layout does not jump when data lands. */
function LoadingRows() {
  return (
    <div className="rows" aria-busy="true" aria-label="Loading jobs">
      {[0, 1, 2].map((index) => (
        <div className="row" key={index}>
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
  onStatusChange,
  onRetry,
  savingJobId,
}: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (isLoading) return <LoadingRows />;

  if (jobs.length === 0) {
    return (
      <div className="empty">
        <b>{isFiltered ? "No jobs match those filters" : "No jobs yet"}</b>
        <p>
          {isFiltered
            ? "Clear the search or pick a different status."
            : "Create your first job using the field above."}
        </p>
      </div>
    );
  }

  return (
    <div className="rows">
      {jobs.map((job) => (
        <div key={job.id}>
          <JobRow
            job={job}
            expanded={expandedId === job.id}
            onToggleHistory={() => setExpandedId(expandedId === job.id ? null : job.id)}
            onStatusChange={onStatusChange ? (status) => onStatusChange(job, status) : undefined}
            onRetry={onRetry ? () => onRetry(job) : undefined}
            isSaving={savingJobId === job.id}
          />
          {expandedId === job.id && <StatusTimeline jobId={job.id} />}
        </div>
      ))}
    </div>
  );
}
