import type OpenAI from "openai";
import type { ReminderJob } from "./reminderService.js";
import { formatInstantInTimeZone } from "./displayTime.js";
import { createChatCompletionWithRetry } from "../llm/chatCompletion.js";

const LIST_MAX = 400;
const SAVED_MAX = 280;
const EMPTY_MAX = 120;
const REMOVE_MAX = 220;
const REMOVE_MISS_MAX = 280;

function jobFacts(j: ReminderJob, timeZone: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: j.id,
    kind: j.kind,
    enabled: j.enabled,
    reminderText: j.reminderText,
    createdAt: j.createdAt,
  };
  const dm = j.deliveryMessage?.trim();
  if (dm) base.deliveryMessage = dm;
  if (j.kind === "once" && j.fireAt) {
    base.fireAt = formatInstantInTimeZone(j.fireAt, timeZone);
  }
  if (j.kind === "cron") base.cron = j.cron;
  if (j.firedAt) {
    base.lastFired = formatInstantInTimeZone(j.firedAt, timeZone);
  }
  return base;
}

export async function narrateReminderList(
  client: OpenAI,
  model: string,
  jobs: ReminderJob[],
  timeZone: string,
  userRequest: string,
  llmMaxRetries = 3,
): Promise<string> {
  const payload = {
    reminders: jobs.map((j) => jobFacts(j, timeZone)),
  };
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        {
          role: "system",
          content: `You write the chat reply for a Telegram reminder bot.
Output plain text only (no Markdown). Use the same language and tone as the user's message when you can infer it.
Turn the JSON facts into a readable list: id, schedule, status, reminder text. Be concise.
Do not explain time zones or IANA names.`,
        },
        {
          role: "user",
          content: `User message:\n${userRequest}\n\nReminder data:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      max_tokens: LIST_MAX,
    },
    llmMaxRetries,
  );
  return (
    completion.choices[0]?.message?.content?.trim() ||
    JSON.stringify(payload.reminders, null, 2)
  );
}

export async function narrateEmptyReminderList(
  client: OpenAI,
  model: string,
  timeZone: string,
  userRequest: string,
  llmMaxRetries = 3,
): Promise<string> {
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "The user asked to see reminders but there are none. Reply with one short friendly sentence in the same language as their message when possible. Plain text only.",
        },
        { role: "user", content: userRequest },
      ],
      max_tokens: EMPTY_MAX,
    },
    llmMaxRetries,
  );
  const out = completion.choices[0]?.message?.content?.trim();
  if (out) return out;
  return narrateReminderList(client, model, [], timeZone, userRequest, llmMaxRetries);
}

export async function narrateReminderSaved(
  client: OpenAI,
  model: string,
  input: {
    summary: string;
    reminderText: string;
    jobId: string;
    timeZone: string;
    kind: "once" | "cron";
    fireAtIso?: string;
    cron?: string;
  },
  llmMaxRetries = 3,
): Promise<string> {
  const scheduleLine =
    input.kind === "once" && input.fireAtIso
      ? `when: ${formatInstantInTimeZone(input.fireAtIso, input.timeZone)}`
      : `cron: ${input.cron ?? ""}`;
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        {
          role: "system",
          content: `The user just confirmed saving a scheduled reminder. Write one short friendly confirmation (2–4 sentences max).
Say when it will run in plain language from the schedule line; do not mention time zones, UTC, or IANA. Match the language/tone of the summary and reminder text when possible.
Plain text only, no Markdown.`,
        },
        {
          role: "user",
          content: `summary: ${input.summary}\nreminderText: ${input.reminderText}\njobId: ${input.jobId}\n${scheduleLine}`,
        },
      ],
      max_tokens: SAVED_MAX,
    },
    llmMaxRetries,
  );
  return (
    completion.choices[0]?.message?.content?.trim() ||
    `${input.summary} (id ${input.jobId})`
  );
}

export async function narrateRemindersRemoved(
  client: OpenAI,
  model: string,
  input: { userRequest: string; removed: ReminderJob[]; timeZone: string },
  llmMaxRetries = 3,
): Promise<string> {
  const payload = {
    removed: input.removed.map((j) => jobFacts(j, input.timeZone)),
  };
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        {
          role: "system",
          content: `The user's scheduled reminder(s) were deleted from this chat. Write a short confirmation (1–3 sentences).
Match the user's language when possible. Do not lecture about time zones. Plain text only, no Markdown.`,
        },
        {
          role: "user",
          content: `User message:\n${input.userRequest}\n\nRemoved:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      max_tokens: REMOVE_MAX,
    },
    llmMaxRetries,
  );
  return (
    completion.choices[0]?.message?.content?.trim() ||
    `Removed ${input.removed.length} reminder(s).`
  );
}

export async function narrateRemoveReminderNoMatch(
  client: OpenAI,
  model: string,
  input: { userRequest: string; hints: ReminderJob[]; timeZone: string },
  llmMaxRetries = 3,
): Promise<string> {
  const payload = {
    reminders: input.hints.map((j) => jobFacts(j, input.timeZone)),
  };
  const completion = await createChatCompletionWithRetry(
    client,
    {
      model,
      messages: [
        {
          role: "system",
          content: `The user asked to delete a reminder but no single matching job was found (wrong id, ambiguous text, or nothing to delete).
Reply briefly: suggest they ask to list their reminders in this chat to see ids, or name the reminder uniquely. Same language as the user when possible. Plain text only.`,
        },
        {
          role: "user",
          content: `User message:\n${input.userRequest}\n\nCurrent reminders in chat:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      max_tokens: REMOVE_MISS_MAX,
    },
    llmMaxRetries,
  );
  return (
    completion.choices[0]?.message?.content?.trim() ||
    "No matching reminder to remove. Ask to list reminders in this chat if you need ids."
  );
}
