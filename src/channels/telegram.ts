import path from "node:path";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Bot, InputFile, InputMediaBuilder, InlineKeyboard, type Context } from "grammy";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AppConfig } from "../config.js";
import {
  type AgentService,
  type AgentTurnImageAttachment,
  AgentTurnQueueFullError,
  REPLY_USER_STOPPED,
} from "../agent.js";
import { loadChatHistory } from "../chatHistoryPersistence.js";
import { createChatCompletionWithRetry } from "../llm/chatCompletion.js";
import { BrowserSession } from "../tools/browser.js";
import { sleep } from "../util/sleep.js";
import { logError, logInfo, logTraceStorage, logWarn } from "../util/logger.js";
import { logPhaseMs } from "../util/latencyLog.js";
import { splitForTelegram } from "../util/telegramText.js";
import { buildPlanningGateUserContent } from "../util/planningGate.js";
import {
  UNIFIED_GATE_MAX_TOKENS,
  UNIFIED_GATE_SYSTEM_PROMPT,
  parseUnifiedGateResponse,
  type UnifiedGateResult,
} from "../util/unifiedGate.js";
import {
  narrateEmptyReminderList,
  narrateReminderList,
  narrateReminderSaved,
  narrateRemindersRemoved,
  narrateRemoveReminderNoMatch,
} from "../reminders/reminderNarration.js";
import { formatInstantInTimeZone } from "../reminders/displayTime.js";
import {
  createSnoozeOnceJob,
  loadReminderJobs,
  remindersForChatUser,
  ReminderScheduler,
  resolveRemoveReminderIds,
  isValidCronExpression,
  type ReminderJob,
} from "../reminders/reminderService.js";
import { downloadTelegramBotFile } from "../util/telegramDownload.js";
import { ocrImageBuffer } from "../util/ocrTesseract.js";
import { transcribeVoiceFileLocal } from "../util/transcribeVoiceLocal.js";
import { probeWhisperImport } from "../util/whisperProbe.js";
import { recordTurnOutcome } from "../util/runtimeMetrics.js";
import { LlmCircuitOpenError } from "../util/llmCircuitBreaker.js";

function joinTelegramChunks(chunks: string[]): string {
  return chunks
    .map((c) => c.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function recordReminderExchange(
  agent: AgentService,
  chatId: string,
  userLine: string,
  assistantText: string,
): Promise<void> {
  try {
    await agent.appendTurnForHistory(chatId, userLine, assistantText);
  } catch (e) {
    logError(`recordReminderExchange failed chatId=${chatId}`, e);
  }
}

function isUserAllowed(config: AppConfig, userId: number | undefined): boolean {
  if (!config.allowedUserIds.length) return true;
  if (userId === undefined) return false;
  return config.allowedUserIds.includes(userId);
}

/**
 * Short, unambiguous stop phrases (no slash commands). Avoids matching long sentences.
 */
function isNaturalLanguageStopRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 48) return false;
  const stops = new Set([
    "stop",
    "stop.",
    "cancel",
    "cancel.",
    "stop please",
    "cancel please",
    "dừng",
    "dừng.",
    "ngừng",
    "ngừng.",
    "hủy",
    "hủy.",
    "dừng lại",
    "dừng lại.",
    "ngừng lại",
    "ngừng lại.",
  ]);
  return stops.has(t);
}

type TelegramChatMessage = NonNullable<Context["message"]>;

const UNSUPPORTED_MEDIA_REPLY =
  "Only text messages are supported here. Send plain text, or send a photo/file with a caption if you want that text handled.";

const VOICE_TRANSCRIPTION_OFF_REPLY =
  "Voice transcription is off (DEEPCLAW_VOICE_TRANSCRIPTION). Send plain text or a photo with a caption, or enable voice in .env (see README).";

const VOICE_TRANSCRIPTION_UNAVAILABLE_REPLY =
  "Voice transcription is not available on this instance (e.g. auto-detect did not find faster-whisper). Send plain text or a photo with a caption.";

function captionTrimmed(m: TelegramChatMessage): string {
  if (!("caption" in m) || typeof m.caption !== "string") return "";
  return m.caption.trim();
}

function messageHasPlainText(m: TelegramChatMessage): boolean {
  return "text" in m && typeof m.text === "string" && m.text.trim().length > 0;
}

function isServiceLikeTelegramMessage(m: TelegramChatMessage): boolean {
  return (
    "new_chat_members" in m ||
    "left_chat_member" in m ||
    "pinned_message" in m ||
    "group_chat_created" in m ||
    "supergroup_chat_created" in m ||
    "channel_chat_created" in m ||
    "migrate_to_chat_id" in m ||
    "forum_topic_created" in m
  );
}

function isBareVoiceMessage(m: TelegramChatMessage): boolean {
  if (messageHasPlainText(m)) return false;
  if (captionTrimmed(m)) return false;
  if (isServiceLikeTelegramMessage(m)) return false;
  return "voice" in m;
}

/** Photo messages (handled by OCR handler). */
function isPhotoMessageWithoutPlainText(m: TelegramChatMessage): boolean {
  if (messageHasPlainText(m)) return false;
  if (isServiceLikeTelegramMessage(m)) return false;
  return "photo" in m && Array.isArray(m.photo) && m.photo.length > 0;
}

/** Video/document/etc. with no caption and no plain text — voice and photo excluded. */
function isBareUserMediaWithoutCaption(m: TelegramChatMessage): boolean {
  if (messageHasPlainText(m)) return false;
  if (captionTrimmed(m)) return false;
  if (isServiceLikeTelegramMessage(m)) return false;
  if ("voice" in m) return false;
  if ("photo" in m) return false;
  return (
    "video" in m ||
    "video_note" in m ||
    "audio" in m ||
    "document" in m ||
    "sticker" in m ||
    "animation" in m
  );
}

/**
 * Synthetic user message after clear_memory (unified gate) — must stay short so planning heuristics skip plan/review.
 * Only the model reply is sent to Telegram, not this text.
 */
const WAKE_AFTER_CLEAR_USER_TEXT = "Wake up!";

