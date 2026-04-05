import { describe, it, expect } from "vitest";
import type { AppConfig } from "../config.js";
import { formatBotHelp, formatBotStatus, readPackageVersion } from "./botStatus.js";

function minimalConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp",
    deepseekApiKey: "",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    telegramBotToken: "",
    agentMaxSteps: 16,
    shellEnabled: true,
    shellAllowlist: [],
    workdir: "/tmp/w",
    browserEnabled: true,
    browserAllowlist: [],
    browserTimeoutMs: 30_000,
    browserMaxContentChars: 12_000,
    allowedUserIds: [],
    personalityFilePath: "",
    fullContainerAccess: true,
    safeMode: false,
    planningEnabled: true,
    planningPlanMaxTokens: 768,
    planningReviewMaxTokens: 512,
    planningReviewEnabled: true,
    logFilePath: "",
    llmTimeoutMs: 180_000,
    chatHistoryDir: "/tmp/ch",
    remindersFilePath: "/tmp/r.json",
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
    shellApprovalMode: "dangerous",
    shellTimeoutMs: 120_000,
    shellBlockingTimeoutMs: 45_000,
    browserResolveDns: true,
    imageFetchUserAgent: "",
    sendImageFetchMode: "http",
    imageFetchReferrerPolicy: "same-origin",
    longTermMemoryEnabled: true,
    longTermMemoryDir: "/tmp/ltm",
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

describe("readPackageVersion", () => {
  it("reads version from cwd package.json", () => {
    const v = readPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("formatBotStatus", () => {
  it("includes model and safe vs full profile", () => {
    const full = formatBotStatus(minimalConfig({ safeMode: false, deepseekModel: "m-full" }));
    expect(full).toContain("m-full");
    expect(full).toContain("full");

    const safe = formatBotStatus(minimalConfig({ safeMode: true, deepseekModel: "m-safe" }));
    expect(safe).toContain("m-safe");
    expect(safe).toContain("safe");
  });
});

describe("formatBotHelp", () => {
  it("describes natural-language use without slash commands", () => {
    const h = formatBotHelp();
    expect(h.toLowerCase()).toContain("no slash");
    expect(h).toMatch(/stop|dừng/i);
  });
});
