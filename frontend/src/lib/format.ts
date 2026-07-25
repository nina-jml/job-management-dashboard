/** Stored UTC, rendered in the viewer's locale (OPEN_QUESTIONS A5). */

const FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : FORMATTER.format(date);
}

/** Zero-padded so the id column keeps one width and ids compare by eye. */
export function formatJobId(id: number): string {
  return `#${String(id).padStart(7, "0")}`;
}
