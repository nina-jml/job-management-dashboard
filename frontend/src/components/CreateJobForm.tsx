import { useState, type FormEvent } from "react";

import { ApiError } from "../api/client";

const MAX_NAME_LENGTH = 200;

interface Props {
  onCreate: (name: string) => Promise<unknown>;
  isSubmitting: boolean;
  /** Server-side rejection, so the field can show what the API objected to. */
  error: unknown;
}

/**
 * Validation happens twice, deliberately.
 *
 * Client-side so an obviously empty name never becomes a request — the user
 * gets the answer immediately and the server is not asked a question with a
 * known answer. Server-side because the client is not a trustworthy validator
 * (TEST_PLAN cases B2, B3, B4).
 */
function validate(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for the job.";
  // Counted in code points, not code units. `String.length` counts a surrogate
  // pair as two, while Django's CharField(max_length=200) and Postgres both
  // count it as one character — so `.length` would block names the API accepts,
  // and the B4 spec's own contract means the request is never sent to find out.
  // Any emoji-bearing name past ~100 characters hits this.
  if ([...trimmed].length > MAX_NAME_LENGTH) {
    return `Names are limited to ${MAX_NAME_LENGTH} characters.`;
  }
  return null;
}

export function CreateJobForm({ onCreate, isSubmitting, error }: Props) {
  const [name, setName] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  // The exact value the server rejected. The field error belongs to that value,
  // not to the form — without this the message outlives the input that earned
  // it, marking a freshly typed name invalid before it has been submitted. The
  // banner that would otherwise call `reset()` is deliberately not rendered for
  // field errors, so nothing else ever clears it.
  const [rejectedName, setRejectedName] = useState<string | null>(null);

  const serverError =
    error instanceof ApiError && name.trim() === rejectedName
      ? error.fieldError("name")
      : undefined;
  const message = clientError ?? serverError;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const problem = validate(name);
    if (problem) {
      // Blocked before any network call is made.
      setClientError(problem);
      return;
    }

    setClientError(null);
    const submitted = name.trim();
    try {
      await onCreate(submitted);
      // Cleared only on success — a failed create must not lose what was typed.
      setName("");
      setRejectedName(null);
    } catch {
      // Surfaced through `error`; the field keeps its value.
      setRejectedName(submitted);
    }
  }

  return (
    <form className="field grow" onSubmit={handleSubmit} noValidate>
      <label htmlFor="new-job-name">New job</label>
      <div className="create-row">
        <input
          id="new-job-name"
          type="text"
          className={`grow${message ? " invalid" : ""}`}
          placeholder="e.g. Transonic Wing Sweep"
          value={name}
          disabled={isSubmitting}
          aria-invalid={Boolean(message)}
          aria-describedby={message ? "new-job-error" : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (clientError) setClientError(null);
          }}
        />
        <button type="submit" className="primary" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create"}
        </button>
      </div>
      {message && (
        <span className="field-error" id="new-job-error" role="alert">
          {message}
        </span>
      )}
    </form>
  );
}
