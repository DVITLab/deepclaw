import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dailyLogFilePath,
  formatLogTimestamp,
  logInfo,
  logTraceStorage,
} from "./logger.js";

describe("formatLogTimestamp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses ISO UTC when TZ is UTC", () => {
    vi.stubEnv("TZ", "UTC");
    expect(formatLogTimestamp(new Date("2026-04-05T00:00:00.000Z"))).toBe(
      "2026-04-05T00:00:00.000Z",
    );
  });

  it("uses wall time in Asia/Ho_Chi_Minh", () => {
    vi.stubEnv("TZ", "Asia/Ho_Chi_Minh");
    expect(formatLogTimestamp(new Date("2026-04-05T00:00:00.000Z"))).toBe(
      "2026-04-05T07:00:00.000 [Asia/Ho_Chi_Minh]",
    );
  });
});

describe("logTraceStorage", () => {
  it("prefixes log lines with traceId in context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logTraceStorage.run({ traceId: "upd-1-deadbeef" }, () => {
      logInfo("hello");
    });
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("traceId=upd-1-deadbeef");
    expect(line).toContain("hello");
    spy.mockRestore();
  });
});

describe("dailyLogFilePath", () => {
  it("inserts YYYY-MM-DD before .log", () => {
    const p = dailyLogFilePath("/var/app/logs/deepclaw.log");
    expect(p).toMatch(/\/deepclaw-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it("adds .log when base has no extension", () => {
    const p = dailyLogFilePath("/tmp/deepclaw");
    expect(p).toMatch(/deepclaw-\d{4}-\d{2}-\d{2}\.log$/);
  });
});
