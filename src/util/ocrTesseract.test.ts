import { describe, it, expect } from "vitest";
import { OCR_MAX_OUTPUT_CHARS, truncateOcrText } from "./ocrTesseract.js";

describe("truncateOcrText", () => {
  it("returns short text unchanged", () => {
    expect(truncateOcrText("hello")).toBe("hello");
  });

  it("truncates long OCR with marker", () => {
    const long = "x".repeat(OCR_MAX_OUTPUT_CHARS + 50);
    const out = truncateOcrText(long);
    expect(out.length).toBeLessThanOrEqual(OCR_MAX_OUTPUT_CHARS + 30);
    expect(out).toContain("…[OCR truncated]");
  });
});
