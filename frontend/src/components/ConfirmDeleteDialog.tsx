import { useEffect, useRef } from "react";

import type { Job } from "../api/types";
import { formatJobId } from "../lib/format";

interface Props {
  job: Job;
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
 *
 * There is deliberately no busy state. Deletion is optimistic, so confirming
 * closes this immediately and the row itself carries the in-flight state —
 * there is nothing left here to disable.
 */
export function ConfirmDeleteDialog({ job, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Straight from the server's `allowed_transitions`, so the copy cannot
  // disagree with what the status control actually offers.
  const canCancelInstead = job.allowed_transitions.includes("CANCELED");

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus lands on the harmless choice. The dialog is reached by clicking
    // Delete, so an Enter still held from that click must not carry through.
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;

      // `aria-modal` tells assistive tech the rest of the page is inert; it
      // does not make it so. Without this, Tab walks straight out of the dialog
      // into the list behind it and the claim is a lie.
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // On `document`, not on the dialog element: the dialog div is not
    // focusable, so a handler bound to it only sees events bubbling from a
    // focused descendant. Click the explanatory paragraph and focus falls back
    // to <body> — at which point Escape would silently stop working.
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Put focus back where the user left it, not at the top of the document.
      previouslyFocused?.focus?.();
    };
  }, [onCancel]);

  return (
    <div
      className="scrim"
      onClick={(event) => {
        // Only a click on the backdrop itself dismisses — not one that bubbled
        // up from inside the dialog.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <h3 id="confirm-delete-title">Delete this job?</h3>
        <div className="job-ref">
          {formatJobId(job.id)} · {job.name}
        </div>
        <p>
          Its status history is deleted with it, including the record of how long it ran. This
          can&rsquo;t be undone
          {/*
            Only offered when canceling is actually reachable. Suggesting it for
            a job that has already finished points at a control that is not
            there — advice the user cannot take is worse than no advice.
            `allowed_transitions` is the server's answer, so this asks the state
            machine rather than re-deriving it.
          */}
          {canCancelInstead ? " — to stop a job but keep its history, cancel it instead." : "."}
        </p>
        <p>Are you sure you want to delete it?</p>
        <div className="row-actions">
          {/*
            Named for the outcome, not the mechanism. "Cancel" is the wrong word
            in a dialog about a job that can itself be *canceled* — it reads as
            "cancel the job" rather than "back out of this".
          */}
          <button type="button" ref={cancelRef} onClick={onCancel}>
            No, exit
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            Yes, delete it
          </button>
        </div>
      </div>
    </div>
  );
}
