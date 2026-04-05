import { describe, expect, it, beforeEach } from "vitest";
import {
  assertLlmCircuitClosed,
  initLlmCircuit,
  LlmCircuitOpenError,
  recordLlmFailure,
  recordLlmSuccess,
} from "./llmCircuitBreaker.js";

describe("llmCircuitBreaker", () => {
  beforeEach(() => {
    initLlmCircuit({
      llmCircuitEnabled: true,
      llmCircuitFailureThreshold: 2,
      llmCircuitOpenMs: 60_000,
    });
  });

  it("opens after threshold infrastructure failures", () => {
    const err = { status: 503 } as const;
    recordLlmFailure(err);
    assertLlmCircuitClosed();
    recordLlmFailure(err);
    expect(() => assertLlmCircuitClosed()).toThrow(LlmCircuitOpenError);
  });

  it("does not count 4xx toward circuit", () => {
    recordLlmFailure({ status: 400 });
    recordLlmFailure({ status: 404 });
    assertLlmCircuitClosed();
  });

  it("resets failure streak on success", () => {
    recordLlmFailure({ status: 500 });
    recordLlmSuccess();
    recordLlmFailure({ status: 500 });
    assertLlmCircuitClosed();
  });

  it("is inactive when disabled", () => {
    initLlmCircuit({
      llmCircuitEnabled: false,
      llmCircuitFailureThreshold: 1,
      llmCircuitOpenMs: 60_000,
    });
    recordLlmFailure({ status: 500 });
    assertLlmCircuitClosed();
  });
});
