import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { AppConfig } from "../config.js";
import { BrowserSession } from "./browser.js";
import { shellCommandLooksLikeBlockingServer, ToolExecutor } from "./executor.js";

function executorTestConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: "/tmp/deepclaw-exec-test",
    deepseekApiKey: "k",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    telegramBotToken: "t",
    agentMaxSteps: 8,
    shellEnabled: true,
    shellAllowlist: [],
    workdir: "/tmp",
    browserEnabled: false,
    browserAllowlist: [],
    browserTimeoutMs: 30_000,
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
    remindersFilePath: "/tmp/deepclaw-exec-test-reminders.json",
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
    browserResolveDns: true,
    imageFetchUserAgent: "",
    sendImageFetchMode: "http",
    imageFetchReferrerPolicy: "same-origin",
    longTermMemoryEnabled: false,
    longTermMemoryDir: "/tmp/deepclaw-exec-test/ltm",
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

describe("shellCommandLooksLikeBlockingServer", () => {
  it("matches typical dev-server commands without background", () => {
    expect(shellCommandLooksLikeBlockingServer("npm run dev")).toBe(true);
    expect(shellCommandLooksLikeBlockingServer("npx vite")).toBe(true);
    expect(shellCommandLooksLikeBlockingServer("python3 -m http.server 8000")).toBe(true);
  });

  it("does not match when nohup, trailing &, or mid-command & then more steps", () => {
    expect(shellCommandLooksLikeBlockingServer("nohup npm run dev")).toBe(false);
    expect(shellCommandLooksLikeBlockingServer("npm run dev &")).toBe(false);
    expect(shellCommandLooksLikeBlockingServer("npm run dev; &")).toBe(false);
    expect(
      shellCommandLooksLikeBlockingServer(
        "python3 -m http.server 8000 > /tmp/l.log 2>&1 & sleep 1 && curl localhost:8000/",
      ),
    ).toBe(false);
  });
});

const describePosix =
  process.platform === "win32"
    ? describe.skip
    : describe;

describe("write_file <dataDir>/workspace gate", () => {
  it("rejects writes outside <dataDir>/workspace (full container mode)", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-dd-"));
    await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
    const outside = path.join(os.tmpdir(), `dc-wf-out-${Date.now()}.html`);
    const config = executorTestConfig({
      dataDir,
      workdir: await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-other-wd-")),
      fullContainerAccess: true,
    });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const msg = await ex.execute("write_file", {
      path: outside,
      content: "<html/>",
    });
    expect(msg).toContain("write_file");
    expect(msg).toContain("workspace");
    await fs.rm(dataDir, { recursive: true });
    await fs.rm(config.workdir, { recursive: true });
  });

  it("rejects writes elsewhere under data-dir (not in workspace subfolder)", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-dd-"));
    await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
    const notesDir = path.join(dataDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
    const config = executorTestConfig({ dataDir, fullContainerAccess: true });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const msg = await ex.execute("write_file", {
      path: path.join(notesDir, "notes.txt"),
      content: "x",
    });
    expect(msg).toContain("workspace");
    await fs.rm(dataDir, { recursive: true });
  });

  it("allows writes under <dataDir>/workspace when workdir differs", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-dd-"));
    const ws = path.join(dataDir, "workspace");
    await fs.mkdir(ws, { recursive: true });
    const otherWd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-other-wd-"));
    const config = executorTestConfig({
      dataDir,
      workdir: otherWd,
      fullContainerAccess: true,
    });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const msg = await ex.execute("write_file", {
      path: "hello.ts",
      content: "// ok",
    });
    expect(msg).toMatch(/Wrote/);
    const st = await fs.stat(path.join(ws, "hello.ts"));
    expect(st.isFile()).toBe(true);
    await fs.rm(dataDir, { recursive: true });
    await fs.rm(otherWd, { recursive: true });
  });

  it("rejects non-html absolute path outside <dataDir>/workspace in full mode", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-dd-"));
    await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
    const outside = path.join(os.tmpdir(), `dc-wf-txt-${Date.now()}.txt`);
    const config = executorTestConfig({
      dataDir,
      workdir: await fs.mkdtemp(path.join(os.tmpdir(), "dc-wf-wd-")),
      fullContainerAccess: true,
    });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const msg = await ex.execute("write_file", {
      path: outside,
      content: "x",
    });
    expect(msg).toContain("write_file");
    expect(msg).toContain("workspace");
    await fs.rm(dataDir, { recursive: true });
    await fs.rm(config.workdir, { recursive: true });
  });
});

describePosix("ToolExecutor run_shell wall timeout", () => {
  it("rejects commands with absolute paths outside <dataDir>/workspace", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-sh-sandbox-"));
    await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
    const config = executorTestConfig({
      dataDir,
      shellEnabled: true,
      shellApprovalMode: "off",
      fullContainerAccess: true,
    });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const msg = await ex.execute("run_shell", { command: "echo x > /tmp/forbidden.txt" });
    expect(msg).toContain("run_shell rejected");
    expect(msg).toContain("/tmp/forbidden.txt");
    await fs.rm(dataDir, { recursive: true });
  });

  it("stops a long sleep before the default shell timeout and explains the limit", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-sh-timeout-"));
    await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
    const config = executorTestConfig({
      dataDir,
      shellTimeoutMs: 900,
      shellBlockingTimeoutMs: 800,
    });
    const ex = new ToolExecutor(config, new BrowserSession(config));
    const started = Date.now();
    const out = await ex.execute("run_shell", { command: "sleep 60" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    expect(out).toContain("run_shell time limit");
    expect(out).toMatch(/subprocess signal: SIG(TERM|KILL)/);
    await fs.rm(dataDir, { recursive: true });
  }, 20_000);
});
