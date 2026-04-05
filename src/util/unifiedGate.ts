/**
 * Single LLM call: reminder routing + planning route (PLAN vs DIRECT) + clear_memory.
 */
import {
  parseReminderGateResponse,
  type ReminderGateResult,
} from "./reminderGate.js";

export const UNIFIED_GATE_MAX_TOKENS = 768;

const BTN_MAX = 40;

export const UNIFIED_GATE_SYSTEM_PROMPT = `You classify Telegram user messages for a reminder bot AND route normal chat to the assistant.

Output exactly one JSON object (you may wrap it in a markdown json fence if needed).

REMINDER ACTIONS — same rules as a dedicated reminder bot:
- "action": one of "propose", "list", "remove", "clarify", "none", "clear_memory"
- "clear_memory": user wants to wipe/forgot/reset THIS chat conversation (forget prior messages, start fresh, "xóa hết nhớ", "clear context", "reset chat"). Not the same as removing a reminder — use "remove" only for canceling scheduled reminders.
- "list": user wants to see scheduled reminders (any language).
- "clarify": user asks how reminders work or wants reminders in general with NO concrete time yet. Output "clarifyMessage" in their language (2–6 sentences). Do NOT mention buttons or tapping in clarifyMessage. Do not lecture about time zones or IANA.
- "remove": user wants to delete/cancel/stop reminder(s). Use "reminderIds" and/or "matchReminderText" against the jobs JSON you receive. If ambiguous, use "none".
- "propose": recurring (cron) or one-time ("in N minutes"). Set scheduleKind, cron or fireInMinutes, reminderText, summary, proposalMessage, pingMessage, confirmButton, cancelButton (button labels max ~${BTN_MAX} chars).
- "none": normal chat, coding, questions, or unclear reminder intent.

PLANNING ROUTE (only when action is "none"):
- Set "planningRoute": "plan" or "direct"
- "plan" — multi-step work, several files, refactoring, exploratory debugging before tools.
- "direct" — single-step, one read, short answer, chit-chat continuation, or simple fix. Default to "direct" when unsure.

When action is not "none", you may omit "planningRoute" or set "direct".

When action is "list", "remove", "clarify", "clear_memory", omit propose-only fields (empty strings ok).

Example clear_memory:
{"action":"clear_memory"}

Example none + plan:
{"action":"none","planningRoute":"plan"}`;

export type UnifiedGateAction =
  | ReminderGateResult["action"]
  | "clear_memory";

export interface UnifiedGateResult extends Omit<ReminderGateResult, "action"> {
  action: UnifiedGateAction;
  planningRoute: "plan" | "direct";
}

function emptyUnified(action: UnifiedGateAction): UnifiedGateResult {
  const base = parseReminderGateResponse('{"action":"none"}');
  return {
    ...base,
    action,
    planningRoute: "direct",
  };
}

function extractJsonObject(raw: string): string | null {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/im.exec(s);
  if (fence) s = fence[1]!.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function normalizeClearMemory(x: unknown): boolean {
  if (x === "clear_memory" || x === "clearMemory") return true;
  if (typeof x === "string") {
    const a = x.toLowerCase().trim();
    return (
      a === "clear_memory" ||
      a === "clearmemory" ||
      a === "reset_chat" ||
      a === "wipe_memory"
    );
  }
  return false;
}

function parsePlanningRoute(r: Record<string, unknown>): "plan" | "direct" {
  const v = r.planningRoute ?? r.planning_route;
  if (typeof v === "string") {
    const a = v.toLowerCase().trim();
    if (a === "plan" || a === "planner" || a === "yes") return "plan";
    if (a === "direct" || a === "no" || a === "immediate") return "direct";
  }
  return "direct";
}

export function parseUnifiedGateResponse(raw: string): UnifiedGateResult {
  const jsonStr = extractJsonObject(raw);
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;
      if (normalizeClearMemory(obj.action)) {
        return emptyUnified("clear_memory");
      }
      const planningFromJson = parsePlanningRoute(obj);
      const r = parseReminderGateResponse(raw);
      const planningRoute =
        r.action === "none" ? planningFromJson : "direct";
      return { ...r, planningRoute };
    } catch {
      /* fall through */
    }
  }
  const r = parseReminderGateResponse(raw);
  return { ...r, planningRoute: "direct" };
}
