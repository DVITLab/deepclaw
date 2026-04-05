import path from "node:path";

/**
 * CLI (`doctor`, `run`) is container-only — `assertContainerRequired` in cli.ts.
 *
 * Env (all read in `loadConfig`): DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, TELEGRAM_BOT_TOKEN;
 * DEEPCLAW_AGENT_MAX_STEPS, DEEPCLAW_ALLOWED_USER_IDS, DEEPCLAW_BROWSER_MAX_CONTENT_CHARS, DEEPCLAW_BROWSER_TIMEOUT_MS,
 * DEEPCLAW_CHAT_HISTORY_DIR, DEEPCLAW_DATA_DIR, DEEPCLAW_LOG_FILE, DEEPCLAW_LLM_TIMEOUT_MS, DEEPCLAW_OCR_LANGS,
 * DEEPCLAW_PERSONALITY_FILE, DEEPCLAW_PLANNING, DEEPCLAW_PLANNING_PLAN_MAX_TOKENS, DEEPCLAW_PLANNING_REVIEW_MAX_TOKENS,
 * DEEPCLAW_SAFE_MODE, DEEPCLAW_TZ, DEEPCLAW_VOICE_TRANSCRIPTION (on|off|auto), DEEPCLAW_WHISPER_COMPUTE_TYPE,
 * DEEPCLAW_WHISPER_DEVICE, DEEPCLAW_WHISPER_MODEL, DEEPCLAW_WHISPER_PYTHON, DEEPCLAW_WHISPER_TIMEOUT_MS, DEEPCLAW_WORKDIR,
 * DEEPCLAW_WORKSPACE, DEEPCLAW_BROWSER_ALLOWLIST, DEEPCLAW_CHAT_HISTORY_MAX_MESSAGES, DEEPCLAW_LLM_MAX_RETRIES,
 * DEEPCLAW_ROLLING_SUMMARY, DEEPCLAW_ROLLING_SUMMARY_MIN_MESSAGES,
 * DEEPCLAW_ROLLING_SUMMARY_TAIL, DEEPCLAW_HISTORY_TOOL_MAX_CHARS, DEEPCLAW_HISTORY_TOOL_FULL_WINDOW,
 * DEEPCLAW_SHELL_APPROVAL, DEEPCLAW_BROWSER_RESOLVE_DNS, DEEPCLAW_LONG_TERM_MEMORY,
 * DEEPCLAW_MAX_MESSAGE_CHARS, DEEPCLAW_CHAT_COOLDOWN_MS, DEEPCLAW_RUN_TESTS_TOOL,
 * DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT, DEEPCLAW_SHUTDOWN_TIMEOUT_MS, DEEPCLAW_HEALTH_PORT, DEEPCLAW_HEALTH_HOST,
 * DEEPCLAW_LLM_CIRCUIT, DEEPCLAW_LLM_CIRCUIT_FAILURE_THRESHOLD, DEEPCLAW_LLM_CIRCUIT_OPEN_MS,
 * DEEPCLAW_USER_MESSAGE_COOLDOWN_MS, DEEPCLAW_TELEGRAM_TOOL_PREAMBLE,
 * DEEPCLAW_SHELL_TIMEOUT_MS, DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS,
 * DEEPCLAW_IMAGE_FETCH_USER_AGENT, DEEPCLAW_SEND_IMAGE_FETCH_MODE, DEEPCLAW_IMAGE_FETCH_REFERER.
 * Defaults & semantics: README. Reminders file is always `<data-dir>/reminders.json`.
 * Optional product features default **on** (unset); set env to **off** / **0** / **false** only when you do not want them.
 * Ignored if set: DEEPCLAW_CONTAINER_FULL_ACCESS (legacy).
 */

function envString(key: string, defaultValue?: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue ?? "";
  return v;
}

export type VoiceTranscriptionMode = "on" | "off" | "auto";

