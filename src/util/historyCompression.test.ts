import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  findTailStartIndex,
  truncateOldToolBodies,
} from "./historyCompression.js";

describe("truncateOldToolBodies", () => {
  it("truncates old tool messages only", () => {
    const long = "x".repeat(100);
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "a" },
      { role: "tool", tool_call_id: "1", content: long },
      { role: "assistant", content: "b" },
      { role: "tool", tool_call_id: "2", content: long },
    ];
    const out = truncateOldToolBodies(msgs, 2, 20);
    expect(typeof out[1]!.content).toBe("string");
    expect((out[1]!.content as string).length).toBeLessThan(long.length);
    expect(out[3]!.content).toBe(long);
  });
});

describe("findTailStartIndex", () => {
  it("aligns tail start to user role", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ];
    expect(findTailStartIndex(msgs, 2)).toBe(2);
  });
});
