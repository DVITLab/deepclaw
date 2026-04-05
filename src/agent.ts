import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { AppConfig } from "./config.js";
import { buildToolDefinitions } from "./tools/registry.js";
import type { BrowserSession } from "./tools/browser.js";
import {
  ToolExecutor,
  type ImageAttachmentBridge,
  type MemoryChatIdBridge,
  type ShellApprovalBridge,
} from "./tools/executor.js";
import { formatReplyForChat } from "./util/plainText.js";
import {
  PLANNING_GATE_MAX_TOKENS,
  PLANNING_GATE_SYSTEM_PROMPT,
  buildPlanningGateUserContent,
  parsePlanningGateResponse,
} from "./util/planningGate.js";
import { logError, logInfo, logWarn } from "./util/logger.js";
import { logPhaseMs } from "./util/latencyLog.js";
import {
  deleteChatHistoryFile,
  deleteLongTermMemoryFile,
  loadChatHistory,
  saveChatHistory,
} from "./chatHistoryPersistence.js";
import {
  createChatCompletionStreamingWithRetry,
  createChatCompletionWithRetry,
} from "./llm/chatCompletion.js";
import { compressHistoryForPersistence } from "./util/historyCompression.js";
import { isAbortError } from "./util/abortError.js";
import { LlmCircuitOpenError } from "./util/llmCircuitBreaker.js";
import { sleep } from "./util/sleep.js";

/** User-visible when the user cancelled the turn (e.g. natural-language stop) or AbortSignal fired. */
export const REPLY_USER_STOPPED = "Stopped at your request.";

/** Thrown when DEEPCLAW_MAX_PENDING_TURNS_PER_CHAT is exceeded for a chat. */
export class AgentTurnQueueFullError extends Error {
  override readonly name = "AgentTurnQueueFullError";
  constructor() {
    super("Too many turns queued for this chat");
  }
}

/** User-visible when the API returns no assistant message (compared in runTurnInner). */
const REPLY_NO_MODEL_RESPONSE =
  "Something went wrong on my side. Please try again in a moment.";

/** User-visible when the model returns empty text (compared in runTurnInner). */
const REPLY_EMPTY_ASSISTANT =
  "I did not have a clear answer that time. Could you ask again?";

/** User-visible if the step-limit summary call fails. */
const REPLY_STEP_LIMIT_FALLBACK =
  "That needed more work than I could finish in one go. Try one smaller question or step at a time.";

/** One no-tools completion when the tool loop hits DEEPCLAW_AGENT_MAX_STEPS. */
const STEP_LIMIT_SUMMARY_MAX_TOKENS = 1536;

/** Match Telegram typing TTL (~5s); refresh so long LLM/tool waits stay visibly active. */
const ACTIVITY_PULSE_MS = 2000;

const PLANNING_SYSTEM_PROMPT = `You are a planning assistant. Output a concise plan in plain text only (no Markdown: no asterisks, no backticks, no headings).

- List every necessary step in order to complete the user's request. Do not omit steps to save space.
- Be concise: no long explanations or fluff. Use ordered bullets or short lines.
- If the task is complex, many bullets are expected.
- If the user wants to SEE photos or know what something LOOKS LIKE (visual): the plan must include obtaining at least one direct https URL to an image file (JPEG/PNG/GIF/WebP), not only opening HTML article pages. For Wikipedia-style topics, that usually means a URL on upload.wikimedia.org (often under /wikipedia/commons/ or .../thumb/...). Text extracted from browse_web alone does not show as a picture in Telegram.

If the request is trivial (one obvious action), a single short line is enough.`;

const REVIEW_SYSTEM_PROMPT = `You review execution plans. Output plain text only (no Markdown).

- Check for missing steps, wrong order, or risks.
- If the plan is sufficient, start with APPROVED on the first line.
- Otherwise list missing steps or corrections briefly. Do not rewrite the entire plan unless it is fundamentally wrong.
- For requests to show images or appearance: reject plans that only fetch HTML article text; require a step to get a direct image file URL and attach it for the chat channel.`;

const REVIEW_USER_PROMPT =
  "Review the plan above. Respond with APPROVED if the plan is sufficient, or list missing steps and corrections. Plain text only.";

function buildExecuteUserMessage(reviewText: string): string {
  return `Review feedback (follow this when executing):

${reviewText}

Now execute the user's original request using the plan above and this review. Use tools when needed. Your final reply must be plain text only (no Markdown).`;
}

/**
 * Tools that only read (no workspace write, shell, or LTM write). Safe to run in
 * parallel when the model emits multiple calls in one assistant message.
 * Intentionally excludes run_tests (subprocess side effects) and write/send tools.
 */
