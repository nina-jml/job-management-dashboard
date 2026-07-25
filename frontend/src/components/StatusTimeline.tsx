import { useJobHistory } from "../hooks/useJobs";
import { STATUS_LABELS } from "../api/types";
import { formatTimestamp } from "../lib/format";

/**
 * A job's status log, newest first.
 *
 * Fetched only when a row is expanded — a history per row on the list would be
 * an N+1 against an endpoint nobody asked for.
 */
export function StatusTimeline({ jobId }: { jobId: number }) {
  const { data: entries, isPending, error } = useJobHistory(jobId, true);

  if (isPending) {
    return (
      <div className="history">
        <p className="caption">Loading history…</p>
      </div>
    );
  }

  if (error || !entries) {
    return (
      <div className="history">
        <p className="caption">Couldn't load this job's history.</p>
      </div>
    );
  }

  return (
    <div className="history">
      <p className="caption">
        Status history · {entries.length} {entries.length === 1 ? "entry" : "entries"} · newest first
      </p>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <b>{STATUS_LABELS[entry.status_type]}</b>
            <span>{formatTimestamp(entry.timestamp)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
