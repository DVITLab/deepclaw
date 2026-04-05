import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { turnCountersSnapshot } from "./runtimeMetrics.js";

/** Best-effort version from cwd package.json (Docker: /app/package.json). */
export function readPackageVersion(): string {
  try {
    const p = path.join(process.cwd(), "package.json");
    const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return j.version?.trim() || "0.0.0";
  } catch {
    return "?";
  }
}

/** Plain-text instance status (no secrets); for logs or custom integrations. */
export function formatBotStatus(config: AppConfig): string {
  const v = readPackageVersion();
  const profile = config.safeMode
    ? "safe (workspace read tools only)"
    : "full (shell + browse_web + send_image_url when Telegram)";
  const shellAppr =
    config.shellApprovalMode === "off" ? "off" : "on (risky commands only)";
  const m = turnCountersSnapshot();
  const maxMsg =
    config.maxIncomingMessageChars > 0
      ? String(config.maxIncomingMessageChars)
      : "off";
  const cool =
    config.chatCooldownMs > 0 ? `${config.chatCooldownMs} ms` : "off";
  const userCool =
    config.userMessageCooldownMs > 0 ? `${config.userMessageCooldownMs} ms` : "off";
  const pendingCap =
    config.maxPendingTurnsPerChat > 0 ? String(config.maxPendingTurnsPerChat) : "unlimited";
  const healthLine =
    config.healthCheckPort > 0
      ? `http://${config.healthCheckHost}:${config.healthCheckPort}/health`
      : "off";
  const circuitLine = config.llmCircuitEnabled
    ? `on (trip after ${config.llmCircuitFailureThreshold} failures, ${config.llmCircuitOpenMs} ms open)`
    : "off";
  return [
    `Deepclaw ${v}`,
    `Profile: ${profile}`,
    `Model: ${config.deepseekModel}`,
    `Timezone: ${config.appTimeZone}`,
    `Uptime: ${Math.round(m.uptimeMs / 1000)}s`,
    `Turns completed: ${m.turnsCompleted} (aborted: ${m.turnsAborted}, errors: ${m.turnsErrored})`,
    `Max message length: ${maxMsg}`,
    `Chat cooldown: ${cool}`,
    `User cooldown (all chats): ${userCool}`,
    `Max queued turns per chat: ${pendingCap}`,
    `Health endpoint: ${healthLine}`,
    `LLM circuit breaker: ${circuitLine}`,
    `run_tests tool: ${config.runTestsToolEnabled ? "on" : "off"}`,
    `Chat history persist: ${config.chatHistoryDir ? "on" : "off"}`,
    `Long-term memory: ${config.longTermMemoryEnabled ? "on" : "off"}`,
    `Rolling summary: ${config.rollingSummaryEnabled ? "on" : "off"}`,
    `Shell approval: ${shellAppr}`,
    `browse_web + send_image_url: ${config.browserEnabled ? "on" : "off (safe mode)"}`,
    `browse_web DNS check: ${config.browserResolveDns ? "on" : "off"}`,
    `Voice: ${config.voiceTranscriptionMode}`,
    `Planning gate: ${config.planningEnabled ? "on" : "off"}`,
  ].join("\n");
}

export function formatBotHelp(): string {
  return [
    "This bot has no slash commands. Send normal messages in your language.",
    "Examples: ask questions, clear the conversation (e.g. forget this chat), list or set reminders, or send a standalone stop / dừng lại to cancel a reply in progress.",
    "See README for environment options.",
  ].join("\n");
}
