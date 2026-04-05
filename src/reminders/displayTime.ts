/**
 * Wall-clock formatting in an IANA zone (locale follows runtime default).
 */
export function formatInstantInTimeZone(
  isoOrMs: string | number,
  timeZone: string,
): string {
  const d =
    typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (!Number.isFinite(d.getTime())) return String(isoOrMs);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  }
}
