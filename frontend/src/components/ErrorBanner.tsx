import { ApiError } from "../api/client";

interface Props {
  error: unknown;
  /**
   * Overrides the server's sentence. Some failures are better explained by the
   * caller than by the API — a 404 on a status change means "this row is gone",
   * which the ORM's "No Job matches the given query." does not convey.
   */
  message?: string;
  /** Shown as a Retry button when the failure is worth retrying. */
  onRetry?: () => void;
  onDismiss?: () => void;
}

/** Turns anything thrown into something a person can act on. */
export function ErrorBanner({ error, message: override, onRetry, onDismiss }: Props) {
  if (!error) return null;

  const apiError = error instanceof ApiError ? error : null;
  const message = override ?? apiError?.message ?? "Something went wrong.";
  const canRetry = onRetry && (apiError?.isRetryable ?? true);

  return (
    <div className="banner" role="alert">
      <span className="mark">Error</span>
      <span className="msg">
        <b>{message}</b>
      </span>
      {canRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
