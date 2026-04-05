/**
 * LLM gate: propose, list, remove, clarify, or pass through (none).
 */
export const REMINDER_GATE_MAX_TOKENS = 512;

const BTN_MAX = 40;

export const REMINDER_GATE_SYSTEM_PROMPT = `You classify Telegram user messages for a reminder bot.

Output exactly one JSON object (you may wrap it in a markdown json fence if needed). Fields:
- "action": one of "propose", "list", "remove", "clarify", "none"
- Use "list" when the user wants to see scheduled reminders (any language).
- Use "clarify" when the user is asking how reminders work, wants to "sign up" / enable reminders in general, or shows scheduling intent WITHOUT a concrete time yet (e.g. "I want to set up reminders" / "tôi muốn đăng ký nhắc lịch" with no "every day at 8", no "in 30 minutes", no cron). Output "clarifyMessage": plain text in the user's language (2–6 sentences): ask them to give a concrete time (recurring wall clock or "after X minutes") with brief examples if helpful. Do NOT mention buttons, tapping, or confirming via the chat UI in clarifyMessage. Do not lecture about time zones or configuration. Do NOT use "clarify" if they already gave a schedulable time — use "propose" instead.
- Use "remove" when the user wants to delete/cancel/stop one or more reminders in THIS chat. You receive a JSON array of that user's jobs (id, reminderText, kind, etc.). Set either:
  - "reminderIds": array of exact "id" strings to delete, and/or
  - "matchReminderText": a short substring that matches exactly ONE job's reminderText (case-insensitive). Use ids when the user names an id; use match when they describe the reminder uniquely.
  If the request is ambiguous (multiple matches) or no targets, use action "none" so the main agent can clarify.
- Use "propose" for:
  (A) RECURRING — daily, weekly, every Monday, etc. Set "scheduleKind": "cron" and "cron": 5-field expression. The user message includes REMINDER TIMEZONE: minute and hour are in THAT zone (wall clock), not UTC, unless the user asks for UTC.
  (B) ONE-TIME — "in 30 minutes", "nhắc sau 1 phút", etc. Set "scheduleKind": "once" and "fireInMinutes" (integer, minutes after the user confirms).
- "reminderText": exact short text to deliver when the reminder fires.
- "summary": one-line description.
- When action is "propose", you MUST also set:
  - "proposalMessage": multi-line plain text shown BEFORE inline buttons. Explain the schedule in friendly words (same language as the user); use plain clock times, avoid "your timezone", "UTC", or IANA names. You may use \\n for newlines inside the JSON string.
  - "pingMessage": plain text sent when the reminder fires (can match reminderText or add a short friendly wrapper in the user's language).
  - "confirmButton": short label for the confirm button (max ~${BTN_MAX} chars).
  - "cancelButton": short label for cancel (max ~${BTN_MAX} chars).
- Use "none" for normal chat or unclear requests.

When action is "list", "remove", "clarify", or "none", omit the propose-only fields or use empty strings (except "clarifyMessage" for clarify).

Examples (structure only):
{"action":"propose","scheduleKind":"cron","cron":"0 8 * * *","reminderText":"Drink water","summary":"Daily 8am water","proposalMessage":"I'll remind you every day at 8:00.\\n\\nTap a button below.","pingMessage":"Time to drink water!","confirmButton":"Save","cancelButton":"Discard"}`;

export type ReminderGateAction = "propose" | "list" | "remove" | "clarify" | "none";

export type ProposeScheduleKind = "cron" | "once";

export interface ReminderGateResult {
  action: ReminderGateAction;
  scheduleKind: ProposeScheduleKind;
  cron: string;
  fireInMinutes: number;
  reminderText: string;
  summary: string;
  proposalMessage: string;
  pingMessage: string;
  confirmButton: string;
  cancelButton: string;
  /** remove: explicit job ids from the chat snapshot */
  removeReminderIds: string[];
  /** remove: unique substring match against reminderText */
  removeTextMatch: string;
  /** clarify: short help shown to the user */
  clarifyMessage: string;
}

function emptyResult(action: ReminderGateAction = "none"): ReminderGateResult {
  return {
    action,
    scheduleKind: "cron",
    cron: "",
    fireInMinutes: 0,
    reminderText: "",
    summary: "",
    proposalMessage: "",
    pingMessage: "",
    confirmButton: "",
    cancelButton: "",
    removeReminderIds: [],
    removeTextMatch: "",
    clarifyMessage: "",
  };
}

function clipBtn(s: string): string {
  const t = s.trim();
  if (t.length <= BTN_MAX) return t;
  return t.slice(0, BTN_MAX - 1) + "…";
}