/** How often to re-send Telegram “typing” while the agent works (Telegram typing expires ~5s). */
const PENDING_REMINDER_TTL_MS = 15 * 60 * 1000;
const PENDING_CLEANUP_INTERVAL_MS = 60_000;

/** Max Telegram photo file size for OCR (bytes). */
const TELEGRAM_PHOTO_MAX_BYTES = 12 * 1024 * 1024;

/** Max Telegram voice note download (bytes). */
const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;

function buildPhotoOcrUserText(caption: string, ocrText: string): string {
  const ocrBlock = ocrText.trim() ? ocrText : "(No text detected in image.)";
  const cap = caption.trim();
  if (cap) {
    return `${cap}\n\n---\nText from image (OCR; may contain errors):\n${ocrBlock}`;
  }
  return `📷 Image message. Text from image (OCR; may contain errors):\n${ocrBlock}`;
}

interface PendingReminder {
  chatId: string;
  userId: number;
  scheduleKind: "cron" | "once";
  cron: string;
  fireInMinutes: number;
  reminderText: string;
  pingMessage: string;
  summary: string;
  expiresAt: number;
}

/** How long shell-approval inline keyboards stay valid (user must tap Run or Cancel). */
const SHELL_APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Only forum topic routing; we intentionally omit reply_parameters so the bot does not quote the user’s message. */
type TelegramReplyAnchor = {
  messageThreadId?: number;
};

function topicAnchorFromTelegramMessage(
  msg: unknown,
): TelegramReplyAnchor | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { message_thread_id?: unknown };
  if (typeof m.message_thread_id === "number") {
    return { messageThreadId: m.message_thread_id };
  }
  return undefined;
}

function telegramReplyAnchorFromMessage(
  m: TelegramChatMessage | undefined,
): TelegramReplyAnchor | undefined {
  return topicAnchorFromTelegramMessage(m);
}

function telegramAnchorFromContext(ctx: Context): TelegramReplyAnchor | undefined {
  return (
    topicAnchorFromTelegramMessage(ctx.message) ??
    topicAnchorFromTelegramMessage(ctx.callbackQuery?.message)
  );
}

function telegramTopicOpts(anchor: TelegramReplyAnchor | undefined): {
  message_thread_id?: number;
} {
  if (anchor?.messageThreadId === undefined) return {};
  return { message_thread_id: anchor.messageThreadId };
}

/** Telegram allows one caption per album (first media only); merge per-image captions. */
function mergeReferenceImageCaptions(images: AgentTurnImageAttachment[]): string {
  if (images.length === 0) return "";
  if (images.length === 1) return images[0]!.caption;
  const parts = images.map(
    (im, i) => `[${i + 1}/${images.length}] ${im.caption.trim()}`,
  );
  let s = parts.join("\n\n");
  if (s.length > 1024) {
    s = `${s.slice(0, 1021)}…`;
  }
  return s;
}

type PendingShellApproval = {
  chatId: string;
  userId: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (ok: boolean) => void;
};

function newPendingId(): string {
  return randomBytes(4).toString("hex");
}

