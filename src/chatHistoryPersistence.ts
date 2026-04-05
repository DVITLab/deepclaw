import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { logWarn } from "./util/logger.js";
import { backupCorruptFile } from "./util/atomicIo.js";

/** Safe filename segment for chat id (Telegram ids may be negative). */
export function sanitizeChatIdForFilename(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function chatHistoryJsonPath(dir: string, chatId: string): string {
  return path.join(dir, `chat_${sanitizeChatIdForFilename(chatId)}.json`);
}

/** @deprecated Alias for chatHistoryJsonPath. */
export function chatHistoryFilePath(dir: string, chatId: string): string {
  return chatHistoryJsonPath(dir, chatId);
}

function isMessageLike(x: unknown): x is ChatCompletionMessageParam {
  if (x === null || typeof x !== "object") return false;
  const r = (x as { role?: unknown }).role;
  return r === "user" || r === "assistant" || r === "tool" || r === "system";
}

export function messagesFromArray(
  parsed: unknown[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const item of parsed) {
    if (isMessageLike(item)) out.push(item as ChatCompletionMessageParam);
  }
  if (out.length < parsed.length) {
    logWarn(
      `chat history: dropped ${parsed.length - out.length} invalid message object(s)`,
    );
  }
  return out;
}

export function messagesFromJson(raw: string): ChatCompletionMessageParam[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    logWarn("chat history: JSON parse failed");
    return [];
  }
  if (!Array.isArray(parsed)) {
    logWarn("chat history: JSON root is not an array");
    return [];
  }
  return messagesFromArray(parsed);
}

export function messagesToJson(messages: ChatCompletionMessageParam[]): string {
  return `${JSON.stringify(messages, null, 2)}\n`;
}

export async function loadChatHistory(
  dir: string,
  chatId: string,
): Promise<ChatCompletionMessageParam[]> {
  if (!dir) return [];
  const filePath = chatHistoryJsonPath(dir, chatId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const text = raw.trim();
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      logWarn(`chat history: JSON parse failed for ${filePath}`);
      await backupCorruptFile(filePath, "parse");
      return [];
    }
    if (!Array.isArray(parsed)) {
      logWarn(`chat history: JSON root is not an array: ${filePath}`);
      await backupCorruptFile(filePath, "root");
      return [];
    }
    return messagesFromArray(parsed);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logWarn(`chat history: failed to read ${filePath}: ${String(e)}`);
    return [];
  }
}

export async function saveChatHistory(
  dir: string,
  chatId: string,
  messages: ChatCompletionMessageParam[],
): Promise<void> {
  if (!dir) return;
  const filePath = chatHistoryJsonPath(dir, chatId);
  await fs.mkdir(dir, { recursive: true });
  const payload = messagesToJson(messages);
  const tmp = path.join(
    dir,
    `.chat_${sanitizeChatIdForFilename(chatId)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}

export async function deleteChatHistoryFile(
  dir: string,
  chatId: string,
): Promise<void> {
  if (!dir) return;
  const filePath = chatHistoryJsonPath(dir, chatId);
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logWarn(`chat history: failed to delete ${filePath}: ${String(e)}`);
    }
  }
}

/** Per-chat long-term memory file (Markdown) under `ltm/`. */
export function longTermMemoryFilePath(memoryDir: string, chatId: string): string {
  return path.join(memoryDir, `chat_${sanitizeChatIdForFilename(chatId)}.md`);
}

export async function deleteLongTermMemoryFile(
  memoryDir: string,
  chatId: string,
): Promise<void> {
  if (!memoryDir) return;
  const filePath = longTermMemoryFilePath(memoryDir, chatId);
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logWarn(`long-term memory: failed to delete ${filePath}: ${String(e)}`);
    }
  }
}
