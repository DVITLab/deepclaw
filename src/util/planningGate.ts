/**
 * Planning-gate prompts and helpers. PLAN vs DIRECT routing always uses the LLM (multilingual, no regex shortcuts).
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** Max tokens for the one-line PLAN/DIRECT classifier completion. */
export const PLANNING_GATE_MAX_TOKENS = 32;

/** Max chars of prior thread included in the gate prompt. */
export const PLANNING_GATE_PRIOR_MAX_CHARS = 6000;

export const PLANNING_GATE_SYSTEM_PROMPT = `You are a routing classifier for an assistant that can run shell commands and workspace tools.

Decide if the user's request needs a written multi-step plan before using tools (multiple steps, several files, unclear scope, refactoring) or can go straight to tools (single command, one file read, short factual answer, simple fix).

Reply with exactly one word on the first line:
- PLAN — needs plan then review then execution (real coding/refactor work, multi-file, exploratory debugging).
- DIRECT — execute with tools immediately without a separate plan phase. Also use DIRECT for: how-to questions, meta questions about using the bot, or vague intent to "use" a feature with no concrete task (e.g. wanting reminders in general with no time given) — those should be answered in one tool loop, not a formal plan document.

Output only PLAN or DIRECT, nothing else.`;

function contentToString(
  content: ChatCompletionMessageParam["content"],
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function formatGateLine(m: ChatCompletionMessageParam): string {
  if (m.role === "user") return `User: ${contentToString(m.content)}`;
  if (m.role === "assistant") {
    const tc = m.tool_calls?.length
      ? ` [tool_calls]`
      : "";
    return `Assistant${tc}: ${contentToString(m.content)}`;
  }
  if (m.role === "tool") {
    return `Tool (${m.tool_call_id ?? "?"}): ${contentToString(m.content)}`;
  }
  return "";
}

/** User message for the gate completion: optional prior context + current message. */
export function buildPlanningGateUserContent(
  prior: ChatCompletionMessageParam[],
  userText: string,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of prior) {
    const line = formatGateLine(m);
    if (!line) continue;
    if (total + line.length > PLANNING_GATE_PRIOR_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  const priorBlock = lines.join("\n");
  if (priorBlock.trim()) {
    return `Prior conversation (may be truncated):\n${priorBlock}\n\n---\n\nCurrent user message:\n${userText.trim()}`;
  }
  return `Current user message:\n${userText.trim()}`;
}

/** Parse first token of gate model output; unknown → direct (cheaper default). */
export function parsePlanningGateResponse(raw: string): "plan" | "direct" {
  const line = raw.trim().split(/\r?\n/)[0] ?? "";
  const w = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const alpha = w.replace(/[^a-z]/gi, "");
  if (alpha === "plan" || alpha === "yes") return "plan";
  if (alpha === "direct" || alpha === "no") return "direct";
  return "direct";
}