const READ_ONLY_PARALLEL_TOOLS = new Set<string>([
  "read_file",
  "list_dir",
  "grep_workspace",
  "git_status",
  "git_diff_stat",
  "browse_web",
  "send_image_url", // Telegram photo queue; safe parallel with browse_web
  "read_long_term_memory",
]);

/** True when every call is a parallel-safe tool and there is more than one call. Exported for tests. */
export function shouldParallelizeToolCallBatch(
  calls: ChatCompletionMessageToolCall[],
): boolean {
  if (calls.length <= 1) return false;
  for (const c of calls) {
    if (c.type !== "function") return false;
    const name = c.function?.name;
    if (!name || !READ_ONLY_PARALLEL_TOOLS.has(name)) return false;
  }
  return true;
}

/**
 * User-visible preamble from an assistant message that also has tool_calls (Telegram UX).
 * Exported for unit tests.
 */
export function toolRoundPreambleForUser(
  content: string | null | undefined,
): string | null {
  if (typeof content !== "string") return null;
  const t = content.trim();
  if (!t) return null;
  const pre = formatReplyForChat(t);
  return pre || null;
}

let personalityFileWarned = false;

function readPersonality(path: string): string {
  if (!path.trim()) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    if (!personalityFileWarned) {
      personalityFileWarned = true;
      console.warn(`[deepclaw] DEEPCLAW_PERSONALITY_FILE not readable: ${path}`);
    }
    return "";
  }
}

