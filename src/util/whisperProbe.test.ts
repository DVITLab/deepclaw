import { describe, expect, it } from "vitest";
import { probeWhisperImport } from "./whisperProbe.js";

describe("probeWhisperImport", () => {
  it("returns false for a non-existent python binary", async () => {
    const ok = await probeWhisperImport("__deepclaw_no_such_interpreter__");
    expect(ok).toBe(false);
  });
});
