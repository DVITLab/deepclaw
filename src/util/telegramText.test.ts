import { describe, it, expect } from "vitest";
import { splitForTelegram, TELEGRAM_MAX_MESSAGE_CHARS } from "./telegramText.js";

describe("splitForTelegram", () => {
  it("returns single chunk when short", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  it("splits long text into multiple parts", () => {
    const s = "a".repeat(TELEGRAM_MAX_MESSAGE_CHARS + 100);
    const parts = splitForTelegram(s);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(s);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    }
  });
});
