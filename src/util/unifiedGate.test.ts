import { describe, expect, it } from "vitest";
import { parseUnifiedGateResponse } from "./unifiedGate.js";

describe("parseUnifiedGateResponse", () => {
  it("parses clear_memory", () => {
    const r = parseUnifiedGateResponse('{"action":"clear_memory"}');
    expect(r.action).toBe("clear_memory");
    expect(r.planningRoute).toBe("direct");
  });

  it("parses none with plan route", () => {
    const r = parseUnifiedGateResponse(
      '{"action":"none","planningRoute":"plan"}',
    );
    expect(r.action).toBe("none");
    expect(r.planningRoute).toBe("plan");
  });

  it("parses none defaulting planning to direct", () => {
    const r = parseUnifiedGateResponse('{"action":"none"}');
    expect(r.action).toBe("none");
    expect(r.planningRoute).toBe("direct");
  });

  it("delegates list and sets planning direct", () => {
    const r = parseUnifiedGateResponse('{"action":"list"}');
    expect(r.action).toBe("list");
    expect(r.planningRoute).toBe("direct");
  });
});
