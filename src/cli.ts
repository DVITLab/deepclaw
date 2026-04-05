import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import "dotenv/config";
import { loadConfig, validateTelegramConfig } from "./config.js";
import { createDeepSeekClient } from "./llm/deepseek.js";
import { BrowserSession } from "./tools/browser.js";
import { AgentService } from "./agent.js";
import { runTelegramChannel } from "./channels/telegram.js";
import { agentProjectWorkspaceRoot } from "./util/agentProjectWorkspace.js";
import { ensureAgentWorkspace } from "./workspace.js";
import { configureLogging, dailyLogFilePath } from "./util/logger.js";
import { assertContainerRequired } from "./util/containerContext.js";
import { startHealthServer } from "./util/healthServer.js";
import { initLlmCircuit } from "./util/llmCircuitBreaker.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("deepclaw").description("Deepclaw Telegram agent");

  program
    .command("doctor")
    .description("Print config status (no secrets)")
    .action(() => {
      assertContainerRequired("deepclaw doctor");
      const c = loadConfig();
      console.log("DEEPSEEK_API_KEY:", c.deepseekApiKey ? "set" : "missing");
      console.log("DEEPSEEK_BASE_URL:", c.deepseekBaseUrl);
      console.log("DEEPSEEK_MODEL:", c.deepseekModel);
      console.log("TELEGRAM_BOT_TOKEN:", c.telegramBotToken ? "set" : "missing");
      console.log("Resolved data directory:", c.dataDir);
      console.log(
        "DEEPCLAW_DATA_DIR:",
        process.env.DEEPCLAW_DATA_DIR?.trim() || "(unset → ./agent-data under cwd)",
      );
      console.log("Resolved agent workspace:", c.workdir);
      console.log(
        "DEEPCLAW_WORKSPACE:",
        process.env.DEEPCLAW_WORKSPACE?.trim() || "(unset → <data-dir>/workspace)",
      );
      console.log(
        "DEEPCLAW_WORKDIR (legacy fallback):",
        process.env.DEEPCLAW_WORKDIR?.trim() || "(unset)",
      );
      console.log("DEEPCLAW_AGENT_MAX_STEPS:", c.agentMaxSteps);
      console.log(
        "DEEPCLAW_PLANNING:",
        c.planningEnabled
          ? "on (LLM gate → plan/review/execute or direct tool loop)"
          : "off (direct tool loop only)",
      );
      console.log("DEEPCLAW_PLANNING_PLAN_MAX_TOKENS:", c.planningPlanMaxTokens);
      console.log("DEEPCLAW_PLANNING_REVIEW_MAX_TOKENS:", c.planningReviewMaxTokens);
      console.log(
        "DEEPCLAW_PLANNING_REVIEW:",
        c.planningReviewEnabled
          ? "on (separate review completion after plan)"
          : "off (plan → execute; saves one LLM call)",
      );
      console.log(
        "DEEPCLAW_TELEGRAM_STREAMING:",
        c.telegramReplyStreaming ? "on" : "off",
      );
      const rawSafe = process.env.DEEPCLAW_SAFE_MODE?.trim();
      console.log(
        "DEEPCLAW_SAFE_MODE:",
        rawSafe !== undefined && rawSafe !== ""
          ? rawSafe
          : "(unset: full — run_shell / browse_web; set 1 or true for safe profile)",
      );
      console.log(
        "Profile:",
        c.safeMode
          ? "safe — read_file only under workspace (no run_shell / browse_web / send_image_url)"
          : "full — run_shell, browse_web, send_image_url (Telegram photos), read_file under <data-dir>/workspace",
      );
      console.log(
        "browse_web + send_image_url:",
        c.browserEnabled ? "on" : "off (safe mode disables both)",
      );
      console.log(
        "DEEPCLAW_ALLOWED_USER_IDS:",
        c.allowedUserIds.length ? c.allowedUserIds.join(", ") : "(all)",
      );
      console.log("Resolved personality file:", c.personalityFilePath);
      console.log(
        "DEEPCLAW_LOG_FILE (base, daily rotation):",
        c.logFilePath || "(file logging off)",
      );
      if (c.logFilePath) {
        console.log("Today's log file:", dailyLogFilePath(c.logFilePath));
      }
      console.log("DEEPCLAW_LLM_TIMEOUT_MS:", c.llmTimeoutMs);
      console.log(
        "DEEPCLAW_CHAT_HISTORY_DIR (env):",
        process.env.DEEPCLAW_CHAT_HISTORY_DIR?.trim() || "(unset → <data-dir>/chat-history)",
      );
      console.log("Resolved chat history dir:", c.chatHistoryDir || "(persistence off)");
      console.log(
        "DEEPCLAW_CHAT_HISTORY_MAX_MESSAGES (env):",
        process.env.DEEPCLAW_CHAT_HISTORY_MAX_MESSAGES?.trim() || "(unset → 48)",
      );
      console.log("Resolved chat history max messages:", c.chatHistoryMaxMessages);
      console.log(
        "DEEPCLAW_LLM_MAX_RETRIES (env):",
        process.env.DEEPCLAW_LLM_MAX_RETRIES?.trim() || "(unset → 3)",
      );
      console.log("Resolved LLM max retries:", c.llmMaxRetries);
      console.log(
        "DEEPCLAW_BROWSER_ALLOWLIST (env):",
        process.env.DEEPCLAW_BROWSER_ALLOWLIST?.trim() || "(unset → allow all public hosts per browse_web rules)",
      );
      console.log(
        "Resolved browse_web host allowlist entries:",
        c.browserAllowlist.length ? c.browserAllowlist.join(", ") : "(empty — not using hostname allowlist)",
      );
      console.log(
        "DEEPCLAW_BROWSER_RESOLVE_DNS (env):",
        process.env.DEEPCLAW_BROWSER_RESOLVE_DNS?.trim() || "(unset → auto/on)",
      );
      console.log("Resolved browse_web DNS/private-IP check:", c.browserResolveDns ? "on" : "off");
      console.log(
        "DEEPCLAW_IMAGE_FETCH_USER_AGENT (env):",
        process.env.DEEPCLAW_IMAGE_FETCH_USER_AGENT?.trim() || "(unset → default bot UA on first attempt)",
      );
      console.log("Resolved send_image_url first-attempt User-Agent:", c.imageFetchUserAgent || "(default bot UA)");
      console.log(
        "DEEPCLAW_SEND_IMAGE_FETCH_MODE (env):",
        process.env.DEEPCLAW_SEND_IMAGE_FETCH_MODE?.trim() || "(unset → http)",
      );
      console.log("Resolved send_image_url fetch mode:", c.sendImageFetchMode);
      console.log(
        "DEEPCLAW_IMAGE_FETCH_REFERER (env):",
        process.env.DEEPCLAW_IMAGE_FETCH_REFERER?.trim() || "(unset → same-origin Referer)",
      );
      console.log("Resolved image fetch Referer policy:", c.imageFetchReferrerPolicy);
      console.log(
        "DEEPCLAW_SHELL_APPROVAL (env):",
        process.env.DEEPCLAW_SHELL_APPROVAL?.trim() || "(unset → on, risky commands only)",
      );
      console.log("Resolved shell approval mode:", c.shellApprovalMode);
      console.log(
        "DEEPCLAW_SHELL_TIMEOUT_MS (env):",
        process.env.DEEPCLAW_SHELL_TIMEOUT_MS?.trim() || "(unset → 120000; clamped 15000–600000)",
      );
      console.log("Resolved run_shell max wall time ms:", c.shellTimeoutMs);
      console.log(
        "DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS (env):",
        process.env.DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS?.trim() ||
          "(unset → 45000; clamped ≤ shell timeout, min 5000)",
      );
      console.log("Resolved run_shell blocking-heuristic cap ms:", c.shellBlockingTimeoutMs);
      console.log(
        "DEEPCLAW_LONG_TERM_MEMORY (env):",
        process.env.DEEPCLAW_LONG_TERM_MEMORY?.trim() ||
          (c.safeMode ? "(unset → off in safe mode)" : "(unset → on in full profile)"),
      );
      console.log("Long-term memory tools:", c.longTermMemoryEnabled ? "on" : "off");
      console.log("Resolved long-term memory dir:", c.longTermMemoryDir);
      console.log(
        "DEEPCLAW_MAX_MESSAGE_CHARS (env):",
        process.env.DEEPCLAW_MAX_MESSAGE_CHARS?.trim() || "(unset → 32768; 0 = no limit)",
      );
      console.log("Resolved max incoming message chars:", c.maxIncomingMessageChars || "(no limit)");
      console.log(
        "DEEPCLAW_CHAT_COOLDOWN_MS (env):",
        process.env.DEEPCLAW_CHAT_COOLDOWN_MS?.trim() || "(unset → 0 = off)",
      );
      console.log("Resolved chat cooldown ms:", c.chatCooldownMs);
      console.log(
        "DEEPCLAW_RUN_TESTS_TOOL (env):",
        process.env.DEEPCLAW_RUN_TESTS_TOOL?.trim() ||
          (c.safeMode ? "(unset → off in safe mode)" : "(unset → on in full profile)"),
      );
      console.log("run_tests tool:", c.runTestsToolEnabled ? "on" : "off");
      console.log(
        "DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT (env):",
        process.env.DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT?.trim() ||
          "(unset → 8; 0 = unlimited)",
      );
      console.log("Resolved max pending turns per chat:", c.maxPendingTurnsPerChat || "(unlimited)");
      console.log("DEEPCLAW_SHUTDOWN_TIMEOUT_MS:", c.shutdownTimeoutMs);
      console.log(
        "DEEPCLAW_HEALTH_PORT (env):",
        process.env.DEEPCLAW_HEALTH_PORT?.trim() || "(unset → 7587; 0 = off)",
      );
      console.log(
        "Health check:",
        c.healthCheckPort > 0
          ? `http://${c.healthCheckHost}:${c.healthCheckPort}/health`
          : "off",
      );
      console.log(
        "DEEPCLAW_LLM_CIRCUIT (env):",
        process.env.DEEPCLAW_LLM_CIRCUIT?.trim() || "(unset → on)",
      );
      console.log("LLM circuit:", c.llmCircuitEnabled ? "on" : "off");
      console.log("DEEPCLAW_LLM_CIRCUIT_FAILURE_THRESHOLD:", c.llmCircuitFailureThreshold);
      console.log("DEEPCLAW_LLM_CIRCUIT_OPEN_MS:", c.llmCircuitOpenMs);
      console.log(
        "DEEPCLAW_USER_MESSAGE_COOLDOWN_MS (env):",
        process.env.DEEPCLAW_USER_MESSAGE_COOLDOWN_MS?.trim() || "(unset → 0 = off)",
      );
      console.log("Resolved user message cooldown ms:", c.userMessageCooldownMs);
      console.log(
        "DEEPCLAW_TELEGRAM_TOOL_PREAMBLE (env):",
        process.env.DEEPCLAW_TELEGRAM_TOOL_PREAMBLE?.trim() ||
          "(unset → on: first tool-round assistant text may be sent early on Telegram)",
      );
      console.log(
        "Telegram tool-round preamble:",
        c.telegramToolPreambleEnabled ? "on" : "off",
      );
      console.log(
        "DEEPCLAW_ROLLING_SUMMARY (env):",
        process.env.DEEPCLAW_ROLLING_SUMMARY?.trim() || "(unset → on)",
      );
      console.log("Resolved rolling summary:", c.rollingSummaryEnabled ? "on" : "off");
      if (c.rollingSummaryEnabled) {
        console.log("DEEPCLAW_ROLLING_SUMMARY_MIN_MESSAGES:", c.rollingSummaryMinMessages);
        console.log("DEEPCLAW_ROLLING_SUMMARY_TAIL:", c.rollingSummaryTail);
      }
      console.log(
        "DEEPCLAW_HISTORY_TOOL_MAX_CHARS:",
        c.historyToolMaxChars || "(0 = no truncation)",
      );
      console.log("DEEPCLAW_HISTORY_TOOL_FULL_WINDOW:", c.historyToolFullWindow);
      console.log(
        "DEEPCLAW_OCR_LANGS (env):",
        process.env.DEEPCLAW_OCR_LANGS?.trim() || "(unset → eng)",
      );
      console.log("Resolved OCR languages (Tesseract):", c.ocrLanguages);
      console.log(
        "DEEPCLAW_VOICE_TRANSCRIPTION (env):",
        process.env.DEEPCLAW_VOICE_TRANSCRIPTION?.trim() || "(unset → on)",
      );
      console.log("Resolved voice mode:", c.voiceTranscriptionMode);
      console.log(
        "Voice transcription:",
        c.voiceTranscriptionMode === "off"
          ? "off"
          : c.voiceTranscriptionMode === "auto"
            ? "auto (faster-whisper probed once at bot startup — not during doctor)"
            : "on (always attempt transcribe)",
      );
      if (c.voiceTranscriptionMode !== "off") {
        console.log("DEEPCLAW_WHISPER_MODEL:", c.whisperModel);
        console.log("DEEPCLAW_WHISPER_DEVICE:", c.whisperDevice);
        console.log("DEEPCLAW_WHISPER_COMPUTE_TYPE:", c.whisperComputeType);
        console.log(
          "DEEPCLAW_WHISPER_PYTHON:",
          c.whisperPython.trim() || "(default: python3 on PATH)",
        );
        console.log("DEEPCLAW_WHISPER_TIMEOUT_MS:", c.whisperTimeoutMs);
      }
      console.log("Reminders file:", c.remindersFilePath);
      console.log(
        "DEEPCLAW_TZ (env):",
        process.env.DEEPCLAW_TZ?.trim() || "(unset → UTC)",
      );
      console.log("Resolved app timezone:", c.appTimeZone);
      console.log("process.env.TZ:", process.env.TZ?.trim() || "(unset)");
      const err = validateTelegramConfig(c);
      if (err) {
        console.log("Required for `deepclaw run` (not for doctor output above):", err);
      } else {
        console.log("Required API keys: ok (both set).");
      }
    });

  program
    .command("run")
    .description("Run the bot (blocking)")
    .option("--channel <name>", "channel", "telegram")
    .action(async (opts: { channel: string }) => {
      assertContainerRequired("deepclaw run");
      const config = loadConfig();
      if (opts.channel !== "telegram") {
        throw new Error(`Unknown channel: ${opts.channel}`);
      }
      const err = validateTelegramConfig(config);
      if (err) {
        throw new Error(err);
      }
      configureLogging(config.logFilePath);
      initLlmCircuit(config);
      if (config.healthCheckPort > 0) {
        startHealthServer(config.healthCheckHost, config.healthCheckPort);
      }
      ensureAgentWorkspace(agentProjectWorkspaceRoot(config.dataDir));
      if (path.resolve(config.workdir) !== agentProjectWorkspaceRoot(config.dataDir)) {
        ensureAgentWorkspace(config.workdir);
      }
      if (config.longTermMemoryEnabled) {
        fs.mkdirSync(config.longTermMemoryDir, { recursive: true });
      }
      const client = createDeepSeekClient(config);
      const browser = new BrowserSession(config);
      const agent = new AgentService(client, config, browser);
      await runTelegramChannel(config, agent, browser, client);
    });

  const args = argv.slice(2);
  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv);
}