/** Extract first JSON object from model output (single line or fenced). */
function extractJsonObject(raw: string): string | null {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/im.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function normalizeAction(x: unknown): ReminderGateAction {
  if (
    x === "propose" ||
    x === "list" ||
    x === "remove" ||
    x === "clarify" ||
    x === "none"
  )
    return x;
  if (typeof x === "string") {
    const a = x.toLowerCase().trim();
    if (
      a === "propose" ||
      a === "list" ||
      a === "remove" ||
      a === "clarify" ||
      a === "none"
    )
      return a;
    if (a === "cancel" || a === "delete" || a === "unschedule" || a === "drop")
      return "remove";
    if (a === "help" || a === "guide" || a === "info") return "clarify";
  }
  return "none";
}

function normalizeScheduleKind(x: unknown): ProposeScheduleKind | null {
  if (x === "once" || x === "cron") return x;
  if (typeof x === "string") {
    const a = x.toLowerCase().trim();
    if (a === "once" || a === "one" || a === "oneshot") return "once";
    if (a === "cron" || a === "recurring" || a === "repeat") return "cron";
  }
  return null;
}

function parseFireInMinutes(r: Record<string, unknown>): number | null {
  const v = r.fireInMinutes ?? r.fire_in_minutes ?? r.delayMinutes;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseProposeStrings(
  r: Record<string, unknown>,
  summary: string,
  reminderText: string,
): Pick<
  ReminderGateResult,
  "proposalMessage" | "pingMessage" | "confirmButton" | "cancelButton"
> {
  const proposalMessage =
    typeof r.proposalMessage === "string"
      ? r.proposalMessage.replace(/\\n/g, "\n").trim()
      : typeof r.proposal_message === "string"
        ? r.proposal_message.replace(/\\n/g, "\n").trim()
        : "";
  const pingRaw =
    typeof r.pingMessage === "string"
      ? r.pingMessage.trim()
      : typeof r.ping_message === "string"
        ? r.ping_message.trim()
        : "";
  const confirmRaw =
    typeof r.confirmButton === "string"
      ? r.confirmButton.trim()
      : typeof r.confirm_button === "string"
        ? r.confirm_button.trim()
        : "";
  const cancelRaw =
    typeof r.cancelButton === "string"
      ? r.cancelButton.trim()
      : typeof r.cancel_button === "string"
        ? r.cancel_button.trim()
        : "";

  return {
    proposalMessage:
      proposalMessage || (summary || reminderText ? `${summary}\n\n${reminderText}`.trim() : ""),
    pingMessage: pingRaw || reminderText,
    confirmButton: confirmRaw ? clipBtn(confirmRaw) : "",
    cancelButton: cancelRaw ? clipBtn(cancelRaw) : "",
  };
}

/** Parse gate model output; invalid → action none. */
export function parseReminderGateResponse(raw: string): ReminderGateResult {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return emptyResult("none");
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr) as unknown;
  } catch {
    return emptyResult("none");
  }
  if (obj === null || typeof obj !== "object") return emptyResult("none");
  const r = obj as Record<string, unknown>;
  const action = normalizeAction(r.action);
  const cron = typeof r.cron === "string" ? r.cron.trim() : "";
  const reminderText =
    typeof r.reminderText === "string"
      ? r.reminderText.trim()
      : typeof r.reminder_text === "string"
        ? r.reminder_text.trim()
        : "";
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";

  if (action === "list") return { ...emptyResult("list") };

  if (action === "clarify") {
    const clarifyMessage =
      typeof r.clarifyMessage === "string"
        ? r.clarifyMessage.replace(/\\n/g, "\n").trim()
        : typeof r.clarify_message === "string"
          ? r.clarify_message.replace(/\\n/g, "\n").trim()
          : "";
    if (!clarifyMessage) return emptyResult("none");
    return { ...emptyResult("clarify"), clarifyMessage };
  }

  if (action === "remove") {
    const ids: string[] = [];
    if (Array.isArray(r.reminderIds)) {
      for (const x of r.reminderIds) {
        if (typeof x === "string" && x.trim()) ids.push(x.trim());
      }
    }
    if (Array.isArray(r.reminder_ids)) {
      for (const x of r.reminder_ids) {
        if (typeof x === "string" && x.trim()) ids.push(x.trim());
      }
    }
    const single =
      typeof r.reminderId === "string"
        ? r.reminderId.trim()
        : typeof r.reminder_id === "string"
          ? r.reminder_id.trim()
          : "";
    if (single) ids.push(single);
    const uniq = [...new Set(ids)];
    const matchText =
      typeof r.matchReminderText === "string"
        ? r.matchReminderText.trim()
        : typeof r.match_reminder_text === "string"
          ? r.match_reminder_text.trim()
          : typeof r.matchText === "string"
            ? r.matchText.trim()
            : typeof r.match_text === "string"
              ? r.match_text.trim()
              : "";
    if (!uniq.length && !matchText) return emptyResult("none");
    return {
      ...emptyResult("remove"),
      removeReminderIds: uniq,
      removeTextMatch: matchText,
    };
  }

  if (action === "propose") {
    const sk = normalizeScheduleKind(r.scheduleKind ?? r.schedule_kind);
    const fm = parseFireInMinutes(r);
    const hasCron = Boolean(cron);
    const hasFm = fm !== null && fm >= 1;
    const extras = parseProposeStrings(r, summary, reminderText);
    if (!extras.confirmButton || !extras.cancelButton) return emptyResult("none");

    if (sk === "once" || (sk === null && hasFm && !hasCron)) {
      const minutes = fm;
      if (minutes === null || minutes < 1 || !reminderText) {
        return emptyResult("none");
      }
      const delayMs = minutes * 60 * 1000;
      if (!Number.isFinite(delayMs)) return emptyResult("none");
      return {
        ...emptyResult("propose"),
        scheduleKind: "once",
        cron: "",
        fireInMinutes: minutes,
        reminderText,
        summary: summary || `In ${minutes} min — ${reminderText}`,
        ...extras,
      };
    }

    if (sk === "cron" || (sk === null && hasCron)) {
      if (!cron || !reminderText) return emptyResult("none");
      return {
        ...emptyResult("propose"),
        scheduleKind: "cron",
        cron,
        fireInMinutes: 0,
        reminderText,
        summary: summary || reminderText,
        ...extras,
      };
    }

    return emptyResult("none");
  }

  return emptyResult("none");
}
