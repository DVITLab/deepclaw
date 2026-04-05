import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

type LogTraceStore = { traceId: string };

/** Correlation id for log lines (set by Telegram middleware). */
export const logTraceStorage = new AsyncLocalStorage<LogTraceStore>();

function tracePrefix(): string {
  const s = logTraceStorage.getStore();
  return s ? `traceId=${s.traceId} ` : "";
}

/** Resolved base path from config (e.g. .../deepclaw.log); actual files are daily. */
let logBasePath: string | null = null;

/** Call once at startup. Use "-", or "none" to disable file logging. */
export function configureLogging(resolvedPath: string): void {
  const p = resolvedPath.trim();
  if (!p || p === "-" || p.toLowerCase() === "none") {
    logBasePath = null;
    return;
  }
  logBasePath = path.resolve(p);
}

/** Calendar date YYYY-MM-DD in `process.env.TZ` for log filename rotation (aligned with log line timestamps). */
export function logDateStringLocal(): string {
  const stamp = formatLogTimestamp(new Date());
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(stamp);
  if (m) return m[1]!;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build today's log file path from the configured base (e.g. logs/deepclaw.log -> logs/deepclaw-2026-04-04.log).
 */
export function dailyLogFilePath(basePath: string): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = ext ? path.basename(basePath, ext) : path.basename(basePath);
  const suffix = ext || ".log";
  return path.join(dir, `${stem}-${logDateStringLocal()}${suffix}`);
}

async function appendLine(line: string): Promise<void> {
  if (logBasePath === null) return;
  const file = dailyLogFilePath(logBasePath);
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(file, `${line}\n`, "utf8");
}

/** Log line timestamp: matches `process.env.TZ` after `loadConfig()` (e.g. DEEPCLAW_TZ). */
export function formatLogTimestamp(d: Date = new Date()): string {
  const tzRaw = process.env.TZ?.trim();
  if (
    !tzRaw ||
    tzRaw === "-" ||
    tzRaw.toLowerCase() === "utc" ||
    tzRaw.toLowerCase() === "gmt"
  ) {
    return d.toISOString();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tzRaw,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      fractionalSecondDigits: 3,
    }).formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const mo = get("month");
    const da = get("day");
    const h = get("hour");
    const mi = get("minute");
    const s = get("second");
    const fr = get("fractionalSecond");
    const ms = fr ? `.${fr}` : "";
    return `${y}-${mo}-${da}T${h}:${mi}:${s}${ms} [${tzRaw}]`;
  } catch {
    return d.toISOString();
  }
}

function stamp(): string {
  return formatLogTimestamp();
}

export function logInfo(msg: string): void {
  const line = `[${stamp()}] INFO ${tracePrefix()}${msg}`;
  console.log(line);
  void appendLine(line).catch((e) => {
    console.error("[deepclaw] log file write failed:", e);
  });
}

export function logWarn(msg: string): void {
  const line = `[${stamp()}] WARN ${tracePrefix()}${msg}`;
  console.warn(line);
  void appendLine(line).catch(() => undefined);
}

export function logError(msg: string, err?: unknown): void {
  const extra =
    err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : "";
  const line = `[${stamp()}] ERROR ${tracePrefix()}${msg}${extra}`;
  console.error(line);
  void appendLine(line).catch(() => undefined);
}

/** Configured base path, or null if file logging is off. */
export function getConfiguredLogBasePath(): string | null {
  return logBasePath;
}

/** Today's log file (derived from base), or null if file logging is off. */
export function getConfiguredLogFilePath(): string | null {
  if (logBasePath === null) return null;
  return dailyLogFilePath(logBasePath);
}
