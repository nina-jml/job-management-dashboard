import { STATUS_LABELS, type StatusType } from "../api/types";

/**
 * Colour is never the only carrier of state — each badge also spells out its
 * label, so the list is readable without relying on hue.
 */
export function StatusBadge({ status }: { status: StatusType }) {
  return (
    <span className="status" data-status={status}>
      {/* A running job is the one thing on screen that is still changing. */}
      {status === "RUNNING" && <span className="pending-dot" aria-hidden="true" />}
      {STATUS_LABELS[status]}
    </span>
  );
}
