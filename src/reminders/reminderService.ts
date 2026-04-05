import fs from "node:fs/promises";
import path from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { logError, logInfo, logWarn } from "../util/logger.js";
import { backupCorruptFile } from "../util/atomicIo.js";

export type ReminderScheduleKind = "cron" | "once";

export interface ReminderJob {
  id: string;
  chatId: string;
  userId: number;
  /** "cron" = recurring; "once" = single fire at fireAt. */
  kind: ReminderScheduleKind;
  /** Recurring: 5-field expression. Empty when kind is once. */
  cron: string;
  /** One-shot: ISO time when to send. */
  fireAt?: string;
  reminderText: string;
  /** Text sent when the reminder fires (from LLM); falls back to reminderText. */
  deliveryMessage?: string;
  /** false = not scheduled (e.g. one-shot already fired). */
  enabled: boolean;
  createdAt: string;
  firedAt?: string;
  /** Optional IANA zone for this job’s cron schedule; defaults to app DEEPCLAW_TZ. */
  timeZone?: string;
  /**
   * Telegram forum supergroup: topic id for `sendMessage` so fires land in the same thread as the proposal.
   */
  messageThreadId?: number;
}

interface RemindersFile {
  version: number;
  jobs: ReminderJob[];
}

const FILE_VERSION = 1;

/** Serialize load→modify→write per reminders file path (in-process). */
class RemindersFileMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const runPromise = this.tail.then(() => fn());
    this.tail = runPromise.then(
      () => undefined,
      () => undefined,
    );
    return runPromise;
  }
}

const mutexByPath = new Map<string, RemindersFileMutex>();

function remindersMutexFor(filePath: string): RemindersFileMutex {
  let m = mutexByPath.get(filePath);
  if (!m) {
    m = new RemindersFileMutex();
    mutexByPath.set(filePath, m);
  }
  return m;
}

export const DEFAULT_REMINDERS_LIST_MAX = 15;

export interface ReminderDisplayOptions {
  timeZone: string;
}

/** Normalize a row from JSON (supports legacy jobs without `kind`). */
export function normalizeReminderJobRow(x: unknown): ReminderJob | null {
  if (x === null || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.chatId !== "string" ||
    typeof o.userId !== "number" ||
    typeof o.reminderText !== "string" ||
    typeof o.enabled !== "boolean" ||
    typeof o.createdAt !== "string"
  ) {
    return null;
  }
  const cronStr = typeof o.cron === "string" ? o.cron.trim() : "";
  const fireAt = typeof o.fireAt === "string" ? o.fireAt.trim() : undefined;
  const firedAt = typeof o.firedAt === "string" ? o.firedAt : undefined;
  const deliveryMessage =
    typeof o.deliveryMessage === "string" ? o.deliveryMessage.trim() : undefined;
  const timeZone =
    typeof o.timeZone === "string" && o.timeZone.trim() ? o.timeZone.trim() : undefined;
  const rawThread = o.messageThreadId;
  const messageThreadId =
    typeof rawThread === "number" &&
    Number.isInteger(rawThread) &&
    rawThread > 0
      ? rawThread
      : undefined;

  let kind: ReminderScheduleKind =
    o.kind === "once" ? "once" : o.kind === "cron" ? "cron" : "cron";

  if (kind === "once") {
    if (!fireAt || !Number.isFinite(Date.parse(fireAt))) return null;
    return {
      id: o.id,
      chatId: o.chatId,
      userId: o.userId,
      kind: "once",
      cron: "",
      fireAt,
      reminderText: o.reminderText,
      deliveryMessage: deliveryMessage || undefined,
      enabled: o.enabled,
      createdAt: o.createdAt,
      firedAt,
      timeZone,
      messageThreadId,
    };
  }

  if (!cronStr) return null;
  return {
    id: o.id,
    chatId: o.chatId,
    userId: o.userId,
    kind: "cron",
    cron: cronStr,
    reminderText: o.reminderText,
    deliveryMessage: deliveryMessage || undefined,
    enabled: o.enabled,
    createdAt: o.createdAt,
    firedAt,
    timeZone,
    messageThreadId,
  };
}

export function isValidCronExpression(expr: string): boolean {
  const t = expr.trim();
  if (!t) return false;
  return cron.validate(t);
}

export function reminderSendText(j: ReminderJob): string {
  const d = j.deliveryMessage?.trim();
  return d || j.reminderText;
}

/** Bot API options so reminder delivery stays in the same forum topic when set. */
export function reminderSendThreadOpts(j: ReminderJob): {
  message_thread_id?: number;
} {
  if (j.messageThreadId === undefined) return {};
  return { message_thread_id: j.messageThreadId };
}

/** Inline buttons to schedule a one-shot repeat of the same reminder text. */
export function reminderSnoozeKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("+15m", `snooze:15:${jobId}`)
    .text("+1h", `snooze:60:${jobId}`);
}

