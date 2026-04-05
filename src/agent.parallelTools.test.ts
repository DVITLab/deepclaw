import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { shouldParallelizeToolCallBatch } from "./agent.js";

function fnCall(id: string, name: string): ChatCompletionMessageToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

describe("shouldParallelizeToolCallBatch", () => {
  it("is false for a single read_file", () => {
    expect(shouldParallelizeToolCallBatch([fnCall("a", "read_file")])).toBe(
      false,
    );
  });

  it("is true for two read-only tools", () => {
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "read_file"),
        fnCall("2", "read_file"),
      ]),
    ).toBe(true);
  });

  it("is true for a mix of allowed read-only tools", () => {
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "list_dir"),
        fnCall("2", "git_status"),
      ]),
    ).toBe(true);
  });

  it("is true for browse_web and send_image_url together", () => {
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "browse_web"),
        fnCall("2", "send_image_url"),
      ]),
    ).toBe(true);
  });

  it("is false when any tool is mutating or shell", () => {
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "read_file"),
        fnCall("2", "write_file"),
      ]),
    ).toBe(false);
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "read_file"),
        fnCall("2", "run_shell"),
      ]),
    ).toBe(false);
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "read_file"),
        fnCall("2", "run_tests"),
      ]),
    ).toBe(false);
    expect(
      shouldParallelizeToolCallBatch([
        fnCall("1", "read_long_term_memory"),
        fnCall("2", "write_long_term_memory"),
      ]),
    ).toBe(false);
  });
});