function buildSystemPromptUncached(config: AppConfig): string {
  const projectWs = path.join(config.dataDir, "workspace");

  const shellHint = config.safeMode
    ? "Tool run_shell is DISABLED (DEEPCLAW_SAFE_MODE on — safe profile). Use read_file only under the project workspace; do not call run_shell."
    : "Tool run_shell is ENABLED: initial cwd is always <data-dir>/workspace; commands must not reference absolute paths outside that tree (except /dev/null).";

  const workspaceLine = `All file tools (read_file, write_file, list_dir, grep_workspace, send_file) and shell cwd are locked to the project workspace: ${path.resolve(projectWs)}. DEEPCLAW_WORKSPACE does not widen this sandbox.`;

  const browseHint = config.safeMode
    ? "browse_web is disabled in safe mode."
    : config.browserResolveDns
      ? "browse_web is enabled for public http(s) URLs; hostnames are resolved and loopback, private/reserved IPs, and blocked hosts are rejected (SSRF mitigation)."
      : "browse_web is enabled for public http(s) URLs; literal loopback/private/reserved IP hosts in the URL are rejected (hostname DNS check can be enabled via DEEPCLAW_BROWSER_RESOLVE_DNS).";

  const toolsHint = [
    "OUTPUT RULES (mandatory for every reply to the user): Write plain text only. Never use Markdown: no asterisks for bold, no backticks for code, no # headings, no triple-backtick fences, no [text](url) links. Telegram and similar clients do not render Markdown well. If you need emphasis, use CAPITALS or plain words; for code or paths, put them in normal sentences.",
    "Plain text applies to the words in your assistant message only. It does NOT mean you cannot show images on Telegram: when send_image_url is available (full mode + browser tools on), you CAN attach a real photo from a direct https image URL (JPEG/PNG/GIF/WebP) before or alongside your text. Do not tell the user you only work with text or cannot send pictures if that tool exists and you have a suitable direct image link — call send_image_url with a meaningful caption, then write your explanation in plain text.",
    "USER-FACING VOICE: Write as a natural assistant. Do not name internal tools (read_file, run_shell, browse_web, grep_workspace, etc.), planning phases, step limits, Docker, the container, model names, or environment variables. Do not say you are calling tools or using the API. Describe outcomes in ordinary language (e.g. looked at a file, checked a page, ran a command) unless the user explicitly asks how the system works technically.",
    "You are Deepclaw, a helpful agent running inside a Docker container.",
    shellHint,
    browseHint,
    "You may receive tool results from read_file, and from run_shell, browse_web, or send_image_url when those are enabled.",
    "The container often includes CLI tools in PATH: curl, wget, jq, git, rg (ripgrep), fd, zip/unzip, ps, dig, etc.",
    workspaceLine,
    ...(config.safeMode
      ? []
      : [
          "When you need a shell command, call the run_shell tool with the full command string (do not only describe the command in prose).",
          "run_shell uses time limits (see config). To let the user open a page in the browser, start HTTP servers in the BACKGROUND with logs under the workspace (e.g. `nohup python3 -m http.server 8000 --bind 0.0.0.0 > ./.http-server.log 2>&1 & sleep 1; head -5 ./.http-server.log`). Do not use absolute paths outside the project workspace (e.g. /tmp). Foreground `python -m http.server` or `npm run dev` without `&` will hang the tool until timeout and the user gets no timely reply.",
          "Dev server preview: bind to 0.0.0.0 (not only 127.0.0.1). Inside the container use each tool's usual port (e.g. Vite dev 5173, Vite preview 4173, Next/CRA 3000). On the host, Docker maps uncommon ports to those container ports — tell the user to open http://127.0.0.1 with the host port: 31300 for 3000, 35173 for 5173, 34173 for 4173, 38080 for 8080, 38000 for 8000, 35000 for 5000.",
        ]),
    "Again: user-visible replies must be plain text only — never Markdown.",
    "Language: reply in English by default. If the user writes in another language or explicitly asks for a language, match that preference.",
    "Be concise. If a tool fails, explain briefly and suggest next steps.",
    ...(config.telegramToolPreambleEnabled
      ? [
          "First tool step (Telegram): When your first assistant message in a turn includes tool calls, you may put one very short plain-text line in that same message (before tools run) so the user sees what you are about to do — everyday language only, no tool names, roughly one sentence. Your final message after tools should summarize results or completion; avoid repeating the opening line verbatim unless needed.",
        ]
      : []),
    "If the user should receive an actual file (or you created one), call send_file with a path under the project workspace (same tree as read_file).",
    ...(config.browserEnabled && !config.safeMode
      ? [
          "Telegram reference photos (send_image_url): browse_web only returns visible TEXT from a page — it never sends a picture. If the user asks for images, photos, or what something looks like, you MUST call send_image_url with at least one direct https image URL (JPEG/PNG/GIF/WebP) before you finish the turn, or they will see no photo. Prefer true file URLs (path ending in .jpg/.png/.webp or CDN static URLs), not gallery pages. For Wikipedia/Wikimedia use upload.wikimedia.org direct file or thumb URLs. If the operator set DEEPCLAW_BROWSER_ALLOWLIST, the image hostname must be on that list. Typical workflow: (1) browse_web if helpful; (2) obtain a DIRECT image URL; (3) send_image_url(url, caption); (4) plain text reply. If download fails, say briefly and paste the URL for the user to open. The server may use DEEPCLAW_SEND_IMAGE_FETCH_MODE=auto or playwright for stubborn hosts. Up to five send_image_url calls per turn; when you send more than one, Telegram may deliver them as one album with merged captions on the first photo.",
        ]
      : []),
    "For coding in the workspace: use write_file only under <data-dir>/workspace (the project sandbox; relative paths resolve there). list_dir and grep_workspace explore that workspace. Prefer these over shell when possible.",
    ...(config.longTermMemoryEnabled
      ? [
          "Long-term memory: use read_long_term_memory and write_long_term_memory for facts the user wants kept across many messages (separate from the sliding chat window). Do not store secrets unless the user explicitly asks to remember them.",
        ]
      : []),
    ...(config.shellApprovalMode !== "off" && config.shellEnabled
      ? [
          "Heuristic risky shell commands may require the user to tap Run or Cancel in Telegram before they run. Ordinary safe commands do not. If they cancel or time out, say briefly that the command was not run — do not blame the user.",
        ]
      : []),
  ].join("\n");

  const personalityBlock = readPersonality(config.personalityFilePath);
  const personalitySection = personalityBlock
    ? `Personality (follow these; plain text output for users):\n\n${personalityBlock}`
    : "";

  const parts = [toolsHint];
  if (personalitySection) parts.push(personalitySection);
  return parts.join("\n\n");
}

function systemPromptConfigFingerprint(config: AppConfig): string {
  return JSON.stringify({
    dataDir: config.dataDir,
    safeMode: config.safeMode,
    browserEnabled: config.browserEnabled,
    browserResolveDns: config.browserResolveDns,
    telegramToolPreambleEnabled: config.telegramToolPreambleEnabled,
    longTermMemoryEnabled: config.longTermMemoryEnabled,
    shellEnabled: config.shellEnabled,
    shellApprovalMode: config.shellApprovalMode,
    personalityFilePath: config.personalityFilePath,
    workdir: config.workdir,
  });
}

function personalityFileMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

let systemPromptCache:
  | { fp: string; personalityMtime: number; text: string }
  | undefined;

function systemPrompt(config: AppConfig): string {
  const fp = systemPromptConfigFingerprint(config);
  const personalityMtime = personalityFileMtimeMs(config.personalityFilePath);
  if (
    systemPromptCache &&
    systemPromptCache.fp === fp &&
    systemPromptCache.personalityMtime === personalityMtime
  ) {
    return systemPromptCache.text;
  }
  const text = buildSystemPromptUncached(config);
  systemPromptCache = { fp, personalityMtime, text };
  return text;
}

