import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  buildPlanningGateUserContent,
  parsePlanningGateResponse,
} from "./planningGate.js";

describe("parsePlanningGateResponse", () => {
  it("parses PLAN and DIRECT", () => {
    expect(parsePlanningGateResponse("PLAN")).toBe("plan");
    expect(parsePlanningGateResponse("plan\nextra")).toBe("plan");
    expect(parsePlanningGateResponse("DIRECT")).toBe("direct");
    expect(parsePlanningGateResponse("direct")).toBe("direct");
    expect(parsePlanningGateResponse("yes")).toBe("plan");
    expect(parsePlanningGateResponse("no")).toBe("direct");
  });

  it("defaults to direct on garbage", () => {
    expect(parsePlanningGateResponse("")).toBe("direct");
    expect(parsePlanningGateResponse("maybe")).toBe("direct");
  });
});

describe("buildPlanningGateUserContent", () => {
  it("includes prior and current message", () => {
    const prior: ChatCompletionMessageParam[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const s = buildPlanningGateUserContent(prior, "next");
    expect(s).toContain("User: a");
    expect(s).toContain("Assistant: b");
    expect(s).toContain("next");
  });
});
