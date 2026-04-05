import { describe, it, expect } from "vitest";
import { assertBrowseWebUrl } from "./browser.js";
import { buildToolDefinitions } from "./registry.js";
import type { AppConfig } from "../config.js";

function baseConfig(over: Partial<AppConfig>): AppConfig {
  return {
    dataDir: "/tmp/deepclaw-test-data",
    deepseekApiKey: "k",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    telegramBotToken: "t",
    agentMaxSteps: 8,
    shellEnabled: false,
    shellAllowlist: [],
    workdir: "/tmp",
    browserEnabled: false,
    browserAllowlist: [],
    browserTimeoutMs: 30_000,
    browserMaxContentChars: 1000,
    allowedUserIds: [],
    personalityFilePath: "",
    fullContainerAccess: false,
    safeMode: true,
    planningEnabled: true,
    planningPlanMaxTokens: 768,
    planningReviewMaxTokens: 512,
    planningReviewEnabled: true,
    logFilePath: "",
    llmTimeoutMs: 180_000,
    chatHistoryDir: "",
    remindersFilePath: "/tmp/deepclaw-registry-test-reminders.json",
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
    longTermMemoryEnabled: false,
    longTermMemoryDir: "/tmp/deepclaw-test-data/ltm",
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

describe("buildToolDefinitions", () => {
  it("includes read_file always", () => {
    const tools = buildToolDefinitions(baseConfig({}));
    expect(tools.some((t) => t.type === "function" && t.function.name === "read_file")).toBe(true);
  });

  it("includes send_file always", () => {
    const tools = buildToolDefinitions(baseConfig({}));
    expect(tools.some((t) => t.type === "function" && t.function.name === "send_file")).toBe(true);
  });

  it("includes workspace tools write_file list_dir grep_workspace", () => {
    const tools = buildToolDefinitions(baseConfig({}));
    expect(tools.some((t) => t.type === "function" && t.function.name === "write_file")).toBe(true);
    expect(tools.some((t) => t.type === "function" && t.function.name === "list_dir")).toBe(true);
    expect(tools.some((t) => t.type === "function" && t.function.name === "grep_workspace")).toBe(
      true,
    );
  });

  it("includes run_shell when shell enabled (full profile)", () => {
    const tools = buildToolDefinitions(
      baseConfig({
        shellEnabled: true,
        safeMode: false,
        fullContainerAccess: true,
      }),
    );
    expect(tools.some((t) => t.type === "function" && t.function.name === "run_shell")).toBe(true);
  });

  it("describes run_shell with full access", () => {
    const tools = buildToolDefinitions(
      baseConfig({
        shellEnabled: true,
        safeMode: false,
        fullContainerAccess: true,
      }),
    );
    const runShell = tools.find(
      (t) => t.type === "function" && t.function.name === "run_shell",
    );
    expect(runShell?.type === "function" && runShell.function.description).toMatch(/nohup|workspace/i);
  });

  it("omits run_shell and browse_web in safe mode", () => {
    const tools = buildToolDefinitions(baseConfig({ safeMode: true, shellEnabled: false, browserEnabled: false }));
    expect(tools.some((t) => t.type === "function" && t.function.name === "run_shell")).toBe(false);
    expect(tools.some((t) => t.type === "function" && t.function.name === "browse_web")).toBe(false);
    expect(tools.some((t) => t.type === "function" && t.function.name === "send_image_url")).toBe(
      false,
    );
  });

  it("includes send_image_url when browser is enabled (full)", () => {
    const tools = buildToolDefinitions(
      baseConfig({
        safeMode: false,
        browserEnabled: true,
        fullContainerAccess: true,
      }),
    );
    expect(tools.some((t) => t.type === "function" && t.function.name === "send_image_url")).toBe(
      true,
    );
  });
});

describe("assertBrowseWebUrl", () => {
  const fullBrowser = baseConfig({
    safeMode: false,
    browserEnabled: true,
    fullContainerAccess: true,
    browserAllowlist: [],
    browserResolveDns: false,
  });

  it("rejects when browser is disabled", async () => {
    const r = await assertBrowseWebUrl(
      "https://example.com/a.jpg",
      baseConfig({ browserEnabled: false }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disabled|safe/i);
  });

  it("rejects loopback URL", async () => {
    const r = await assertBrowseWebUrl("http://127.0.0.1/x.png", fullBrowser);
    expect(r.ok).toBe(false);
  });

  it("accepts public https URL when full access and empty allowlist", async () => {
    const r = await assertBrowseWebUrl("https://example.com/img.png", fullBrowser);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
  });

  it("rejects URL when allowlist is set and host not listed", async () => {
    const r = await assertBrowseWebUrl(
      "https://evil.test/p.jpg",
      baseConfig({
        safeMode: false,
        browserEnabled: true,
        fullContainerAccess: false,
        browserAllowlist: ["example.com"],
        browserResolveDns: false,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/allowlist/i);
  });
});
