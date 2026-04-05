import type OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ChatCompletionStream } from "openai/lib/ChatCompletionStream.mjs";
import { isAbortError } from "../util/abortError.js";
import {
  assertLlmCircuitClosed,
  recordLlmFailure,
  recordLlmSuccess,
} from "../util/llmCircuitBreaker.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retriableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  return status >= 500;
}

function backoffMs(attempt: number, status: number | undefined): number {
  const base = Math.min(32_000, 800 * 2 ** attempt);
  const extra = status === 429 ? 1500 : 0;
  return base + extra;
}

export type ChatCompletionRetryOptions = {
  signal?: AbortSignal;
};

export type ChatCompletionStreamingRetryOptions = ChatCompletionRetryOptions & {
  /** Fired for each content token chunk (assistant text only). */
  onContentDelta?: (delta: string, snapshot: string) => void | Promise<void>;
};

/**
 * Wraps chat.completions.create with retries on 429 and 5xx.
 * Each attempt uses the client timeout from AppConfig (OpenAI client timeout).
 * Pass `signal` to cancel in-flight requests (does not stop subprocess tools).
 */
export async function createChatCompletionWithRetry(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  maxRetries: number,
  options?: ChatCompletionRetryOptions,
): Promise<ChatCompletion> {
  assertLlmCircuitClosed();
  const requestOpts = options?.signal ? { signal: options.signal } : undefined;
  let lastErr: unknown;
  const cap = Math.max(0, maxRetries);
  for (let attempt = 0; attempt <= cap; attempt++) {
    try {
      const out = await client.chat.completions.create(params, requestOpts);
      recordLlmSuccess();
      return out;
    } catch (e) {
      lastErr = e;
      if (isAbortError(e)) {
        throw e;
      }
      const status = (e as { status?: number })?.status;
      if (attempt >= cap || !retriableHttpStatus(status)) {
        recordLlmFailure(e);
        throw e;
      }
      await sleep(backoffMs(attempt, status));
    }
  }
  throw lastErr;
}

/**
 * Streaming chat completion with the same retry policy as {@link createChatCompletionWithRetry}.
 * Replays the full request on retry (no partial deltas across attempts).
 */
export async function createChatCompletionStreamingWithRetry(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  maxRetries: number,
  options?: ChatCompletionStreamingRetryOptions,
): Promise<ChatCompletion> {
  assertLlmCircuitClosed();
  const requestOpts = options?.signal ? { signal: options.signal } : undefined;
  let lastErr: unknown;
  const cap = Math.max(0, maxRetries);
  for (let attempt = 0; attempt <= cap; attempt++) {
    try {
      // `openai` vs `openai/lib/*` duplicate the OpenAI class type under NodeNext; runtime client is valid.
      const stream = ChatCompletionStream.createChatCompletion(
        client as never,
        { ...params, stream: true },
        requestOpts,
      );
      const onDelta = options?.onContentDelta;
      if (onDelta) {
        stream.on("content", (delta: string, snapshot: string) => {
          void Promise.resolve(onDelta(delta, snapshot));
        });
      }
      const out = await stream.finalChatCompletion();
      recordLlmSuccess();
      return out as ChatCompletion;
    } catch (e) {
      lastErr = e;
      if (isAbortError(e)) {
        throw e;
      }
      const status = (e as { status?: number })?.status;
      if (attempt >= cap || !retriableHttpStatus(status)) {
        recordLlmFailure(e);
        throw e;
      }
      await sleep(backoffMs(attempt, status));
    }
  }
  throw lastErr;
}
