import OpenAI from "openai";
import type { AppConfig } from "../config.js";

export function createDeepSeekClient(config: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: config.deepseekApiKey,
    baseURL: config.deepseekBaseUrl,
    timeout: config.llmTimeoutMs,
  });
}