export function createSnoozeOnceJob(
  source: ReminderJob,
  minutes: number,
  newId: string,
): ReminderJob {
  const fireAt = new Date(Date.now() + minutes * 60_000).toISOString();
  return {
    id: newId,
    chatId: source.chatId,
    userId: source.userId,
    kind: "once",
    cron: "",
    fireAt,
    reminderText: source.reminderText,
    deliveryMessage: source.deliveryMessage,
    enabled: true,
    createdAt: new Date().toISOString(),
    timeZone: source.timeZone,
    messageThreadId: source.messageThreadId,
  };
}

export async function loadReminderJobs(filePath: string): Promise<ReminderJob[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      logWarn(`reminders: JSON parse failed ${filePath}`);
      await backupCorruptFile(filePath, "parse");
      return [];
    }
    if (parsed === null || typeof parsed !== "object") {
      await backupCorruptFile(filePath, "shape");
      return [];
    }
    const obj = parsed as Record<string, unknown>;
    const ver = obj.version;
    if (typeof ver === "number" && ver !== FILE_VERSION) {
      logWarn(
        `reminders: file version ${ver} !== ${FILE_VERSION} (${filePath}); loading jobs anyway`,
      );
    }
    const jobs = obj.jobs;
    if (!Array.isArray(jobs)) {
      logWarn(`reminders: jobs is not an array ${filePath}`);
      await backupCorruptFile(filePath, "jobs");
      return [];
    }
    const out: ReminderJob[] = [];
    for (const item of jobs) {
      const j = normalizeReminderJobRow(item);
      if (j) out.push(j);
    }
    return out;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logWarn(`reminders: failed to read ${filePath}: ${String(e)}`);
    return [];
  }
}

