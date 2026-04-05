import { describe, it, expect } from "vitest";
import { formatInstantInTimeZone } from "./displayTime.js";

describe("formatInstantInTimeZone", () => {
  it("formats a known instant in Asia/Ho_Chi_Minh", () => {
    const s = formatInstantInTimeZone(
      "2026-04-05T02:23:18.056Z",
      "Asia/Ho_Chi_Minh",
    );
    expect(s.length).toBeGreaterThan(10);
    expect(s).toMatch(/2026/);
  });
});