async function telegramSendWithRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const code = (e as { error_code?: number })?.error_code;
      const retryAfter = (e as { parameters?: { retry_after?: number } })?.parameters
        ?.retry_after;
      if (code === 429 && i < attempts - 1) {
        await sleep(Math.min(60, Math.max(1, retryAfter ?? 3)) * 1000);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

/**
 * Send as a normal chat message (no reply_parameters / quote of the user’s message).
 * In forum topics, passes message_thread_id when known from `anchor` or `ctx`.
 */
async function sendBotUtterance(
  ctx: Context,
  chat: { id: number },
  text: string,
  anchor?: TelegramReplyAnchor,
  extra?: { reply_markup?: InlineKeyboard },
): Promise<void> {
  const topic = telegramTopicOpts(anchor ?? telegramAnchorFromContext(ctx));
  await telegramSendWithRetry(() =>
    ctx.api.sendMessage(chat.id, text, { ...topic, ...extra }),
  );
}

async function completeUnifiedGate(
  client: OpenAI,
  model: string,
  maxRetries: number,
  userText: string,
  reminderTz: string,
  scheduledInChatJson: string,
  priorForGate: ChatCompletionMessageParam[],
): Promise<UnifiedGateResult> {
  const wallNow = formatInstantInTimeZone(Date.now(), reminderTz);
  const priorBlock = buildPlanningGateUserContent(priorForGate, userText);
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        { role: "system", content: UNIFIED_GATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Now: ${wallNow}

Scheduled reminders in this chat (JSON array; use "id" or unique text match when removing):
${scheduledInChatJson}

${priorBlock}`,
        },
      ],
      max_tokens: UNIFIED_GATE_MAX_TOKENS,
    },
    maxRetries,
  );
  const raw = completion.choices[0]?.message?.content?.trim() || "";
  const parsed = parseUnifiedGateResponse(raw);
  logInfo(
    `unified gate: action=${parsed.action} planning=${parsed.planningRoute} raw=${JSON.stringify(raw.length > 200 ? `${raw.slice(0, 200)}…` : raw)}`,
  );
  return parsed;
}

/** Clear Telegram’s “/” command menu (slash commands are not supported). */
async function clearTelegramCommandMenu(api: Bot["api"]): Promise<void> {
  try {
    await api.setMyCommands([]);
    logInfo("telegram: command menu cleared (no slash commands)");
  } catch (e) {
    logWarn(`telegram: setMyCommands([]) failed (bot still runs): ${String(e)}`);
  }
}

export async function runTelegramChannel(
  config: AppConfig,
  agent: AgentService,
  browser: BrowserSession,
  llm: OpenAI,
): Promise<void> {
  let shuttingDown = false;
  let backoffMs = 2000;
  const maxBackoffMs = 120_000;
  const pendingReminders = new Map<string, PendingReminder>();
  const pendingShellApprovals = new Map<string, PendingShellApproval>();
  /** Active `runTurn` abort handles per chat (natural-language stop phrase). */
  const activeTurnAbortByChat = new Map<string, AbortController>();
  const lastUserMessageAt = new Map<string, number>();
  /** Last time this Telegram user id started a throttled inbound turn (all chats). */
  const lastUserGlobalCooldownAt = new Map<number, number>();
  let pendingCleanupTimer: ReturnType<typeof setInterval> | undefined;

  function cleanupExpiredPending(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, p] of pendingReminders.entries()) {
      if (now > p.expiresAt) {
        pendingReminders.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      logWarn(`telegram: dropped ${removed} expired pending reminder(s)`);
    }
  }

  let bot: Bot;
  const reminderScheduler = new ReminderScheduler(
    config.remindersFilePath,
    () => bot,
    {
      timeZone: config.appTimeZone,
    },
  );

  /** Resolved after optional startup probe; voice handler reads this. */
  let voiceTranscriptionActive = false;

  const sendRemindersListReply = async (
    ctx: Context,
    chatId: string,
    userRequest: string,
  ): Promise<string> => {
    const jobs = await loadReminderJobs(config.remindersFilePath);
    const mine = jobs.filter((j) => j.chatId === chatId);
    const tz = config.appTimeZone;
    const body =
      mine.length === 0
        ? await narrateEmptyReminderList(
            llm,
            config.deepseekModel,
            tz,
            userRequest,
            config.llmMaxRetries,
          )
        : await narrateReminderList(
            llm,
            config.deepseekModel,
            mine,
            tz,
            userRequest,
            config.llmMaxRetries,
          );
    const chunks = splitForTelegram(body);
    const chat = ctx.chat;
    if (!chat) return body;
    const listAnchor = telegramReplyAnchorFromMessage(ctx.message);
    for (let i = 0; i < chunks.length; i++) {
      await sendBotUtterance(ctx, chat, chunks[i]!, listAnchor);
    }
    return joinTelegramChunks(chunks);
  };

  function createShellApprovalRequester(
    ctx: Context,
    chat: NonNullable<Context["chat"]>,
    chatId: string,
    userId: number,
    anchor: TelegramReplyAnchor | undefined,
  ): (command: string) => Promise<boolean> {
    return (command: string) =>
      new Promise<boolean>((res) => {
        const id = randomBytes(6).toString("hex");
        let timeoutId: ReturnType<typeof setTimeout>;
        const finish = (ok: boolean) => {
          clearTimeout(timeoutId);
          pendingShellApprovals.delete(id);
          res(ok);
        };
        timeoutId = setTimeout(() => finish(false), SHELL_APPROVAL_TTL_MS);
        pendingShellApprovals.set(id, {
          chatId,
          userId,
          timeoutId,
          resolve: finish,
        });
        const preview =
          command.length > 400 ? `${command.slice(0, 400)}…` : command;
        const keyboard = new InlineKeyboard()
          .text("Run command", `shell:ok:${id}`)
          .text("Cancel", `shell:no:${id}`);
        void telegramSendWithRetry(() =>
          ctx.api.sendMessage(
            chat.id,
            `Please confirm this shell command:\n\n${preview}`,
            {
              reply_markup: keyboard,
              ...telegramTopicOpts(anchor),
            },
          ),
        ).catch(() => {
          finish(false);
        });
      });
  }

  const sendAgentTurnToChat = async (
    ctx: Context,
    chatId: string,
    chat: NonNullable<Context["chat"]>,
    userText: string,
    opts?: {
      planningRoute?: "plan" | "direct";
      replyAnchor?: TelegramReplyAnchor;
      preloadedChatHistory?: ChatCompletionMessageParam[];
    },
  ): Promise<void> => {
    const turnStarted = Date.now();
    try {
      await ctx.api.sendChatAction(chat.id, "typing");
    } catch {
      // ignore
    }
    const anchor = opts?.replyAnchor;
    const streamMsgIds = new Map<number, number>();
    let streamLastEditAt = 0;
    const topicBase = telegramTopicOpts(anchor);
    const updateStreamMessage = async (
      llmPass: number,
      snapshot: string,
    ): Promise<void> => {
      const t = snapshot.trim();
      if (!t) return;
      const display = t.length > 4090 ? `${t.slice(0, 4080)}…` : t;
      const now = Date.now();
      const gap = 520 - (now - streamLastEditAt);
      if (gap > 0) await sleep(gap);
      streamLastEditAt = Date.now();
      let mid = streamMsgIds.get(llmPass);
      try {
        if (mid === undefined) {
          const m = await telegramSendWithRetry(() =>
            ctx.api.sendMessage(chat.id, display, topicBase),
          );
          streamMsgIds.set(llmPass, m.message_id);
        } else {
          await telegramSendWithRetry(() =>
            ctx.api.editMessageText(chat.id, mid, display),
          );
        }
      } catch (e) {
        logWarn(`telegram streaming update failed pass=${llmPass}: ${String(e)}`);
      }
    };
    const shellReq =
      config.shellEnabled &&
      config.shellApprovalMode !== "off" &&
      ctx.from?.id !== undefined
        ? createShellApprovalRequester(ctx, chat, chatId, ctx.from.id, anchor)
        : undefined;
    const ac = new AbortController();
    activeTurnAbortByChat.set(chatId, ac);
    try {
      const turn = await agent.runTurn(chatId, userText, {
        planningRoute: opts?.planningRoute,
        preloadedChatHistory: opts?.preloadedChatHistory,
        abortSignal: ac.signal,
        hooks: {
          onLlmRequest: async () => {
            await ctx.api.sendChatAction(chat.id, "typing").catch(() => undefined);
          },
          requestShellApproval: shellReq,
          ...(config.telegramToolPreambleEnabled
            ? {
                onAssistantToolPreamble: async (pre: string) => {
                  const preChunks = splitForTelegram(pre);
                  for (let i = 0; i < preChunks.length; i++) {
                    await sendBotUtterance(ctx, chat, preChunks[i]!, anchor);
                  }
                },
              }
            : {}),
          ...(config.telegramReplyStreaming
            ? {
                onAssistantStreamDelta: (_d, snap, meta) =>
                  updateStreamMessage(meta.llmPass, snap),
              }
            : {}),
        },
      });
      const duration = Date.now() - turnStarted;
      if (turn.text === REPLY_USER_STOPPED) {
        recordTurnOutcome("abort");
        logInfo(
          `metric turn_outcome chatId=${chatId} outcome=abort duration_ms=${duration}`,
        );
      } else {
        recordTurnOutcome("ok");
        logInfo(
          `metric turn_outcome chatId=${chatId} outcome=ok duration_ms=${duration}`,
        );
      }
      const body =
        turn.text.trim() === ""
          ? "I could not put together a reply just then. Please try asking again."
          : turn.text;
      const chunks = splitForTelegram(body);
      const usedStream =
        config.telegramReplyStreaming && streamMsgIds.size > 0;
      if (usedStream) {
        const orderedPasses = [...streamMsgIds.keys()].sort((a, b) => a - b);
        const lastPass = orderedPasses[orderedPasses.length - 1];
        const lastMid =
          lastPass !== undefined ? streamMsgIds.get(lastPass) : undefined;
        if (chunks.length === 1 && lastMid !== undefined) {
          try {
            await telegramSendWithRetry(() =>
              ctx.api.editMessageText(chat.id, lastMid, chunks[0]!),
            );
          } catch (e) {
            logWarn(`telegram stream final edit failed: ${String(e)}`);
            await sendBotUtterance(ctx, chat, chunks[0]!, anchor);
          }
        } else {
          for (const [, mid] of [...streamMsgIds.entries()].sort(
            (a, b) => a[0] - b[0],
          )) {
            await ctx.api.deleteMessage(chat.id, mid).catch(() => undefined);
          }
          for (let i = 0; i < chunks.length; i++) {
            await sendBotUtterance(ctx, chat, chunks[i]!, anchor);
          }
        }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          await sendBotUtterance(ctx, chat, chunks[i]!, anchor);
        }
      }
      const topicForMedia = telegramTopicOpts(anchor);
      if (turn.images.length >= 2) {
        try {
          const mergedCaption = mergeReferenceImageCaptions(turn.images);
          const media = turn.images.map((img, i) =>
            InputMediaBuilder.photo(new InputFile(img.path), {
              caption: i === 0 ? mergedCaption : undefined,
            }),
          );
          await telegramSendWithRetry(() =>
            ctx.api.sendMediaGroup(chat.id, media, topicForMedia),
          );
        } catch (albumErr) {
          logError(
            "telegram sendMediaGroup failed; falling back to sendPhoto each",
            albumErr,
          );
          for (const img of turn.images) {
            try {
              await telegramSendWithRetry(() =>
                ctx.api.sendPhoto(chat.id, new InputFile(img.path), {
                  caption: img.caption,
                  ...topicForMedia,
                }),
              );
            } catch (photoErr) {
              logError(`telegram sendPhoto failed ${img.path}`, photoErr);
              await telegramSendWithRetry(() =>
                ctx.api.sendMessage(
                  chat.id,
                  `Could not attach reference image: ${img.caption.slice(0, 200)}${img.caption.length > 200 ? "…" : ""}`,
                  { ...topicForMedia },
                ),
              ).catch(() => undefined);
            }
          }
        } finally {
          for (const img of turn.images) {
            await unlink(img.path).catch(() => undefined);
          }
        }
      } else {
        for (const img of turn.images) {
          try {
            await telegramSendWithRetry(() =>
              ctx.api.sendPhoto(chat.id, new InputFile(img.path), {
                caption: img.caption,
                ...topicForMedia,
              }),
            );
          } catch (photoErr) {
            logError(`telegram sendPhoto failed ${img.path}`, photoErr);
            await telegramSendWithRetry(() =>
              ctx.api.sendMessage(
                chat.id,
                `Could not attach reference image: ${img.caption.slice(0, 200)}${img.caption.length > 200 ? "…" : ""}`,
                { ...topicForMedia },
              ),
            ).catch(() => undefined);
          } finally {
            await unlink(img.path).catch(() => undefined);
          }
        }
      }
      for (const filePath of turn.files) {
        try {
          await telegramSendWithRetry(() =>
            ctx.api.sendDocument(chat.id, new InputFile(filePath), {
              caption: path.basename(filePath),
              ...telegramTopicOpts(anchor),
            }),
          );
        } catch (docErr) {
          logError(`telegram sendDocument failed ${filePath}`, docErr);
          await telegramSendWithRetry(() =>
            ctx.api.sendMessage(
              chat.id,
              `Could not attach file: ${path.basename(filePath)}`,
              { ...telegramTopicOpts(anchor) },
            ),
          ).catch(() => undefined);
        }
      }
      logInfo(
        `telegram reply sent chatId=${chatId} parts=${chunks.length} totalChars=${body.length} images=${turn.images.length} files=${turn.files.length}`,
      );
    } catch (e) {
      if (e instanceof AgentTurnQueueFullError) {
        try {
          await sendBotUtterance(
            ctx,
            chat,
            "Too many messages are queued in this chat. Please wait for the current reply before sending more.",
            anchor,
          );
        } catch {
          // ignore
        }
        return;
      }
      if (e instanceof LlmCircuitOpenError) {
        try {
          await sendBotUtterance(
            ctx,
            chat,
            "The AI service is temporarily unavailable after repeated errors. Please try again in a minute.",
            anchor,
          );
        } catch {
          // ignore
        }
        return;
      }
      recordTurnOutcome("error");
      logInfo(
        `metric turn_outcome chatId=${chatId} outcome=error duration_ms=${Date.now() - turnStarted}`,
      );
      logError(`runTurn or telegram send failed chatId=${chatId}`, e);
      try {
        await sendBotUtterance(
          ctx,
          chat,
          "Something went wrong while I was working on that. Please try again in a moment.",
          anchor,
        );
      } catch (sendErr) {
        logError(`telegram error reply failed chatId=${chatId}`, sendErr);
      }
    } finally {
      activeTurnAbortByChat.delete(chatId);
    }
  };

  const reminderCallbackHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true }).catch(() => undefined);
      return;
    }
    const match = ctx.match;
    if (!match) return;
    const kind = match[1];
    const pendingId = match[2];
    const now = Date.now();
    const pending = pendingReminders.get(pendingId);
    if (!pending || now > pending.expiresAt) {
      pendingReminders.delete(pendingId);
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    if (uid !== pending.userId) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    const chat = ctx.chat;
    if (!chat || String(chat.id) !== pending.chatId) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }

    if (kind === "no") {
      pendingReminders.delete(pendingId);
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      void recordReminderExchange(
        agent,
        pending.chatId,
        "[Telegram: cancelled reminder proposal]",
        "No reminder was saved.",
      );
      return;
    }

    const threadAnchor = topicAnchorFromTelegramMessage(ctx.callbackQuery?.message);
    const reminderJobThreadId =
      threadAnchor?.messageThreadId !== undefined &&
      Number.isInteger(threadAnchor.messageThreadId) &&
      threadAnchor.messageThreadId > 0
        ? threadAnchor.messageThreadId
        : undefined;

    let job: ReminderJob;
    const deliveryMessage = pending.pingMessage.trim() || pending.reminderText;
    if (pending.scheduleKind === "once") {
      if (pending.fireInMinutes < 1) {
        await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
        return;
      }
      const delayMs = pending.fireInMinutes * 60 * 1000;
      if (!Number.isFinite(delayMs)) {
        await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
        return;
      }
      const fireAt = new Date(Date.now() + delayMs).toISOString();
      job = {
        id: newPendingId(),
        chatId: pending.chatId,
        userId: pending.userId,
        kind: "once",
        cron: "",
        fireAt,
        reminderText: pending.reminderText,
        deliveryMessage,
        enabled: true,
        createdAt: new Date().toISOString(),
        ...(reminderJobThreadId !== undefined
          ? { messageThreadId: reminderJobThreadId }
          : {}),
      };
    } else {
      if (!isValidCronExpression(pending.cron)) {
        await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
        return;
      }
      job = {
        id: newPendingId(),
        chatId: pending.chatId,
        userId: pending.userId,
        kind: "cron",
        cron: pending.cron.trim(),
        reminderText: pending.reminderText,
        deliveryMessage,
        enabled: true,
        createdAt: new Date().toISOString(),
        ...(reminderJobThreadId !== undefined
          ? { messageThreadId: reminderJobThreadId }
          : {}),
      };
    }

    try {
      await reminderScheduler.addAndSchedule(job);
      pendingReminders.delete(pendingId);
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const savedText = await narrateReminderSaved(
        llm,
        config.deepseekModel,
        {
          summary: pending.summary,
          reminderText: pending.reminderText,
          jobId: job.id,
          timeZone: config.appTimeZone,
          kind: job.kind,
          fireAtIso: job.fireAt,
          cron: job.kind === "cron" ? job.cron : undefined,
        },
        config.llmMaxRetries,
      );
      const chunks = splitForTelegram(savedText);
      const cbAnchor = telegramAnchorFromContext(ctx);
      for (let i = 0; i < chunks.length; i++) {
        await sendBotUtterance(ctx, chat, chunks[i]!, cbAnchor);
      }
      void recordReminderExchange(
        agent,
        pending.chatId,
        `[Telegram: confirmed reminder — ${pending.summary}]`,
        joinTelegramChunks(chunks),
      );
    } catch (e) {
      logError("reminder confirm: save failed", e);
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
    }
  };

  const shellCallbackHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true }).catch(() => undefined);
      return;
    }
    const match = ctx.match;
    if (!match) return;
    const kind = match[1];
    const pendingId = match[2];
    const p = pendingShellApprovals.get(pendingId);
    if (!p) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    if (uid !== p.userId) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    const chat = ctx.chat;
    if (!chat || String(chat.id) !== p.chatId) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    p.resolve(kind === "ok");
  };

  const snoozeCallbackHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true }).catch(() => undefined);
      return;
    }
    const match = ctx.match;
    if (!match) return;
    const minutes = Number.parseInt(match[1]!, 10);
    const sourceJobId = match[2]!;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    const jobs = await loadReminderJobs(config.remindersFilePath);
    const src = jobs.find((j) => j.id === sourceJobId);
    if (!src) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    const chat = ctx.chat;
    if (!chat || String(chat.id) !== src.chatId || uid !== src.userId) {
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
      return;
    }
    const newJob = createSnoozeOnceJob(src, minutes, newPendingId());
    try {
      await reminderScheduler.addAndSchedule(newJob);
      await ctx.answerCallbackQuery({ text: `Snoozed ${minutes} min.` }).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    } catch (e) {
      logError("snooze: add job failed", e);
      await ctx.answerCallbackQuery({ show_alert: true }).catch(() => undefined);
    }
  };

  const dispatchPlainUserTurn = async (
    ctx: Context,
    chat: NonNullable<Context["chat"]>,
    chatId: string,
    text: string,
    userId: number | undefined,
    replyAnchor?: TelegramReplyAnchor,
  ): Promise<void> => {
    if (shuttingDown) {
      await sendBotUtterance(
        ctx,
        chat,
        "The bot is shutting down; please try again in a moment.",
        replyAnchor,
      ).catch(() => undefined);
      return;
    }

    if (isNaturalLanguageStopRequest(text)) {
      const ac = activeTurnAbortByChat.get(chatId);
      if (ac) {
        ac.abort();
        await sendBotUtterance(ctx, chat, "Stopping the current reply…", replyAnchor);
      } else {
        await sendBotUtterance(
          ctx,
          chat,
          "Nothing is running for this chat to stop.",
          replyAnchor,
        );
      }
      return;
    }

    if (config.maxIncomingMessageChars > 0 && text.length > config.maxIncomingMessageChars) {
      await sendBotUtterance(
        ctx,
        chat,
        `That message is too long (max ${config.maxIncomingMessageChars} characters). Send a shorter message or split it.`,
        replyAnchor,
      );
      return;
    }
    if (config.chatCooldownMs > 0) {
      const now = Date.now();
      const last = lastUserMessageAt.get(chatId) ?? 0;
      if (now - last < config.chatCooldownMs) {
        await sendBotUtterance(
          ctx,
          chat,
          "Please wait a moment before sending another message.",
          replyAnchor,
        );
        return;
      }
      lastUserMessageAt.set(chatId, now);
    }
    if (config.userMessageCooldownMs > 0 && userId !== undefined) {
      const now = Date.now();
      const lastU = lastUserGlobalCooldownAt.get(userId) ?? 0;
      if (now - lastU < config.userMessageCooldownMs) {
        await sendBotUtterance(
          ctx,
          chat,
          "Please wait a moment before sending another message.",
          replyAnchor,
        );
        return;
      }
      lastUserGlobalCooldownAt.set(userId, now);
    }

    if (userId !== undefined) {
      try {
        await ctx.api.sendChatAction(chat.id, "typing").catch(() => undefined);
        const tLoadHist = Date.now();
        const rawPrior = config.chatHistoryDir
          ? await loadChatHistory(config.chatHistoryDir, chatId)
          : [];
        logPhaseMs("telegram_gate_loadHistory", tLoadHist, { chatId });
        const maxHist = config.chatHistoryMaxMessages;
        const priorForGate: ChatCompletionMessageParam[] =
          rawPrior.length <= maxHist ? rawPrior : rawPrior.slice(-maxHist);

        const allJobs = await loadReminderJobs(config.remindersFilePath);
        const mine = remindersForChatUser(allJobs, chatId, userId);
        const scheduledInChatJson = JSON.stringify(
          mine.map((j) => ({
            id: j.id,
            kind: j.kind,
            enabled: j.enabled,
            reminderText: j.reminderText,
            ...(j.kind === "cron" ? { cron: j.cron } : { fireAt: j.fireAt }),
          })),
        );
        const tUnifiedGate = Date.now();
        const gate = await completeUnifiedGate(
          llm,
          config.deepseekModel,
          config.llmMaxRetries,
          text,
          config.appTimeZone,
          scheduledInChatJson,
          priorForGate,
        );
        logPhaseMs("telegram_unified_gate", tUnifiedGate, { chatId });
        if (gate.action === "clear_memory") {
          await agent.clearHistory(chatId);
          await sendAgentTurnToChat(ctx, chatId, chat, WAKE_AFTER_CLEAR_USER_TEXT, {
            planningRoute: "direct",
            replyAnchor,
          });
          return;
        }
        if (gate.action === "list") {
          const listBody = await sendRemindersListReply(ctx, chatId, text.trim());
          await recordReminderExchange(agent, chatId, text.trim(), listBody);
          return;
        }
        if (gate.action === "clarify") {
          const clarify = gate.clarifyMessage.trim();
          if (clarify) {
            const clarifyChunks = splitForTelegram(clarify);
            for (let i = 0; i < clarifyChunks.length; i++) {
              await sendBotUtterance(ctx, chat, clarifyChunks[i]!, replyAnchor);
            }
            await recordReminderExchange(
              agent,
              chatId,
              text.trim(),
              joinTelegramChunks(clarifyChunks),
            );
            return;
          }
        }
        if (gate.action === "remove") {
          const targetIds = resolveRemoveReminderIds(
            allJobs,
            chatId,
            userId,
            gate.removeReminderIds,
            gate.removeTextMatch,
          );
          if (targetIds.length === 0) {
            const miss = await narrateRemoveReminderNoMatch(
              llm,
              config.deepseekModel,
              {
                userRequest: text.trim(),
                hints: mine,
                timeZone: config.appTimeZone,
              },
              config.llmMaxRetries,
            );
            const missChunks = splitForTelegram(miss);
            for (let i = 0; i < missChunks.length; i++) {
              await sendBotUtterance(ctx, chat, missChunks[i]!, replyAnchor);
            }
            await recordReminderExchange(
              agent,
              chatId,
              text.trim(),
              joinTelegramChunks(missChunks),
            );
            return;
          }
          const snapshot = mine.filter((j) => targetIds.includes(j.id));
          const removedIds = await reminderScheduler.removeJobsByIds(targetIds);
          const removedJobs = snapshot.filter((j) => removedIds.includes(j.id));
          if (removedJobs.length === 0) {
            const miss = await narrateRemoveReminderNoMatch(
              llm,
              config.deepseekModel,
              {
                userRequest: text.trim(),
                hints: mine,
                timeZone: config.appTimeZone,
              },
              config.llmMaxRetries,
            );
            const missChunks = splitForTelegram(miss);
            for (let i = 0; i < missChunks.length; i++) {
              await sendBotUtterance(ctx, chat, missChunks[i]!, replyAnchor);
            }
            await recordReminderExchange(
              agent,
              chatId,
              text.trim(),
              joinTelegramChunks(missChunks),
            );
            return;
          }
          const body = await narrateRemindersRemoved(
            llm,
            config.deepseekModel,
            {
              userRequest: text.trim(),
              removed: removedJobs,
              timeZone: config.appTimeZone,
            },
            config.llmMaxRetries,
          );
          const bodyChunks = splitForTelegram(body);
          for (let i = 0; i < bodyChunks.length; i++) {
            await sendBotUtterance(ctx, chat, bodyChunks[i]!, replyAnchor);
          }
          await recordReminderExchange(
            agent,
            chatId,
            text.trim(),
            joinTelegramChunks(bodyChunks),
          );
          return;
        }
        if (gate.action === "propose") {
          const pendingId = newPendingId();
          pendingReminders.set(pendingId, {
            chatId,
            userId,
            scheduleKind: gate.scheduleKind,
            cron: gate.cron,
            fireInMinutes: gate.fireInMinutes,
            reminderText: gate.reminderText,
            pingMessage: gate.pingMessage,
            summary: gate.summary,
            expiresAt: Date.now() + PENDING_REMINDER_TTL_MS,
          });
          const keyboard = new InlineKeyboard()
            .text(gate.confirmButton, `remind:ok:${pendingId}`)
            .text(gate.cancelButton, `remind:no:${pendingId}`);
          await sendBotUtterance(ctx, chat, gate.proposalMessage, replyAnchor, {
            reply_markup: keyboard,
          });
          await recordReminderExchange(
            agent,
            chatId,
            text.trim(),
            gate.proposalMessage,
          );
          return;
        }

        await sendAgentTurnToChat(ctx, chatId, chat, text, {
          planningRoute: gate.planningRoute,
          replyAnchor,
          preloadedChatHistory: config.chatHistoryDir ? priorForGate : undefined,
        });
        return;
      } catch (e) {
        if (e instanceof LlmCircuitOpenError) {
          logInfo("unified gate skipped: LLM circuit open");
        } else {
          logError("unified gate failed; falling through to agent", e);
        }
      }
    }

    await sendAgentTurnToChat(ctx, chatId, chat, text, { replyAnchor });
  };

  const textHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      if (ctx.chat) {
        await sendBotUtterance(
          ctx,
          ctx.chat,
          "Unauthorized (not in DEEPCLAW_ALLOWED_USER_IDS).",
        );
      }
      return;
    }
    const text = ctx.message?.text;
    if (!text?.trim()) return;
    const chat = ctx.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const replyAnchor = telegramReplyAnchorFromMessage(ctx.message);
    await dispatchPlainUserTurn(ctx, chat, chatId, text, uid, replyAnchor);
  };

  const captionHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      if (ctx.chat) {
        await sendBotUtterance(
          ctx,
          ctx.chat,
          "Unauthorized (not in DEEPCLAW_ALLOWED_USER_IDS).",
        );
      }
      return;
    }
    const m = ctx.message;
    if (!m) return;
    if (messageHasPlainText(m)) return;
    if ("photo" in m) return;
    const cap = captionTrimmed(m);
    if (!cap) return;
    const chat = ctx.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const replyAnchor = telegramReplyAnchorFromMessage(m);
    await dispatchPlainUserTurn(ctx, chat, chatId, cap, uid, replyAnchor);
  };

  const photoOcrHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      if (ctx.chat) {
        await sendBotUtterance(
          ctx,
          ctx.chat,
          "Unauthorized (not in DEEPCLAW_ALLOWED_USER_IDS).",
        );
      }
      return;
    }
    const m = ctx.message;
    if (!m || !isPhotoMessageWithoutPlainText(m)) return;
    const chat = ctx.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const cap = captionTrimmed(m);
    const photos = "photo" in m ? m.photo : undefined;
    if (!photos?.length) return;
    const best = photos[photos.length - 1]!;
    try {
      await ctx.api.sendChatAction(chat.id, "typing").catch(() => undefined);
      const file = await ctx.api.getFile(best.file_id);
      if (!file.file_path) {
        throw new Error("Telegram did not return file_path");
      }
      const bytes = await downloadTelegramBotFile(
        config.telegramBotToken,
        file.file_path,
        TELEGRAM_PHOTO_MAX_BYTES,
      );
      const ocr = await ocrImageBuffer(bytes, config.ocrLanguages);
      const userLine = buildPhotoOcrUserText(cap, ocr);
      logInfo(
        `telegram photo OCR chatId=${chatId} ocrChars=${ocr.length} hasCaption=${Boolean(cap.trim())}`,
      );
      const replyAnchor = telegramReplyAnchorFromMessage(m);
      await dispatchPlainUserTurn(ctx, chat, chatId, userLine, uid, replyAnchor);
    } catch (e) {
      logError(`telegram photo OCR failed chatId=${chatId}`, e);
      const msg = e instanceof Error ? e.message : String(e);
      if (cap.trim()) {
        const ocrFailAnchor = telegramReplyAnchorFromMessage(m);
        await sendBotUtterance(
          ctx,
          chat,
          `Could not run OCR on the photo (${msg}). Processing your caption as text only.`,
          ocrFailAnchor,
        ).catch(() => undefined);
        await dispatchPlainUserTurn(ctx, chat, chatId, cap, uid, ocrFailAnchor);
      } else {
        await sendBotUtterance(
          ctx,
          chat,
          `Could not read text from the image (${msg}). The Docker image includes Tesseract (English by default). For custom images install tesseract-ocr and matching language packs; set DEEPCLAW_OCR_LANGS accordingly.`,
          telegramReplyAnchorFromMessage(m),
        );
      }
    }
  };

  const voiceMessageHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      if (ctx.chat) {
        await sendBotUtterance(
          ctx,
          ctx.chat,
          "Unauthorized (not in DEEPCLAW_ALLOWED_USER_IDS).",
        );
      }
      return;
    }
    const m = ctx.message;
    if (!m || !isBareVoiceMessage(m)) return;
    const chat = ctx.chat;
    if (!chat) return;
    const chatId = String(chat.id);

    if (!voiceTranscriptionActive) {
      await sendBotUtterance(
        ctx,
        chat,
        config.voiceTranscriptionMode === "off"
          ? VOICE_TRANSCRIPTION_OFF_REPLY
          : VOICE_TRANSCRIPTION_UNAVAILABLE_REPLY,
        telegramReplyAnchorFromMessage(m),
      );
      return;
    }

    const voice = "voice" in m ? m.voice : undefined;
    if (!voice) return;

    const tmpRoot = await mkdtemp(path.join(tmpdir(), "deepclaw-voice-"));
    const tmpAudio = path.join(tmpRoot, "voice.oga");
    try {
      await ctx.api.sendChatAction(chat.id, "typing").catch(() => undefined);
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        throw new Error("Telegram did not return file_path");
      }
      const bytes = await downloadTelegramBotFile(
        config.telegramBotToken,
        file.file_path,
        TELEGRAM_VOICE_MAX_BYTES,
      );
      await writeFile(tmpAudio, bytes);
      const transcript = await transcribeVoiceFileLocal(tmpAudio, {
        whisperPython: config.whisperPython,
        whisperModel: config.whisperModel,
        whisperDevice: config.whisperDevice,
        whisperComputeType: config.whisperComputeType,
        whisperTimeoutMs: config.whisperTimeoutMs,
      });
      const line = transcript.trim();
      if (!line) {
        await sendBotUtterance(
          ctx,
          chat,
          "Could not transcribe that voice message (empty result).",
          telegramReplyAnchorFromMessage(m),
        );
        return;
      }
      logInfo(`telegram voice transcribed chatId=${chatId} chars=${line.length}`);
      const replyAnchor = telegramReplyAnchorFromMessage(m);
      await dispatchPlainUserTurn(ctx, chat, chatId, line, uid, replyAnchor);
    } catch (e) {
      logError(`telegram voice transcription failed chatId=${chatId}`, e);
      const msg = e instanceof Error ? e.message : String(e);
      await sendBotUtterance(
        ctx,
        chat,
        `Voice transcription failed: ${msg}`,
        telegramReplyAnchorFromMessage(m),
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const unsupportedMediaHandler = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!isUserAllowed(config, uid)) {
      if (ctx.chat) {
        await sendBotUtterance(
          ctx,
          ctx.chat,
          "Unauthorized (not in DEEPCLAW_ALLOWED_USER_IDS).",
        );
      }
      return;
    }
    const m = ctx.message;
    if (!m || !isBareUserMediaWithoutCaption(m)) return;
    const chat = ctx.chat;
    if (!chat) return;
    await sendBotUtterance(
      ctx,
      chat,
      UNSUPPORTED_MEDIA_REPLY,
      telegramReplyAnchorFromMessage(m),
    );
  };

  if (config.voiceTranscriptionMode === "on") {
    voiceTranscriptionActive = true;
  } else if (config.voiceTranscriptionMode === "auto") {
    logInfo("telegram: DEEPCLAW_VOICE_TRANSCRIPTION=auto — probing faster-whisper…");
    voiceTranscriptionActive = await probeWhisperImport(config.whisperPython);
    if (voiceTranscriptionActive) {
      logInfo("telegram: voice transcription enabled (probe ok)");
    } else {
      logWarn(
        "telegram: voice transcription disabled — faster-whisper import failed or timed out (send text only)",
      );
    }
  }

  const createBot = () => {
    const b = new Bot(config.telegramBotToken);
    b.use((ctx, next) => {
      const traceId = `${ctx.update.update_id}-${randomBytes(4).toString("hex")}`;
      return logTraceStorage.run({ traceId }, () => next());
    });
    b.on("message:text", textHandler);
    b.on("message").filter((ctx) => {
      const m = ctx.message;
      return Boolean(m && isPhotoMessageWithoutPlainText(m));
    }, photoOcrHandler);
    b.on("message").filter((ctx) => {
      const m = ctx.message;
      if (!m) return false;
      if (messageHasPlainText(m)) return false;
      if ("photo" in m) return false;
      return captionTrimmed(m).length > 0;
    }, captionHandler);
    b.on("message").filter((ctx) => {
      const m = ctx.message;
      return Boolean(m && isBareVoiceMessage(m));
    }, voiceMessageHandler);
    b.on("message").filter((ctx) => {
      const m = ctx.message;
      return Boolean(m && isBareUserMediaWithoutCaption(m));
    }, unsupportedMediaHandler);
    b.callbackQuery(/^remind:(ok|no):([a-f0-9]+)$/, reminderCallbackHandler);
    b.callbackQuery(/^shell:(ok|no):([a-f0-9]+)$/, shellCallbackHandler);
    b.callbackQuery(/^snooze:(\d+):([a-f0-9]+)$/, snoozeCallbackHandler);
    return b;
  };

  bot = createBot();
  try {
    await bot.api.getMe();
  } catch (err) {
    logError(
      "telegram: bot.api.getMe failed (check TELEGRAM_BOT_TOKEN / network)",
      err,
    );
    await bot.stop().catch(() => undefined);
    throw err;
  }

  await clearTelegramCommandMenu(bot.api);

  await reminderScheduler.init();

  pendingCleanupTimer = setInterval(
    cleanupExpiredPending,
    PENDING_CLEANUP_INTERVAL_MS,
  );

  const stop = async () => {
    shuttingDown = true;
    for (const ac of activeTurnAbortByChat.values()) {
      ac.abort();
    }
    activeTurnAbortByChat.clear();
    const drained = await agent.waitForPendingTurns(config.shutdownTimeoutMs);
    if (!drained) {
      logWarn(
        `shutdown: timeout after ${config.shutdownTimeoutMs}ms waiting for pending agent turns`,
      );
    }
    if (pendingCleanupTimer !== undefined) {
      clearInterval(pendingCleanupTimer);
      pendingCleanupTimer = undefined;
    }
    reminderScheduler.stopAll();
    await browser.close().catch(() => undefined);
    await bot.stop();
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void (async () => {
        try {
          await stop();
        } finally {
          process.exit(0);
        }
      })();
    });
  }

  while (!shuttingDown) {
    try {
      await bot.start();
      if (shuttingDown) break;
      console.warn(
        "[deepclaw] Telegram polling ended unexpectedly; reconnecting in 5s",
      );
      await sleep(5000);
      backoffMs = 2000;
      bot = createBot();
      try {
        await bot.api.getMe();
      } catch (err) {
        logError(
          "telegram: bot.api.getMe failed after polling ended; retrying",
          err,
        );
        await bot.stop().catch(() => undefined);
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
        await sleep(backoffMs);
        continue;
      }
      await clearTelegramCommandMenu(bot.api);
      await reminderScheduler.init();
    } catch (e) {
      if (shuttingDown) break;
      console.error("[deepclaw] Telegram polling error:", e);
      await bot.stop().catch(() => undefined);
      await sleep(backoffMs);
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      bot = createBot();
      try {
        await bot.api.getMe();
      } catch (err) {
        logError(
          "telegram: bot.api.getMe failed after polling error; retrying",
          err,
        );
        await bot.stop().catch(() => undefined);
        await sleep(backoffMs);
        continue;
      }
      await clearTelegramCommandMenu(bot.api);
      await reminderScheduler.init();
    }
  }
}
