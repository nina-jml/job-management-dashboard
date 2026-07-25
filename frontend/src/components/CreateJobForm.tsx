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
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Names are limited to ${MAX_NAME_LENGTH} characters.`;
  }
  return null;
}

export function CreateJobForm({ onCreate, isSubmitting, error }: Props) {
  const [name, setName] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  const serverError = error instanceof ApiError ? error.fieldError("name") : undefined;
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
    try {
      await onCreate(name.trim());
      // Cleared only on success — a failed create must not lose what was typed.
      setName("");
    } catch {
      // Surfaced through `error`; the field keeps its value.
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
