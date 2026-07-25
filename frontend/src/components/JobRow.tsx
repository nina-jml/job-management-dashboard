import { useState } from "react";

import { STATUS_LABELS, STATUS_TYPES, type Job, type StatusType } from "../api/types";
import { formatJobId, formatTimestamp } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface Props {
  job: Job;
  expanded: boolean;
  onToggleHistory: () => void;
  /** Slice 7 wires these; the row renders read-only until then. */
  onStatusChange?: (status: StatusType) => void;
  onRetry?: () => void;
  isSaving?: boolean;
}

export function JobRow({
  job,
  expanded,
  onToggleHistory,
  onStatusChange,
  onRetry,
  isSaving = false,
}: Props) {
  const [editing, setEditing] = useState(false);

  const isTerminal = job.allowed_transitions.length === 0;
  const canEdit = Boolean(onStatusChange) && !isTerminal;

  return (
    <div className="row" data-job-id={job.id} data-status={job.current_status}>
      <span className="name">
        <b>{job.name}</b>
        <span className="meta">
          <span>created {formatTimestamp(job.created_at)}</span>
          <span>updated {formatTimestamp(job.updated_at)}</span>
          {isSaving && <span>saving…</span>}
        </span>
      </span>

      <span className="job-id">{formatJobId(job.id)}</span>

      <button
        type="button"
        className="ghost"
        aria-expanded={expanded}
        aria-label={expanded ? "Hide status history" : "Show status history"}
        onClick={onToggleHistory}
      >
        {expanded ? "▾" : "▸"} History
      </button>

      <span className="status-cell">
        {editing && onStatusChange ? (
          <select
            className="status-select"
            aria-label={`Status for ${job.name}`}
            defaultValue={job.current_status}
            autoFocus
            onChange={(event) => {
              const next = event.target.value as StatusType;
              setEditing(false);
              if (next !== job.current_status) onStatusChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
          >
            {STATUS_TYPES.map((status) => (
              <option
                key={status}
                value={status}
                // Every state stays visible so the rules are legible; only the
                // ones the server permits are selectable. The list comes from
                // the API — the state machine is never re-implemented here.
                disabled={status !== job.current_status && !job.allowed_transitions.includes(status)}
              >
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        ) : (
          <StatusBadge status={job.current_status} />
        )}
      </span>

      <span className="actions">
        {editing ? (
          // Deliberately not labelled "Cancel": the select beside it contains
          // "Cancelled", and a harmless action must not look destructive.
          <button
            type="button"
            className="ghost"
            aria-label="Stop editing status"
            title="Stop editing — leave the status unchanged"
            onClick={() => setEditing(false)}
          >
            ✕
          </button>
        ) : job.can_retry && onRetry ? (
          <button type="button" onClick={onRetry} disabled={isSaving} title="Start this job again">
            ↻ Re-run
          </button>
        ) : isTerminal ? (
          <span className="terminal-note">No further changes</span>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={isSaving}
            aria-label={`Edit status for ${job.name}`}
          >
            Edit
          </button>
        ) : null}
      </span>
    </div>
  );
}