/** Optional hooks for a single turn (e.g. channel-specific UX). */
export type AgentTurnHooks = {
  /**
   * Invoked immediately and then about every 2s while an LLM request or a tool runs
   * (e.g. Telegram sendChatAction typing).
   */
  onLlmRequest?: () => void | Promise<void>;
  /**
   * When shell approval is required, await this before run_shell executes (e.g. Telegram inline buttons).
   */
  requestShellApproval?: (command: string) => Promise<boolean>;
  /**
   * When the model’s first tool-round message includes non-empty text, called once per runUntilReply
   * after formatting (e.g. Telegram sends it before tools execute).
   */
  onAssistantToolPreamble?: (text: string) => void | Promise<void>;
  /**
   * When set, the tool-loop LLM uses streaming; `llmPass` increments on each model call in that loop.
   */
  onAssistantStreamDelta?: (
    delta: string,
    snapshot: string,
    meta: { llmPass: number },
  ) => void | Promise<void>;
};

export type AgentTurnOptions = {
  hooks?: AgentTurnHooks;
  /**
   * When set (e.g. from unified gate), skip the planning gate LLM call and use this route.
   */
  planningRoute?: "plan" | "direct";
  /** When aborted, in-flight LLM calls stop; shell subprocess may still run until it exits. */
  abortSignal?: AbortSignal;
  /**
   * Skip disk reload when this slice already matches persisted history (e.g. Telegram unified gate loaded it).
   */
  preloadedChatHistory?: ChatCompletionMessageParam[];
};

/** Temp file paths + captions queued via send_image_url (Telegram sendPhoto or media group). */
export type AgentTurnImageAttachment = { path: string; caption: string };

/** Text reply plus optional attachments (Telegram). */
export type AgentTurnResult = {
  text: string;
  files: string[];
  images: AgentTurnImageAttachment[];
};

/** Max reference photos queued per user turn (anti-spam). */
const MAX_REFERENCE_IMAGES_PER_TURN = 5;

export class AgentService {
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();
  private readonly chatQueues = new Map<string, Promise<unknown>>();
  /** Count of runSerialized tasks scheduled per chat (including running). */
  private readonly turnEnqueueDepth = new Map<string, number>();
  private readonly tools: ChatCompletionTool[];
  private readonly executor: ToolExecutor;
  /** Absolute paths to send as Telegram documents this turn (cleared each runTurn). */
  private pendingFiles: string[] = [];
  /** Temp image files for Telegram sendPhoto (cleared each runTurn). */
  private pendingImages: AgentTurnImageAttachment[] = [];
  /** Set only during runTurn when hooks.onLlmRequest is provided. */
  private llmActivityHook: (() => void | Promise<void>) | undefined;
  private readonly shellApprovalBridge: ShellApprovalBridge = {};
  private readonly memoryChatIdBridge: MemoryChatIdBridge = { chatId: "" };

  constructor(
    private readonly client: OpenAI,
    private readonly config: AppConfig,
    browser: BrowserSession,
  ) {
    this.tools = buildToolDefinitions(config);
    const attachImage: ImageAttachmentBridge = (abs, caption) => {
      if (this.pendingImages.length >= MAX_REFERENCE_IMAGES_PER_TURN) {
        return false;
      }
      this.pendingImages.push({ path: abs, caption });
      return true;
    };
    this.executor = new ToolExecutor(
      config,
      browser,
      (abs) => {
        if (this.pendingFiles.length < 20) this.pendingFiles.push(abs);
      },
      this.shellApprovalBridge,
      this.memoryChatIdBridge,
      attachImage,
    );
  }

  private trim(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const max = this.config.chatHistoryMaxMessages;
    if (messages.length <= max) return messages;
    return messages.slice(-max);
  }

  /** Drop in-memory and on-disk history for this chat (e.g. unified gate clear_memory). */
  async clearHistory(chatId: string): Promise<void> {
    await this.runSerialized(chatId, async () => {
      this.history.set(chatId, []);
      await deleteChatHistoryFile(this.config.chatHistoryDir, chatId);
      if (this.config.longTermMemoryEnabled) {
        await deleteLongTermMemoryFile(this.config.longTermMemoryDir, chatId);
      }
    });
  }

