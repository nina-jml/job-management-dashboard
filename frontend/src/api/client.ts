/**
 * The only place that talks to the network.
 *
 * Every failure mode — offline, HTTP error, unparseable body — arrives at the UI
 * as one `ApiError` with a message worth showing a person. That is what lets
 * components render errors without knowing anything about fetch or DRF.
 */

/** Shape the DRF exception handler guarantees (`jobs/exceptions.py`). */
interface ErrorBody {
  detail: string;
  errors: Record<string, string[]>;
}

export class ApiError extends Error {
  readonly status: number;
  /** Field-keyed messages, for putting errors next to the input that caused them. */
  readonly fields: Record<string, string[]>;

  constructor(message: string, status: number, fields: Record<string, string[]> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }

  /** True when retrying might plausibly work — offline, timeout, 5xx. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  /** The message for a specific field, if the server blamed one. */
  fieldError(name: string): string | undefined {
    return this.fields[name]?.[0];
  }
}

/** Same origin: nginx proxies /api to Django, so no base URL is baked in. */
const BASE = "/api";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    // fetch only rejects for network-level failures; treat them as status 0 so
    // callers have one type to handle rather than two.
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // A proxy error page or a truncated response — not JSON, so say something
    // true rather than leaking a parser error.
    throw new ApiError(
      response.ok
        ? "The server sent a response we couldn't read."
        : `The server returned an error (${response.status}).`,
      response.ok ? 0 : response.status,
    );
  }

  if (!response.ok) {
    const { detail, errors } = (body ?? {}) as Partial<ErrorBody>;
    throw new ApiError(
      detail || `The server returned an error (${response.status}).`,
      response.status,
      errors ?? {},
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (path: string) => request<void>(path, { method: "DELETE" }),
};