function parseVoiceTranscriptionMode(): VoiceTranscriptionMode {
  const v = process.env.DEEPCLAW_VOICE_TRANSCRIPTION?.trim().toLowerCase();
  /** Unset = on (feature enabled). Set `off` / `auto` only when you want to disable or probe Whisper at startup. */
  if (v === undefined || v === "") return "on";
  if (v === "0" || v === "false" || v === "no" || v === "off") return "off";
  if (v === "auto") return "auto";
  if (v === "1" || v === "true" || v === "yes" || v === "on") return "on";
  return "on";
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseList(key: string): string[] {
  const v = process.env[key];
  if (!v?.trim()) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseUserIds(key: string): number[] {
  return parseList(key)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Shell confirm via Telegram applies only to heuristic “dangerous” commands — there is no “prompt every shell” mode. */
export type ShellApprovalMode = "off" | "dangerous";

export type SendImageFetchMode = "http" | "playwright" | "auto";

export type ImageFetchReferrerPolicy = "same-origin" | "off";

function parseSendImageFetchMode(): SendImageFetchMode {
  const v = process.env.DEEPCLAW_SEND_IMAGE_FETCH_MODE?.trim().toLowerCase();
  if (v === "playwright") return "playwright";
  if (v === "auto") return "auto";
  return "http";
}

function parseImageFetchReferrerPolicy(): ImageFetchReferrerPolicy {
  const v = process.env.DEEPCLAW_IMAGE_FETCH_REFERER?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return "off";
  if (v === "on" || v === "same-origin" || v === "true" || v === "1") return "same-origin";
  return "same-origin";
}

function parseShellApprovalMode(): ShellApprovalMode {
  const v = process.env.DEEPCLAW_SHELL_APPROVAL?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return "off";
  /** Unset, on, auto, always, etc. → dangerous heuristic only (legacy `always` no longer prompts every command). */
  return "dangerous";
}

/** Default on (auto): resolve hostname and block private IPs (set 0/false/off to skip). */
function parseBrowserResolveDns(): boolean {
  const v = process.env.DEEPCLAW_BROWSER_RESOLVE_DNS?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "auto") return true;
  return !["0", "false", "no", "off"].includes(v);
}

/**
 * Default: full tools when unset (built-in profile). Set DEEPCLAW_SAFE_MODE=1, true, yes, or on for read_file-only safe profile.
 * Docker still sets DEEPCLAW_SAFE_MODE=0 explicitly for clarity.
 */
function resolvedSafeMode(): boolean {
  const v = process.env.DEEPCLAW_SAFE_MODE;
  if (v === undefined || v === "") {
    return false;
  }
  return envBool("DEEPCLAW_SAFE_MODE", false);
}

export interface AppConfig {
  /** Resolved root for local agent data (default chat-history, workspace, logs, reminders.json). */
  dataDir: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  telegramBotToken: string;
  agentMaxSteps: number;
  shellEnabled: boolean;
  shellAllowlist: string[];
  /** Resolved absolute path: agent sandbox for run_shell cwd and read_file root. */
  workdir: string;
  browserEnabled: boolean;
  browserAllowlist: string[];
  browserTimeoutMs: number;
  browserMaxContentChars: number;
  allowedUserIds: number[];
  /** Optional path to a file defining tone, language, and boundaries (personality). */
  personalityFilePath: string;
  /**
   * When true: run_shell allowlist is open (empty = any command subject to path/cwd sandbox).
   * File tools always use <dataDir>/workspace regardless of this flag.
   */
  fullContainerAccess: boolean;
  /** When true: run_shell, browse_web, send_image_url off; file tools still use <dataDir>/workspace only. */
  safeMode: boolean;
  /** When true: optional plan → review → execute path; routing uses an LLM gate (no fixed char threshold). */
  planningEnabled: boolean;
  /** Max completion tokens for the planning phase. */
  planningPlanMaxTokens: number;
  /** Max completion tokens for the review phase. */
  planningReviewMaxTokens: number;
  /**
   * When false: after PLAN, skip the separate REVIEW completion and go straight to execute (saves one LLM round-trip).
   */
  planningReviewEnabled: boolean;
  /**
   * Resolved base path for logs (e.g. .../deepclaw.log). Actual files are daily:
   * deepclaw-YYYY-MM-DD.log in the same directory. Empty or "-" disables file logging.
   */
  logFilePath: string;
  /** Per-request timeout for the OpenAI-compatible HTTP client (ms). */
  llmTimeoutMs: number;
  /**
   * Directory for persisted Telegram chat history (JSON array per chat). Empty string = disabled.
   */
  chatHistoryDir: string;
  /** Absolute path: scheduled Telegram reminders JSON (<data-dir>/reminders.json). */
  remindersFilePath: string;
  /** IANA timezone: from DEEPCLAW_TZ, else UTC. Always synced to `process.env.TZ` in loadConfig. */
  appTimeZone: string;
  /** Tesseract language pack string for photo OCR (e.g. eng or eng+vie). */
  ocrLanguages: string;
  /**
   * Voice notes: default **on** (unset) = always try transcribe. Set **`off`** to disable, **`auto`** to probe once at startup.
   */
  voiceTranscriptionMode: VoiceTranscriptionMode;
  /** faster-whisper model id (default tiny). */
  whisperModel: string;
  /** Whisper device: cpu (default) or cuda. */
  whisperDevice: string;
  /** Whisper CTranslate2 compute type (default int8 on CPU). */
  whisperComputeType: string;
  /** Python binary for whisper script; empty = python3. */
  whisperPython: string;
  /** Max ms for one voice transcription subprocess. */
  whisperTimeoutMs: number;
  /** Max user/assistant/tool messages kept per chat (sliding window). */
  chatHistoryMaxMessages: number;
  /** Retries for chat completion on 429 / 5xx (0 = no retries). */
  llmMaxRetries: number;
  /** Periodically summarize older thread to save tokens. */
  rollingSummaryEnabled: boolean;
  /** Min total messages before rolling summary runs. */
  rollingSummaryMinMessages: number;
  /** Keep this many recent messages verbatim after rolling. */
  rollingSummaryTail: number;
  /** Truncate tool message bodies older than the tail window; 0 = off. */
  historyToolMaxChars: number;
  /** Last N messages keep full tool bodies when historyToolMaxChars > 0. */
  historyToolFullWindow: number;
  /** When `dangerous` (default), only heuristic risky `run_shell` commands await Telegram approval. */
  shellApprovalMode: ShellApprovalMode;
  /** Max ms for `run_shell` (wall clock); subprocess group is killed when exceeded (POSIX). */
  shellTimeoutMs: number;
  /** Shorter cap for commands matching blocking dev-server heuristic (must be <= shellTimeoutMs). */
  shellBlockingTimeoutMs: number;
  /** Resolve browse_web hostnames to IPs and reject private/reserved ranges. */
  browserResolveDns: boolean;
  /**
   * If non-empty, first HTTP attempt for send_image_url uses this User-Agent.
   * Empty = use BROWSE_WEB_USER_AGENT; built-in retries may still use a Chrome-like UA.
   */
  imageFetchUserAgent: string;
  /** How send_image_url fetches bytes: http only, Playwright only, or http then Playwright fallback. */
  sendImageFetchMode: SendImageFetchMode;
  /** Referer header for image HTTP fetch: same-origin (URL origin) or off. */
  imageFetchReferrerPolicy: ImageFetchReferrerPolicy;
  /** Per-chat Markdown notes outside sliding chat history. */
  longTermMemoryEnabled: boolean;
  /** Directory for long-term memory files (<data-dir>/ltm). */
  longTermMemoryDir: string;
  /** 0 = no limit; else max UTF-16 code units per inbound user text (Telegram). */
  maxIncomingMessageChars: number;
  /** 0 = off; min ms between handled user messages per chat (anti double-tap). */
  chatCooldownMs: number;
  /** When true (full profile default), expose run_tests tool with fixed presets. */
  runTestsToolEnabled: boolean;
  /**
   * Max turns queued per chat (including the one running). 0 = unlimited.
   * Prevents unbounded latency when users send many messages quickly.
   */
  maxPendingTurnsPerChat: number;
  /** Ms to wait for in-flight agent turns during shutdown before continuing. */
  shutdownTimeoutMs: number;
  /** 0 = disabled; else listen on this port for GET /health (bind healthHost). */
  healthCheckPort: number;
  /** Bind address for health server (default loopback). */
  healthCheckHost: string;
  /** When true, open circuit after repeated LLM failures (5xx/429/network). */
  llmCircuitEnabled: boolean;
  /** Consecutive failures before circuit opens. */
  llmCircuitFailureThreshold: number;
  /** Ms circuit stays open after tripping. */
  llmCircuitOpenMs: number;
  /** 0 = off; min ms between handled user messages per Telegram user id (all chats). */
  userMessageCooldownMs: number;
  /**
   * When true (default): first assistant message in a tool loop may mirror non-empty `content`
   * to Telegram before tools run (channel hook). Set DEEPCLAW_TELEGRAM_TOOL_PREAMBLE=0 to disable.
   */
  telegramToolPreambleEnabled: boolean;
  /**
   * When true: Telegram shows partial assistant text while the model streams (DEEPCLAW_TELEGRAM_STREAMING=1).
   */
  telegramReplyStreaming: boolean;
}

/** DEEPCLAW_TZ only; no system/Intl fallback (dev default: UTC). */
export function resolveAppTimeZone(): string {
  const v = process.env.DEEPCLAW_TZ?.trim();
  if (v && v !== "-" && v.toLowerCase() !== "none") return v;
  return "UTC";
}

/** Set `process.env.TZ` to the resolved app zone (DEEPCLAW_TZ or UTC). */
export function applyDeepclawProcessTimeZone(): void {
  process.env.TZ = resolveAppTimeZone();
}

function resolveDataDir(cwd: string): string {
  const v = process.env.DEEPCLAW_DATA_DIR?.trim();
  if (v === undefined || v === "") {
    return path.join(cwd, "agent-data");
  }
  return path.isAbsolute(v) ? v : path.resolve(cwd, v);
}

export function loadConfig(): AppConfig {
  applyDeepclawProcessTimeZone();
  const cwd = process.cwd();
  const dataDir = resolveDataDir(cwd);
  const defaultWorkspace = path.join(dataDir, "workspace");
  const workspaceEnv = envString("DEEPCLAW_WORKSPACE", "");
  const workdirLegacy = envString("DEEPCLAW_WORKDIR", "");
  const workdir = path.resolve(
    workspaceEnv || workdirLegacy || defaultWorkspace,
  );

  const defaultPersonalityFile = path.join(cwd, "prompts", "personality.md");
  const defaultLogFile = path.join(dataDir, "logs", "deepclaw.log");
  const defaultChatHistoryDir = path.join(dataDir, "chat-history");
  const safeMode = resolvedSafeMode();
  const full = !safeMode;

  return {
    dataDir,
    deepseekApiKey: envString("DEEPSEEK_API_KEY"),
    deepseekBaseUrl:
      envString("DEEPSEEK_BASE_URL", "https://api.deepseek.com") ||
      "https://api.deepseek.com",
    deepseekModel:
      envString("DEEPSEEK_MODEL", "deepseek-chat") || "deepseek-chat",
    telegramBotToken: envString("TELEGRAM_BOT_TOKEN"),
    agentMaxSteps: Math.min(32, Math.max(1, envInt("DEEPCLAW_AGENT_MAX_STEPS", 16))),
    shellEnabled: full,
    shellAllowlist: [],
    workdir,
    browserEnabled: full,
    browserAllowlist: parseList("DEEPCLAW_BROWSER_ALLOWLIST"),
    browserTimeoutMs: envInt("DEEPCLAW_BROWSER_TIMEOUT_MS", 30_000),
    browserMaxContentChars: envInt(
      "DEEPCLAW_BROWSER_MAX_CONTENT_CHARS",
      12_000,
    ),
    allowedUserIds: parseUserIds("DEEPCLAW_ALLOWED_USER_IDS"),
    personalityFilePath: envString("DEEPCLAW_PERSONALITY_FILE", defaultPersonalityFile),
    fullContainerAccess: full,
    safeMode,
    planningEnabled: envBool("DEEPCLAW_PLANNING", true),
    planningPlanMaxTokens: Math.max(
      64,
      envInt("DEEPCLAW_PLANNING_PLAN_MAX_TOKENS", 768),
    ),
    planningReviewMaxTokens: Math.max(
      64,
      envInt("DEEPCLAW_PLANNING_REVIEW_MAX_TOKENS", 512),
    ),
    planningReviewEnabled: envBool("DEEPCLAW_PLANNING_REVIEW", true),
    logFilePath: resolveLogFilePath(cwd, defaultLogFile),
    llmTimeoutMs: Math.max(10_000, envInt("DEEPCLAW_LLM_TIMEOUT_MS", 180_000)),
    chatHistoryDir: resolveChatHistoryDir(cwd, defaultChatHistoryDir),
    remindersFilePath: path.resolve(dataDir, "reminders.json"),
    appTimeZone: resolveAppTimeZone(),
    ocrLanguages: envString("DEEPCLAW_OCR_LANGS", "eng") || "eng",
    voiceTranscriptionMode: parseVoiceTranscriptionMode(),
    whisperModel: envString("DEEPCLAW_WHISPER_MODEL", "tiny") || "tiny",
    whisperDevice: envString("DEEPCLAW_WHISPER_DEVICE", "cpu") || "cpu",
    whisperComputeType: envString("DEEPCLAW_WHISPER_COMPUTE_TYPE", "int8") || "int8",
    whisperPython: envString("DEEPCLAW_WHISPER_PYTHON", ""),
    whisperTimeoutMs: Math.min(
      600_000,
      Math.max(15_000, envInt("DEEPCLAW_WHISPER_TIMEOUT_MS", 120_000)),
    ),
    chatHistoryMaxMessages: clampInt(
      envInt("DEEPCLAW_CHAT_HISTORY_MAX_MESSAGES", 48),
      8,
      128,
    ),
    llmMaxRetries: clampInt(envInt("DEEPCLAW_LLM_MAX_RETRIES", 3), 0, 8),
    rollingSummaryEnabled: envBool("DEEPCLAW_ROLLING_SUMMARY", true),
    rollingSummaryMinMessages: clampInt(
      envInt("DEEPCLAW_ROLLING_SUMMARY_MIN_MESSAGES", 40),
      20,
      200,
    ),
    rollingSummaryTail: clampInt(
      envInt("DEEPCLAW_ROLLING_SUMMARY_TAIL", 24),
      8,
      96,
    ),
    historyToolMaxChars: clampInt(
      envInt("DEEPCLAW_HISTORY_TOOL_MAX_CHARS", 0),
      0,
      50_000,
    ),
    historyToolFullWindow: clampInt(
      envInt("DEEPCLAW_HISTORY_TOOL_FULL_WINDOW", 16),
      4,
      64,
    ),
    shellApprovalMode: parseShellApprovalMode(),
    ...(() => {
      const shellTimeoutMs = clampInt(
        envInt("DEEPCLAW_SHELL_TIMEOUT_MS", 120_000),
        15_000,
        600_000,
      );
      const shellBlockingTimeoutMs = clampInt(
        envInt("DEEPCLAW_SHELL_BLOCKING_TIMEOUT_MS", 45_000),
        5_000,
        shellTimeoutMs,
      );
      return { shellTimeoutMs, shellBlockingTimeoutMs };
    })(),
    browserResolveDns: parseBrowserResolveDns(),
    imageFetchUserAgent: envString("DEEPCLAW_IMAGE_FETCH_USER_AGENT", ""),
    sendImageFetchMode: parseSendImageFetchMode(),
    imageFetchReferrerPolicy: parseImageFetchReferrerPolicy(),
    /** Full profile: on by default (unset); safe mode: off. Set DEEPCLAW_LONG_TERM_MEMORY=0 to disable in full. */
    longTermMemoryEnabled: full && envBool("DEEPCLAW_LONG_TERM_MEMORY", true),
    longTermMemoryDir: path.join(dataDir, "ltm"),
    maxIncomingMessageChars: (() => {
      const n = envInt("DEEPCLAW_MAX_MESSAGE_CHARS", 32_768);
      if (n <= 0) return 0;
      return clampInt(n, 1024, 200_000);
    })(),
    chatCooldownMs: clampInt(envInt("DEEPCLAW_CHAT_COOLDOWN_MS", 0), 0, 120_000),
    runTestsToolEnabled: full && envBool("DEEPCLAW_RUN_TESTS_TOOL", true),
    maxPendingTurnsPerChat: (() => {
      const n = envInt("DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT", 8);
      if (n <= 0) return 0;
      return clampInt(n, 1, 64);
    })(),
    shutdownTimeoutMs: clampInt(
      envInt("DEEPCLAW_SHUTDOWN_TIMEOUT_MS", 30_000),
      1000,
      600_000,
    ),
    healthCheckPort: (() => {
      const n = envInt("DEEPCLAW_HEALTH_PORT", 7587);
      if (n <= 0) return 0;
      return clampInt(n, 1, 65_535);
    })(),
    healthCheckHost: (() => {
      const h = envString("DEEPCLAW_HEALTH_HOST", "127.0.0.1").trim();
      return h || "127.0.0.1";
    })(),
    llmCircuitEnabled: envBool("DEEPCLAW_LLM_CIRCUIT", true),
    llmCircuitFailureThreshold: clampInt(
      envInt("DEEPCLAW_LLM_CIRCUIT_FAILURE_THRESHOLD", 5),
      1,
      50,
    ),
    llmCircuitOpenMs: clampInt(
      envInt("DEEPCLAW_LLM_CIRCUIT_OPEN_MS", 60_000),
      1000,
      600_000,
    ),
    userMessageCooldownMs: clampInt(
      envInt("DEEPCLAW_USER_MESSAGE_COOLDOWN_MS", 0),
      0,
      120_000,
    ),
    /** Default on (unset): mirror first tool-round assistant text to Telegram when the channel provides a hook. */
    telegramToolPreambleEnabled: envBool("DEEPCLAW_TELEGRAM_TOOL_PREAMBLE", true),
    telegramReplyStreaming: envBool("DEEPCLAW_TELEGRAM_STREAMING", false),
  };
}

function resolveChatHistoryDir(cwd: string, defaultDir: string): string {
  const v = process.env.DEEPCLAW_CHAT_HISTORY_DIR;
  if (v === undefined || v === "") return defaultDir;
  const t = v.trim();
  if (t === "-" || t.toLowerCase() === "none") return "";
  return path.isAbsolute(t) ? t : path.resolve(cwd, t);
}

function resolveLogFilePath(cwd: string, defaultLogFile: string): string {
  const v = process.env.DEEPCLAW_LOG_FILE;
  if (v === undefined || v === "") return defaultLogFile;
  const t = v.trim();
  if (t === "-" || t.toLowerCase() === "none") return "";
  return path.isAbsolute(t) ? t : path.resolve(cwd, t);
}

export function validateTelegramConfig(c: AppConfig): string | null {
  if (!c.telegramBotToken) return "TELEGRAM_BOT_TOKEN is required";
  if (!c.deepseekApiKey) return "DEEPSEEK_API_KEY is required";
  return null;
}
