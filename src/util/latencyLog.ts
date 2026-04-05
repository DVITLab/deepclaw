import { logInfo } from "./logger.js";

/** Structured latency log for tuning agent/Telegram hot paths. */
export function logPhaseMs(
  phase: string,
  startedAt: number,
  extra?: Record<string, string | number>,
): void {
  const ms = Date.now() - startedAt;
  const tail = extra
    ? ` ${Object.entries(extra)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    : "";
  logInfo(`latency phase=${phase} ms=${ms}${tail}`);
}
