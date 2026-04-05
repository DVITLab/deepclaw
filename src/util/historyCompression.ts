import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AppConfig } from "../config.js";
import { createChatCompletionWithRetry } from "../llm/chatCompletion.js";
import type OpenAI from "openai";
import { logError, logInfo } from "./logger.js";

function contentToString(
  content: ChatCompletionMessageParam["content"],
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/** Narrate thread for summarization (tools collapsed). */
export function threadToSummaryText(
  messages: ChatCompletionMessageParam[],
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`User: ${contentToString(m.content)}`);
    } else if (m.role === "assistant") {
      const tc = m.tool_calls?.length ? " [used tools]" : "";
      lines.push(`Assistant${tc}: ${contentToString(m.content)}`);
    } else if (m.role === "tool") {
      lines.push("(Tool output omitted for summary)");
    }
  }
  return lines.join("\n");
}

/**
 * Find start index so messages[start] is "user" (valid conversation tail for API).
 */
export function findTailStartIndex(
  messages: ChatCompletionMessageParam[],
  desiredTailLen: number,
): number {
  if (messages.length <= desiredTailLen) return 0;
  let start = Math.max(0, messages.length - desiredTailLen);
  while (start < messages.length && messages[start]!.role !== "user") {
    start -= 1;
  }
  return Math.max(0, start);
}

/**
 * Replace oldest messages with one user "recap" line; keeps tail verbatim.
 */
export async function rollingSummaryCompress(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  config: AppConfig,
  options?: { signal?: AbortSignal },
): Promise<ChatCompletionMessageParam[]> {
  if (!config.rollingSummaryEnabled) return messages;
  if (messages.length < config.rollingSummaryMinMessages) return messages;

  const tailN = Math.min(config.rollingSummaryTail, messages.length - 1);
  const start = findTailStartIndex(messages, tailN);
  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  if (head.length < 8) return messages;

  const transcript = threadToSummaryText(head);
  if (transcript.length < 200) return messages;

  const system = `You compress prior chat into a short factual recap for the assistant's context. Plain text only, no Markdown. Max ~800 characters. Preserve: user goals, decisions, file names, errors, and open tasks. Do not invent details.`;

  try {
    const completion = await createChatCompletionWithRetry(
      client,
      {
        model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Summarize this earlier conversation:\n\n${transcript.slice(0, 12_000)}`,
          },
        ],
        max_tokens: 512,
      },
      config.llmMaxRetries,
      options?.signal ? { signal: options.signal } : undefined,
    );
    const recap =
      completion.choices[0]?.message?.content?.trim() || "";
    if (!recap) return messages;
    logInfo(`rolling summary: compressed ${head.length} msgs into recap`);
    const recapMsg: ChatCompletionMessageParam = {
      role: "user",
      content: `Earlier in our chat (summary for context):\n${recap}`,
    };
    return [recapMsg, ...tail];
  } catch (e) {
    logError("rolling summary LLM failed; keeping full history slice", e);
    return messages;
  }
}

/**
 * Truncate tool role message bodies outside the last `fullWindow` messages.
 */
export function truncateOldToolBodies(
  messages: ChatCompletionMessageParam[],
  fullWindow: number,
  maxChars: number,
): ChatCompletionMessageParam[] {
  if (maxChars <= 0 || messages.length === 0) return messages;
  const w = Math.max(1, fullWindow);
  const cut = Math.max(0, messages.length - w);
  const suffix = "\n…(truncated for length)";
  return messages.map((m, i) => {
    if (i < cut && m.role === "tool" && typeof m.content === "string") {
      const c = m.content;
      if (c.length <= maxChars) return m;
      return {
        ...m,
        content: c.slice(0, maxChars) + suffix,
      };
    }
    return m;
  });
}

/** Apply tool truncation then optional rolling summary. */
export async function compressHistoryForPersistence(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  config: AppConfig,
  options?: { skipRollingSummary?: boolean; signal?: AbortSignal },
): Promise<ChatCompletionMessageParam[]> {
  let m = truncateOldToolBodies(
    messages,
    config.historyToolFullWindow,
    config.historyToolMaxChars,
  );
  if (!options?.skipRollingSummary) {
    m = await rollingSummaryCompress(client, model, m, config, {
      signal: options?.signal,
    });
  }
  return m;
}