  /**
   * Record a user + assistant exchange that did not go through runTurn (e.g. reminder list/propose).
   * Serialized per chatId like runTurn; updates RAM and persists when DEEPCLAW_CHAT_HISTORY_DIR is set.
   */
  async appendTurnForHistory(
    chatId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const u = userContent.trim();
    const a = assistantContent.trim();
    if (!u || !a) return;
    await this.runSerialized(chatId, async () => {
      await this.ensureHistoryLoaded(chatId);
      const prior = this.history.get(chatId) ?? [];
      const next = this.trim([
        ...prior,
        { role: "user", content: u },
        { role: "assistant", content: a },
      ]);
      this.history.set(chatId, next);
      await this.persistHistory(chatId, { skipRollingSummary: true });
    });
  }

  /**
   * Wait for all per-chat turn chains to settle (best-effort for shutdown).
   * Does not stop shell subprocesses. Returns false if `timeoutMs` elapsed first.
   */
  async waitForPendingTurns(timeoutMs: number): Promise<boolean> {
    const pending = [...this.chatQueues.values()];
    if (pending.length === 0) return true;
    const allDone = Promise.all(
      pending.map((p) => p.catch(() => undefined)),
    ).then(() => true);
    const timedOut = sleep(timeoutMs).then(() => false);
    return await Promise.race([allDone, timedOut]);
  }

