import { logWarn } from "./logger.js";

export class LlmCircuitOpenError extends Error {
  override readonly name = "LlmCircuitOpenError";
  constructor() {
    super("LLM API temporarily unavailable (circuit open)");
  }
}

let enabled = true;
let failureThreshold = 5;
let openDurationMs = 60_000;
let consecutiveFailures = 0;
let openUntil = 0;

export function initLlmCircuit(c: {
  llmCircuitEnabled: boolean;
  llmCircuitFailureThreshold: number;
  llmCircuitOpenMs: number;
}): void {
  enabled = c.llmCircuitEnabled;
  failureThreshold = c.llmCircuitFailureThreshold;
  openDurationMs = c.llmCircuitOpenMs;
  consecutiveFailures = 0;
  openUntil = 0;
}

export function assertLlmCircuitClosed(): void {
  if (!enabled) return;
  if (Date.now() < openUntil) {
    throw new LlmCircuitOpenError();
  }
}

export function recordLlmSuccess(): void {
  if (!enabled) return;
  consecutiveFailures = 0;
}

function shouldCountTowardCircuit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

/** Call when a completion attempt definitively failed (no more retries for this request). */
export function recordLlmFailure(err: unknown): void {
  if (!enabled) return;
  if (Date.now() < openUntil) return;
  if (!shouldCountTowardCircuit(err)) return;
  consecutiveFailures += 1;
  if (consecutiveFailures >= failureThreshold) {
    openUntil = Date.now() + openDurationMs;
    consecutiveFailures = 0;
    logWarn(
      `llm circuit: open for ${openDurationMs}ms after ${failureThreshold} infrastructure failures`,
    );
  }
}
