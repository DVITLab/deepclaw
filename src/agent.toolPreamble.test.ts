import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./llm/chatCompletion.js", () => ({
  createChatCompletionWithRetry: vi.fn(),
}));

import type { ChatCompletion } from "openai/resources/chat/completions";
import OpenAI from "openai";
import { createChatCompletionWithRetry } from "./llm/chatCompletion.js";
import { AgentService, toolRoundPreambleForUser } from "./agent.js";
import { BrowserSession } from "./tools/browser.js";
import type { AppConfig } from "./config.js";
import { formatReplyForChat } from "./util/plainText.js";

function agentTestConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp/deepclaw-agent-preamble-test",
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
    planningEnabled: false,
    planningPlanMaxTokens: 768,
    planningReviewMaxTokens: 512,
    planningReviewEnabled: true,
    logFilePath: "",
    llmTimeoutMs: 180_000,
    chatHistoryDir: "",
    remindersFilePath: "/tmp/deepclaw-preamble-reminders.json",
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
    longTermMemoryDir: "/tmp/deepclaw-agent-preamble-test/ltm",
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

function completionWithTools(
  content: string,
  toolName: string,
  args: Record<string, unknown>,
): ChatCompletion {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  } as ChatCompletion;
}

function completionText(text: string): ChatCompletion {
  return {
    choices: [
      {
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  } as ChatCompletion;
}

describe("toolRoundPreambleForUser", () => {
  it("returns null for empty or non-string", () => {
    expect(toolRoundPreambleForUser(null)).toBeNull();
    expect(toolRoundPreambleForUser(undefined)).toBeNull();
    expect(toolRoundPreambleForUser("")).toBeNull();
    expect(toolRoundPreambleForUser("   ")).toBeNull();
  });

  it("applies formatReplyForChat", () => {
    const raw = "Will check **`file`** now.";
    const out = toolRoundPreambleForUser(raw);
    expect(out).toBe(formatReplyForChat(raw));
    expect(out).not.toContain("**");
  });
});

describe("runTurn tool preamble hook", () => {
  const mocked = vi.mocked(createChatCompletionWithRetry);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onAssistantToolPreamble once with formatted text on first tool round", async () => {
    mocked
      .mockResolvedValueOnce(
        completionWithTools("Will read the file.", "read_file", { path: "missing.txt" }),
      )
      .mockResolvedValueOnce(completionText("File not found."));

    const preamble = vi.fn();
    const client = new OpenAI({ apiKey: "test" });
    const config = agentTestConfig();
    const browser = new BrowserSession(config);
    const agent = new AgentService(client, config, browser);

    await agent.runTurn("c1", "hello", {
      hooks: { onAssistantToolPreamble: preamble },
    });

    expect(preamble).toHaveBeenCalledTimes(1);
    expect(preamble).toHaveBeenCalledWith(formatReplyForChat("Will read the file."));
  });

  it("does not call preamble when telegramToolPreambleEnabled is false", async () => {
    mocked
      .mockResolvedValueOnce(
        completionWithTools("Will read the file.", "read_file", { path: "missing.txt" }),
      )
      .mockResolvedValueOnce(completionText("Missing."));

    const preamble = vi.fn();
    const client = new OpenAI({ apiKey: "test" });
    const config = agentTestConfig({ telegramToolPreambleEnabled: false });
    const browser = new BrowserSession(config);
    const agent = new AgentService(client, config, browser);

    await agent.runTurn("c2", "hello", {
      hooks: { onAssistantToolPreamble: preamble },
    });

    expect(preamble).not.toHaveBeenCalled();
  });

  it("calls preamble only on first tool round when later rounds also have content", async () => {
    mocked
      .mockResolvedValueOnce(
        completionWithTools("Round one.", "read_file", { path: "a.txt" }),
      )
      .mockResolvedValueOnce(
        completionWithTools("Round two.", "read_file", { path: "b.txt" }),
      )
      .mockResolvedValueOnce(completionText("Done."));

    const preamble = vi.fn();
    const client = new OpenAI({ apiKey: "test" });
    const config = agentTestConfig();
    const browser = new BrowserSession(config);
    const agent = new AgentService(client, config, browser);

    await agent.runTurn("c3", "hello", {
      hooks: { onAssistantToolPreamble: preamble },
    });

    expect(preamble).toHaveBeenCalledTimes(1);
    expect(preamble).toHaveBeenCalledWith(formatReplyForChat("Round one."));
  });
});