  private async runSerialized<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const max = this.config.maxPendingTurnsPerChat;
    if (max > 0) {
      const cur = this.turnEnqueueDepth.get(chatId) ?? 0;
      if (cur >= max) {
        throw new AgentTurnQueueFullError();
      }
      this.turnEnqueueDepth.set(chatId, cur + 1);
    }
    const prev = this.chatQueues.get(chatId) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(async () => {
      try {
        return await fn();
      } finally {
        if (max > 0) {
          const c = this.turnEnqueueDepth.get(chatId) ?? 1;
          const next = Math.max(0, c - 1);
          if (next === 0) this.turnEnqueueDepth.delete(chatId);
          else this.turnEnqueueDepth.set(chatId, next);
        }
      }
    });
    this.chatQueues.set(chatId, task);
    return task as Promise<T>;
  }

  /**
   * When persistence is enabled, reload from disk every turn so memory matches the file
   * (survives restarts, avoids stale in-RAM state). When disabled, keep prior in-memory only.
   */
  private async ensureHistoryLoaded(
    chatId: string,
    preloaded?: ChatCompletionMessageParam[],
  ): Promise<void> {
    if (!this.config.chatHistoryDir) return;
    if (preloaded) {
      this.history.set(chatId, this.trim(preloaded));
      return;
    }
    const loaded = await loadChatHistory(this.config.chatHistoryDir, chatId);
    this.history.set(chatId, this.trim(loaded));
  }

  private async persistHistory(
    chatId: string,
    opts?: { skipRollingSummary?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    if (!this.config.chatHistoryDir) return;
    const t0 = Date.now();
    try {
      let msgs = [...(this.history.get(chatId) ?? [])];
      const tCompress = Date.now();
      msgs = await compressHistoryForPersistence(
        this.client,
        this.config.deepseekModel,
        msgs,
        this.config,
        {
          skipRollingSummary: opts?.skipRollingSummary,
          signal: opts?.signal,
        },
      );
      logPhaseMs("history_compress", tCompress, { chatId });
      msgs = this.trim(msgs);
      this.history.set(chatId, msgs);
      const tSave = Date.now();
      await saveChatHistory(this.config.chatHistoryDir, chatId, msgs);
      logPhaseMs("history_save", tSave, { chatId });
      logPhaseMs("persistHistory_total", t0, { chatId });
    } catch (e) {
      logWarn(`chat history persist failed chatId=${chatId}: ${String(e)}`);
    }
  }

  /** Periodically invoke activity hook (typing) until `fn` settles. */
  private async withActivityPulse<T>(fn: () => Promise<T>): Promise<T> {
    const hook = this.llmActivityHook;
    if (!hook) {
      return fn();
    }
    void hook();
    const id = setInterval(() => {
      void hook();
    }, ACTIVITY_PULSE_MS);
    try {
      return await fn();
    } finally {
      clearInterval(id);
    }
  }

  private async completePlanningPhase(
    prior: ChatCompletionMessageParam[],
    userText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const completion = await this.withActivityPulse(() =>
      createChatCompletionWithRetry(
        this.client,
        {
          model: this.config.deepseekModel,
          messages: [
            { role: "system", content: PLANNING_SYSTEM_PROMPT },
            ...prior,
            { role: "user", content: userText },
          ],
          max_tokens: this.config.planningPlanMaxTokens,
        },
        this.config.llmMaxRetries,
        signal ? { signal } : undefined,
      ),
    );
    const text = completion.choices[0]?.message?.content?.trim() || "";
    return text || "(empty plan)";
  }

  /** One LLM call: PLAN (full plan→review→execute) vs DIRECT (tool loop only). */
  private async completePlanningGatePhase(
    prior: ChatCompletionMessageParam[],
    userText: string,
    signal?: AbortSignal,
  ): Promise<"plan" | "direct"> {
    const userContent = buildPlanningGateUserContent(prior, userText);
    const completion = await this.withActivityPulse(() =>
      createChatCompletionWithRetry(
        this.client,
        {
          model: this.config.deepseekModel,
          messages: [
            { role: "system", content: PLANNING_GATE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: PLANNING_GATE_MAX_TOKENS,
        },
        this.config.llmMaxRetries,
        signal ? { signal } : undefined,
      ),
    );
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = parsePlanningGateResponse(raw);
    if (!raw) {
      logWarn("planning gate: empty model response, using DIRECT");
    }
    logInfo(`planning gate: ${parsed} raw=${JSON.stringify(raw)}`);
    return parsed;
  }

  private async completeReviewPhase(
    prior: ChatCompletionMessageParam[],
    userText: string,
    planText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const completion = await this.withActivityPulse(() =>
      createChatCompletionWithRetry(
        this.client,
        {
          model: this.config.deepseekModel,
          messages: [
            { role: "system", content: REVIEW_SYSTEM_PROMPT },
            ...prior,
            { role: "user", content: userText },
            { role: "assistant", content: planText },
            { role: "user", content: REVIEW_USER_PROMPT },
          ],
          max_tokens: this.config.planningReviewMaxTokens,
        },
        this.config.llmMaxRetries,
        signal ? { signal } : undefined,
      ),
    );
    const text = completion.choices[0]?.message?.content?.trim() || "";
    return text || "(empty review)";
  }

  /** One tool-loop LLM call; uses streaming when `hooks.onAssistantStreamDelta` is set. */
  private async completeChatCompletionForToolLoop(
    params: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
    hooks: AgentTurnHooks | undefined,
    llmPass: number,
  ) {
    const streamCb = hooks?.onAssistantStreamDelta;
    if (streamCb) {
      return createChatCompletionStreamingWithRetry(
        this.client,
        params,
        this.config.llmMaxRetries,
        {
          signal,
          onContentDelta: (delta, snapshot) =>
            streamCb(delta, snapshot, { llmPass }),
        },
      );
    }
    return createChatCompletionWithRetry(
      this.client,
      params,
      this.config.llmMaxRetries,
      signal ? { signal } : undefined,
    );
  }

  private async runOneToolCall(
    tc: ChatCompletionMessageToolCall,
    signal?: AbortSignal,
  ): Promise<ChatCompletionToolMessageParam> {
    if (signal?.aborted) {
      return {
        role: "tool",
        tool_call_id: tc.id,
        content: "Stopped before this tool ran.",
      };
    }
    if (tc.type !== "function") {
      return {
        role: "tool",
        tool_call_id: tc.id,
        content: `Unsupported tool call type: ${String((tc as { type?: string }).type ?? "unknown")}`,
      };
    }
    const name = tc.function.name;
    logInfo(`tool_call ${name}`);
    const rawArgs = tc.function.arguments ?? "";
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    } catch {
      const snippet =
        rawArgs.length > 400 ? `${rawArgs.slice(0, 400)}…` : rawArgs;
      return {
        role: "tool",
        tool_call_id: tc.id,
        content: `Invalid JSON in tool arguments for ${name}. Fix the arguments and try again. Parser input: ${snippet}`,
      };
    }
    const result = await this.withActivityPulse(() =>
      this.executor.execute(name, args),
    );
    return {
      role: "tool",
      tool_call_id: tc.id,
      content: result,
    };
  }

  /**
   * Tool loop until a text reply or error. Mutates `messages`. Returns raw model text or a fixed error string.
   */
  private async runUntilReply(
    messages: ChatCompletionMessageParam[],
    signal?: AbortSignal,
    turnHooks?: AgentTurnHooks,
  ): Promise<string> {
    let steps = 0;
    let toolPreambleSent = false;
    let llmPass = 0;
    while (steps < this.config.agentMaxSteps) {
      if (signal?.aborted) {
        return REPLY_USER_STOPPED;
      }
      steps += 1;
      llmPass += 1;
      const stepStarted = Date.now();
      logInfo(`runUntilReply step=${steps}/${this.config.agentMaxSteps}`);
      const completion = await this.withActivityPulse(() =>
        this.completeChatCompletionForToolLoop(
          {
            model: this.config.deepseekModel,
            messages,
            tools: this.tools.length ? this.tools : undefined,
          },
          signal,
          turnHooks,
          llmPass,
        ),
      );
      logPhaseMs("runUntilReply_llm", stepStarted, {
        chatStep: steps,
        llmPass,
      });
      const choice = completion.choices[0];
      const msg = choice?.message;
      if (!msg) {
        return REPLY_NO_MODEL_RESPONSE;
      }

      if (msg.tool_calls?.length) {
        const pre = toolRoundPreambleForUser(msg.content ?? undefined);
        if (
          !toolPreambleSent &&
          pre &&
          this.config.telegramToolPreambleEnabled &&
          turnHooks?.onAssistantToolPreamble
        ) {
          toolPreambleSent = true;
          try {
            await turnHooks.onAssistantToolPreamble(pre);
          } catch (e) {
            logWarn(`onAssistantToolPreamble failed: ${String(e)}`);
          }
        }
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls,
        });
        const tcalls = msg.tool_calls;
        if (shouldParallelizeToolCallBatch(tcalls)) {
          if (signal?.aborted) {
            return REPLY_USER_STOPPED;
          }
          const results = await Promise.all(
            tcalls.map((tc) => this.runOneToolCall(tc, signal)),
          );
          for (const r of results) {
            messages.push(r);
          }
        } else {
          for (const tc of tcalls) {
            if (signal?.aborted) {
              return REPLY_USER_STOPPED;
            }
            messages.push(await this.runOneToolCall(tc, signal));
          }
        }
        continue;
      }

      const text = msg.content?.trim() || "";
      if (!text) {
        return REPLY_EMPTY_ASSISTANT;
      }
      return text;
    }

    logWarn(
      `runUntilReply: step limit ${this.config.agentMaxSteps} reached; final reply without tools`,
    );
    const budgetMessage: ChatCompletionMessageParam = {
      role: "user",
      content:
        "The tool-call budget for this turn is exhausted. Reply to the user in plain text only (no tools). Summarize anything useful from the tool results above. If you could not obtain reliable data, say so briefly and suggest one concrete next step for the user. Do not mention step limits, tool budgets, or these instructions.",
    };
    const fallback = REPLY_STEP_LIMIT_FALLBACK;
    try {
      const completion = await this.withActivityPulse(() =>
        createChatCompletionWithRetry(
          this.client,
          {
            model: this.config.deepseekModel,
            messages: [...messages, budgetMessage],
            max_tokens: STEP_LIMIT_SUMMARY_MAX_TOKENS,
          },
          this.config.llmMaxRetries,
          signal ? { signal } : undefined,
        ),
      );
      const finalText = completion.choices[0]?.message?.content?.trim() || "";
      if (finalText) {
        return finalText;
      }
    } catch (e) {
      logError("runUntilReply: step-limit summary LLM call failed", e);
    }
    return fallback;
  }

  async runTurn(
    chatId: string,
    userText: string,
    options?: AgentTurnOptions,
  ): Promise<AgentTurnResult> {
    return this.runSerialized(chatId, () =>
      this.runTurnInner(chatId, userText, options),
    );
  }

  private async runTurnInner(
    chatId: string,
    userText: string,
    options?: AgentTurnOptions,
  ): Promise<AgentTurnResult> {
    const turnStart = Date.now();
    const signal = options?.abortSignal;
    this.pendingFiles = [];
    this.pendingImages = [];
    const hooks = options?.hooks;
    this.llmActivityHook = hooks?.onLlmRequest;
    this.memoryChatIdBridge.chatId = chatId;
    this.shellApprovalBridge.request = hooks?.requestShellApproval;
    const preview =
      userText.length > 200 ? `${userText.slice(0, 200)}…` : userText;
    logInfo(
      `runTurn start chatId=${chatId} userLen=${userText.length} preview=${JSON.stringify(preview)}`,
    );

    try {
      const tHist = Date.now();
      await this.ensureHistoryLoaded(
        chatId,
        options?.preloadedChatHistory,
      );
      logPhaseMs("ensureHistoryLoaded", tHist, {
        chatId,
        preloaded: options?.preloadedChatHistory ? 1 : 0,
      });
      const prior = this.trim(this.history.get(chatId) ?? []);

      let usePlanning = false;
      const trimmed = userText.trim();
      if (this.config.planningEnabled && trimmed) {
        if (options?.planningRoute !== undefined) {
          usePlanning = options.planningRoute === "plan";
        } else {
          const tGate = Date.now();
          const route = await this.completePlanningGatePhase(
            prior,
            userText,
            signal,
          );
          logPhaseMs("planning_gate", tGate, { chatId });
          usePlanning = route === "plan";
        }
      }
      logInfo(`runTurn route chatId=${chatId} planning=${usePlanning}`);

      let sys = systemPrompt(this.config);
      if (prior.length > 0) {
        sys += `\n\nConversation memory: earlier user and assistant messages in this chat are in the thread below. Use them for follow-up questions. Do not say you have no memory of this chat when those messages are present.`;
      }
      logInfo(`runTurn priorLen=${prior.length} chatId=${chatId}`);
      const userMsg: ChatCompletionMessageParam = { role: "user", content: userText };

      if (!usePlanning) {
        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: sys },
          ...prior,
          userMsg,
        ];
        const raw = await this.runUntilReply(messages, signal, hooks);
        if (
          raw === REPLY_NO_MODEL_RESPONSE ||
          raw === REPLY_EMPTY_ASSISTANT ||
          raw === REPLY_USER_STOPPED ||
          raw.startsWith("Stopped: max agent steps exceeded")
        ) {
          logPhaseMs("runTurn_total", turnStart, { chatId, route: "direct_err" });
          logInfo(`runTurn end (error string) chatId=${chatId} ms=${Date.now() - turnStart} raw=${JSON.stringify(raw)}`);
          return { text: raw, files: [], images: [...this.pendingImages] };
        }
        const forUser = formatReplyForChat(raw);
        messages.push({ role: "assistant", content: forUser });
        this.history.set(chatId, this.trim(messages.slice(1)));
        await this.persistHistory(chatId, { signal });
        const files = [...this.pendingFiles];
        const images = [...this.pendingImages];
        logPhaseMs("runTurn_total", turnStart, { chatId, route: "direct" });
        logInfo(
          `runTurn done (direct) chatId=${chatId} ms=${Date.now() - turnStart} replyLen=${forUser.length} files=${files.length} images=${images.length}`,
        );
        return { text: forUser, files, images };
      }

      logInfo(`runTurn phase=plan chatId=${chatId}`);
      const tPlan = Date.now();
      const planText = await this.completePlanningPhase(prior, userText, signal);
      logPhaseMs("planning_plan", tPlan, { chatId });
      logInfo(`runTurn phase=review chatId=${chatId} planLen=${planText.length}`);
      let reviewText: string;
      if (this.config.planningReviewEnabled) {
        const tRev = Date.now();
        reviewText = await this.completeReviewPhase(
          prior,
          userText,
          planText,
          signal,
        );
        logPhaseMs("planning_review", tRev, { chatId });
      } else {
        reviewText = "APPROVED";
        logInfo(`planning review skipped chatId=${chatId}`);
      }

      const execMessages: ChatCompletionMessageParam[] = [
        { role: "system", content: sys },
        ...prior,
        userMsg,
        { role: "assistant", content: planText },
        { role: "user", content: buildExecuteUserMessage(reviewText) },
      ];

      logInfo(`runTurn phase=execute chatId=${chatId}`);
      const resultRaw = await this.runUntilReply(execMessages, signal, hooks);
      if (
        resultRaw === REPLY_NO_MODEL_RESPONSE ||
        resultRaw === REPLY_EMPTY_ASSISTANT ||
        resultRaw === REPLY_USER_STOPPED ||
        resultRaw.startsWith("Stopped: max agent steps exceeded")
      ) {
        logPhaseMs("runTurn_total", turnStart, {
          chatId,
          route: "planning_err",
        });
        logInfo(
          `runTurn end (planning execute issue) chatId=${chatId} ms=${Date.now() - turnStart} raw=${JSON.stringify(resultRaw)}`,
        );
        return {
          text: resultRaw,
          files: [...this.pendingFiles],
          images: [...this.pendingImages],
        };
      }
      const forUser = formatReplyForChat(resultRaw);
      const historyMessages: ChatCompletionMessageParam[] = [
        ...prior,
        userMsg,
        { role: "assistant", content: forUser },
      ];
      this.history.set(chatId, this.trim(historyMessages));
      await this.persistHistory(chatId, { signal });
      const files = [...this.pendingFiles];
      const images = [...this.pendingImages];
      logPhaseMs("runTurn_total", turnStart, { chatId, route: "planning" });
      logInfo(
        `runTurn done (planning) chatId=${chatId} ms=${Date.now() - turnStart} replyLen=${forUser.length} files=${files.length} images=${images.length}`,
      );
      return { text: forUser, files, images };
    } catch (e) {
      if (isAbortError(e)) {
        logInfo(`runTurn aborted chatId=${chatId}`);
        return { text: REPLY_USER_STOPPED, files: [], images: [] };
      }
      if (e instanceof LlmCircuitOpenError) {
        throw e;
      }
      logError(`runTurn failed chatId=${chatId}`, e);
      throw e;
    } finally {
      this.llmActivityHook = undefined;
      this.shellApprovalBridge.request = undefined;
      this.memoryChatIdBridge.chatId = "";
    }
  }
}
