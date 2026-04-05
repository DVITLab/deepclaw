const startedAt = Date.now();
let turnsCompleted = 0;
let turnsAborted = 0;
let turnsErrored = 0;

export function processUptimeMs(): number {
  return Date.now() - startedAt;
}

export function recordTurnOutcome(outcome: "ok" | "abort" | "error"): void {
  if (outcome === "ok") turnsCompleted += 1;
  else if (outcome === "abort") turnsAborted += 1;
  else turnsErrored += 1;
}

export function turnCountersSnapshot(): {
  uptimeMs: number;
  turnsCompleted: number;
  turnsAborted: number;
  turnsErrored: number;
} {
  return {
    uptimeMs: processUptimeMs(),
    turnsCompleted,
    turnsAborted,
    turnsErrored,
  };
}
