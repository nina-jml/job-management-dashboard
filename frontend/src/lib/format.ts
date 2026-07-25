/** Stored UTC, rendered in the viewer's locale (OPEN_QUESTIONS A5). */

const FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // Seconds matter most in the status history: a job can go PENDING → RUNNING
  // inside the same minute, and at minute resolution those entries read as
  // simultaneous — which is exactly the ordering question the log exists to
  // answer.
  second: "2-digit",
  hour12: false,
  // Named explicitly: a job dashboard is read by people in several time zones,
  // and "13:50" with no zone is the kind of ambiguity that gets an incident
  // timeline wrong. The zone is the viewer's, not the server's — the API is
  // UTC throughout, and this is the only place that leaves it.
  timeZoneName: "short",
});

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : FORMATTER.format(date);
}

/** Zero-padded so the id column keeps one width and ids compare by eye. */
export function formatJobId(id: number): string {
  return `#${String(id).padStart(7, "0")}`;
}
