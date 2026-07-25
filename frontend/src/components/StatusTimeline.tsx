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
  const { data: entries, isPending, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useJobHistory(jobId, true);

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
        {/*
          With more to fetch, `entries.length` is how many are loaded, not how
          many exist — saying "N entries" there would state a total we have not
          seen. The wording only claims a total once the walk is exhausted.
        */}
        {hasNextPage
          ? `Status history · newest ${entries.length} loaded · newest first`
          : `Status history · ${entries.length} ${entries.length === 1 ? "entry" : "entries"} · newest first`}
      </p>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <b>{STATUS_LABELS[entry.status_type]}</b>
            <span>{formatTimestamp(entry.timestamp)}</span>
          </li>
        ))}
      </ol>
      {hasNextPage && (
        <button
          type="button"
          className="ghost"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? "Loading…" : "Load older entries"}
        </button>
      )}
    </div>
  );
}