/** Write JSON atomically (temp in same dir, then rename). Caller must hold reminders mutex. */
async function writeReminderJobsAtomic(
  filePath: string,
  jobs: ReminderJob[],
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const body: RemindersFile = { version: FILE_VERSION, jobs };
  const data = `${JSON.stringify(body, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.reminders-${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

export async function appendReminderJob(
  filePath: string,
  job: ReminderJob,
): Promise<void> {
  await remindersMutexFor(filePath).run(async () => {
    const jobs = await loadReminderJobs(filePath);
    jobs.push(job);
    await writeReminderJobsAtomic(filePath, jobs);
  });
}

export async function updateReminderJobInFile(
  filePath: string,
  id: string,
  patch: Partial<Pick<ReminderJob, "enabled" | "firedAt">>,
): Promise<boolean> {
  return remindersMutexFor(filePath).run(async () => {
    const jobs = await loadReminderJobs(filePath);
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) return false;
    jobs[i] = { ...jobs[i], ...patch };
    await writeReminderJobsAtomic(filePath, jobs);
    return true;
  });
}

/** Jobs in this chat from this user (any enabled state). */
export function remindersForChatUser(
  jobs: ReminderJob[],
  chatId: string,
  userId: number,
): ReminderJob[] {
  return jobs.filter((j) => j.chatId === chatId && j.userId === userId);
}

/**
 * Resolve which reminder ids to remove: explicit ids that exist in eligible jobs,
 * else a unique case-insensitive substring match on reminderText / deliveryMessage.
 */
export function resolveRemoveReminderIds(
  jobs: ReminderJob[],
  chatId: string,
  userId: number,
  explicitIds: string[],
  textMatch: string,
): string[] {
  const eligible = remindersForChatUser(jobs, chatId, userId);
  const idSet = new Set(explicitIds.map((s) => s.trim()).filter(Boolean));
  if (idSet.size > 0) {
    return eligible.filter((j) => idSet.has(j.id)).map((j) => j.id);
  }
  const m = textMatch.trim().toLowerCase();
  if (!m) return [];
  const hits = eligible.filter((j) => {
    const rt = j.reminderText.toLowerCase();
    const dm = (j.deliveryMessage ?? "").toLowerCase();
    return rt.includes(m) || dm.includes(m);
  });
  if (hits.length === 1) return [hits[0]!.id];
  return [];
}

/** Remove jobs by id from the JSON file; returns ids that were present and removed. */
export async function removeReminderJobsByIds(
  filePath: string,
  ids: string[],
): Promise<string[]> {
  const idSet = new Set(ids.map((s) => s.trim()).filter(Boolean));
  if (idSet.size === 0) return [];
  return remindersMutexFor(filePath).run(async () => {
    const jobs = await loadReminderJobs(filePath);
    const removed: string[] = [];
    const kept: ReminderJob[] = [];
    for (const j of jobs) {
      if (idSet.has(j.id)) removed.push(j.id);
      else kept.push(j);
    }
    if (removed.length === 0) return [];
    await writeReminderJobsAtomic(filePath, kept);
    return removed;
  });
}

/** In-process scheduling: cron + one-shot timeouts. */
export class ReminderScheduler {
  private readonly cronTasks = new Map<string, ScheduledTask>();
  private readonly onceTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly filePath: string,
    private readonly getBot: () => Bot,
    private readonly display: ReminderDisplayOptions,
  ) {}

  /** Stop all tasks, load file, schedule enabled jobs. */
  async init(): Promise<void> {
    this.stopAll();
    const jobs = await loadReminderJobs(this.filePath);
    for (const j of jobs) {
      if (!j.enabled) continue;
      if (j.kind === "once" && j.fireAt) {
        const t = Date.parse(j.fireAt);
        if (Number.isFinite(t) && t <= Date.now()) {
          logWarn(
            `reminder once ${j.id}: fire time already passed; notifying user and marking disabled`,
          );
          const bot = this.getBot();
          const missedLine = `Missed reminder — the scheduled time passed while the bot was off.\n\n${reminderSendText(j)}`;
          try {
            await bot.api.sendMessage(j.chatId, missedLine, {
              reply_markup: reminderSnoozeKeyboard(j.id),
              ...reminderSendThreadOpts(j),
            });
          } catch (err: unknown) {
            logError(
              `reminder once ${j.id}: could not send missed notice chatId=${j.chatId}`,
              err,
            );
          }
          await updateReminderJobInFile(this.filePath, j.id, {
            enabled: false,
            firedAt: new Date().toISOString(),
          });
          continue;
        }
      }
      this.scheduleJob(j);
    }
    logInfo(
      `reminders: loaded ${jobs.length} job(s), scheduled ${this.cronTasks.size + this.onceTimeouts.size} task(s)`,
    );
  }

  private scheduleJob(j: ReminderJob): void {
    if (j.kind === "once") {
      this.scheduleOnce(j);
      return;
    }
    if (this.cronTasks.has(j.id)) return;
    if (!isValidCronExpression(j.cron)) {
      logWarn(
        `reminder job ${j.id}: invalid cron, not scheduled: ${JSON.stringify(j.cron)}`,
      );
      return;
    }
    let task: ScheduledTask;
    try {
      task = cron.schedule(
        j.cron,
        () => {
          const bot = this.getBot();
          const text = reminderSendText(j);
          void bot.api
            .sendMessage(j.chatId, text, {
              reply_markup: reminderSnoozeKeyboard(j.id),
              ...reminderSendThreadOpts(j),
            })
            .then(() => {
              logInfo(`reminder fired id=${j.id} chatId=${j.chatId}`);
            })
            .catch((err: unknown) => {
              logError(`reminder send failed id=${j.id} chatId=${j.chatId}`, err);
            });
        },
        { timezone: j.timeZone?.trim() || this.display.timeZone },
      );
    } catch (e) {
      logError(
        `reminder job ${j.id}: cron schedule failed (check DEEPCLAW_TZ / cron)`,
        e,
      );
      return;
    }
    this.cronTasks.set(j.id, task);
  }

  private scheduleOnce(j: ReminderJob): void {
    if (this.onceTimeouts.has(j.id)) return;
    if (!j.fireAt) return;
    const target = Date.parse(j.fireAt);
    if (!Number.isFinite(target)) {
      logWarn(`reminder once ${j.id}: bad fireAt`);
      return;
    }
    const delay = target - Date.now();
    if (delay <= 0) return;
    /** Node timers use a 32-bit signed delay (~24.85 days max per call). */
    const MAX_MS = 2_147_483_647;
    const wait = Math.min(delay, MAX_MS);
    const timeout = setTimeout(() => {
      this.onceTimeouts.delete(j.id);
      if (Date.now() >= target) {
        void this.completeOneShot(j);
      } else {
        this.scheduleOnce(j);
      }
    }, wait);
    this.onceTimeouts.set(j.id, timeout);
  }

  private async completeOneShot(j: ReminderJob): Promise<void> {
    const bot = this.getBot();
    try {
      await bot.api.sendMessage(j.chatId, reminderSendText(j), {
        reply_markup: reminderSnoozeKeyboard(j.id),
        ...reminderSendThreadOpts(j),
      });
      logInfo(`reminder once fired id=${j.id} chatId=${j.chatId}`);
    } catch (err: unknown) {
      logError(`reminder once send failed id=${j.id} chatId=${j.chatId}`, err);
    }
    await updateReminderJobInFile(this.filePath, j.id, {
      enabled: false,
      firedAt: new Date().toISOString(),
    });
  }

  async addAndSchedule(job: ReminderJob): Promise<void> {
    await appendReminderJob(this.filePath, job);
    if (job.enabled) this.scheduleJob(job);
  }

  private unscheduleById(jobId: string): void {
    const cronTask = this.cronTasks.get(jobId);
    if (cronTask) {
      void cronTask.stop();
      this.cronTasks.delete(jobId);
    }
    const once = this.onceTimeouts.get(jobId);
    if (once) {
      clearTimeout(once);
      this.onceTimeouts.delete(jobId);
    }
  }

  /** Stop in-memory tasks and delete rows from the reminders file. Returns ids actually removed. */
  async removeJobsByIds(jobIds: string[]): Promise<string[]> {
    for (const id of jobIds) {
      this.unscheduleById(id);
    }
    return removeReminderJobsByIds(this.filePath, jobIds);
  }

  stopAll(): void {
    for (const t of this.cronTasks.values()) {
      void t.stop();
    }
    this.cronTasks.clear();
    for (const t of this.onceTimeouts.values()) {
      clearTimeout(t);
    }
    this.onceTimeouts.clear();
  }
}
