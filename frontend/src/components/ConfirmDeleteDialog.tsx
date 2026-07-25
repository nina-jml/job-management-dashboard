import { useEffect, useRef } from "react";

import type { Job } from "../api/types";
import { formatJobId } from "../lib/format";

interface Props {
  job: Job;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * In-app confirmation — never `window.confirm`.
 *
 * A native dialog blocks the browser's event loop, so Playwright stops
 * receiving commands entirely: the suite would *hang* rather than fail. A red
 * gate tells you something; a hung one tells you nothing and eats the timeout.
 *
 * It names the job and states the consequence, because "are you sure?" asks the
 * user to confirm something the dialog has not told them.
 */
export function ConfirmDeleteDialog({ job, isDeleting, onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the harmless choice. The dialog is reached by clicking
  // Delete, so an Enter still held down from that click must not carry through
  // and complete the deletion.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="scrim"
      onClick={(event) => {
        // Only a click on the backdrop itself dismisses — not one that bubbled
        // up from inside the dialog.
        if (event.target === event.currentTarget && !isDeleting) onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isDeleting) onCancel();
        }}
      >
        <h3 id="confirm-delete-title">Delete this job?</h3>
        <div className="job-ref">
          {formatJobId(job.id)} · {job.name}
        </div>
        <p>
          Its status history is deleted with it, including the record of how long it ran. This
          can&rsquo;t be undone — to stop a job but keep its history, cancel it instead.
        </p>
        <div className="row-actions">
          <button type="button" ref={cancelRef} onClick={onCancel} disabled={isDeleting}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? "Deleting…" : "Delete job"}
          </button>
        </div>
      </div>
    </div>
  );
}
