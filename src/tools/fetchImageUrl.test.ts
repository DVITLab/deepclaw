import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { BROWSE_WEB_USER_AGENT } from "./browser.js";
import { CHROME_COMPAT_UA, downloadImageToTempFile } from "./fetchImageUrl.js";

function imgFetchConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp/deepclaw-img-fetch-test",
    deepseekApiKey: "k",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    telegramBotToken: "t",
    agentMaxSteps: 8,
    shellEnabled: true,
    shellAllowlist: [],
    workdir: "/tmp",
    browserEnabled: true,
    browserAllowlist: [],
    browserTimeoutMs: 15_000,
    browserMaxContentChars: 1000,
    allowedUserIds: [],
    personalityFilePath: "",
    fullContainerAccess: true,
    safeMode: false,
    planningEnabled: false,
    planningPlanMaxTokens: 768,
    planningReviewMaxTokens: 512,
    planningReviewEnabled: true,
    logFilePath: "",
    llmTimeoutMs: 180_000,
    chatHistoryDir: "",
    remindersFilePath: "/tmp/deepclaw-img-fetch-reminders.json",
    appTimeZone: "UTC",
    ocrLanguages: "eng",
    voiceTranscriptionMode: "on",
    whisperModel: "tiny",
    whisperDevice: "cpu",
    whisperComputeType: "int8",
    whisperPython: "",
    whisperTimeoutMs: 120_000,
    chatHistoryMaxMessages: 48,
    llmMaxRetries: 3,
    rollingSummaryEnabled: true,
    rollingSummaryMinMessages: 40,
    rollingSummaryTail: 24,
    historyToolMaxChars: 0,
    historyToolFullWindow: 16,
    shellApprovalMode: "off",
    shellTimeoutMs: 120_000,
    shellBlockingTimeoutMs: 45_000,
    browserResolveDns: false,
    imageFetchUserAgent: "",
    sendImageFetchMode: "http",
    imageFetchReferrerPolicy: "same-origin",
    longTermMemoryEnabled: false,
    longTermMemoryDir: "/tmp/deepclaw-img-fetch-test/ltm",
    maxIncomingMessageChars: 32_768,
    chatCooldownMs: 0,
    runTestsToolEnabled: false,
    maxPendingTurnsPerChat: 8,
    shutdownTimeoutMs: 30_000,
    healthCheckPort: 7587,
    healthCheckHost: "127.0.0.1",
    llmCircuitEnabled: true,
    llmCircuitFailureThreshold: 5,
    llmCircuitOpenMs: 60_000,
    userMessageCooldownMs: 0,
    telegramToolPreambleEnabled: true,
    telegramReplyStreaming: false,
    ...over,
  };
}

/** Minimal bytes that pass isLikelyImageBuffer with image/jpeg. */
const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x00]);

describe("downloadImageToTempFile HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Referer origin and Accept-Language on first fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(tinyJpeg, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = imgFetchConfig();
    const r = await downloadImageToTempFile("https://example.com/photo.jpg", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) await fs.unlink(r.filePath);
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = new Headers(init.headers);
    expect(h.get("Referer")).toBe("https://example.com/");
    expect(h.get("Accept-Language")).toMatch(/en/);
    expect(h.get("User-Agent")).toBe(BROWSE_WEB_USER_AGENT);
  });

  it("omits Referer when imageFetchReferrerPolicy is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(tinyJpeg, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = imgFetchConfig({ imageFetchReferrerPolicy: "off" });
    const r = await downloadImageToTempFile("https://example.org/x.jpg", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) await fs.unlink(r.filePath);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = new Headers(init.headers);
    expect(h.get("Referer")).toBeNull();
  });

  it("retries with Chrome-like UA after 403 then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      n += 1;
      if (n === 1) {
        return Promise.resolve(new Response("no", { status: 403 }));
      }
      return Promise.resolve(
        new Response(tinyJpeg, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = imgFetchConfig();
    const r = await downloadImageToTempFile("https://example.com/a.jpg", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) await fs.unlink(r.filePath);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const h2 = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(h2.get("User-Agent")).toBe(CHROME_COMPAT_UA);
  });

  it("uses custom DEEPCLAW_IMAGE_FETCH_USER_AGENT on first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(tinyJpeg, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = imgFetchConfig({ imageFetchUserAgent: "MyBot/2" });
    const r = await downloadImageToTempFile("https://example.com/b.jpg", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) await fs.unlink(r.filePath);
    const h = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(h.get("User-Agent")).toBe("MyBot/2");
  });

  it("includes response snippet in HTTP error message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>blocked</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = imgFetchConfig();
    const r = await downloadImageToTempFile("https://example.com/c.jpg", cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("HTTP 403");
      expect(r.error.toLowerCase()).toMatch(/blocked|snippet|html/);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
