import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { BrowserSession } from "./browser.js";
import { downloadImageToTempFile } from "./fetchImageUrl.js";
import { longTermMemoryFilePath } from "../chatHistoryPersistence.js";
import {
  agentProjectWorkspaceRoot,
  firstDisallowedShellAbsolutePath,
  resolveToolPathUnderProjectWorkspace,
  runShellPathRejectMessage,
  TOOL_PATH_OUTSIDE_PROJECT_REJECT,
  WRITE_FILE_OUTSIDE_PROJECT_REJECT,
} from "../util/agentProjectWorkspace.js";
import { logWarn } from "../util/logger.js";
import { isDangerousShellCommand } from "../util/shellRisk.js";
import {
  foregroundDevServerRejectionMessage,
  hasShellBackground,
  isForegroundBlockingDevServerCommand,
} from "../util/devServerForeground.js";

const MAX_LONG_TERM_MEMORY_READ = 32_000;
const MAX_LONG_TERM_MEMORY_WRITE = 65_536;

/** Set each agent turn; run_shell may await `request` before executing. */
export type ShellApprovalBridge = {
  request?: (command: string) => Promise<boolean>;
};

/** Current chat id for long-term memory tools. */
export type MemoryChatIdBridge = {
  chatId: string;
};

/** Return false if the per-turn image cap is reached (caller should delete temp file). */
export type ImageAttachmentBridge = (
  absolutePath: string,
  caption: string,
) => boolean;

const MAX_TOOL_CHARS = 24_000;
const DEFAULT_READ_MAX = 8_000;
/** After SIGTERM, SIGKILL the shell group if still alive. */
const SHELL_KILL_GRACE_MS = 3500;
/** Telegram Bot API document limit (bytes). */
const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024;
const MAX_WRITE_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIST_MAX = 200;
const CAP_LIST_MAX = 500;
const LIST_RECURSIVE_MAX_DEPTH = 2;
const GREP_TIMEOUT_MS = 30_000;
const DEFAULT_GREP_MAX = 200;
const CAP_GREP_MAX = 500;
const GIT_CAPTURE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_OUT = 12_000;
const RUN_TESTS_TIMEOUT_MS = 300_000;

function shellAllowed(
  command: string,
  allowlist: string[],
  fullContainerAccess: boolean,
): boolean {
  const c = command.trim();
  if (!c) return false;
  if (fullContainerAccess && allowlist.length === 0) {
    return true;
  }
  if (allowlist.some((p) => p.trim() === "*")) {
    return true;
  }
  return allowlist.some((prefix) => {
    const p = prefix.trim();
    if (!p) return false;
    return c.startsWith(p);
  });
}

/**
 * Broader heuristic: likely blocking dev server without backgrounding (shorter timeout cap).
 * Stricter immediate reject uses {@link isForegroundBlockingDevServerCommand}.
 */
export function shellCommandLooksLikeBlockingServer(trimmedCmd: string): boolean {
  return (
    /http\.server|python\s+(-m\s+)?http\.server|vite|webpack|next\s+dev|npx\s+serve|npm\s+run\s+dev|npm\s+start\b/i.test(
      trimmedCmd,
    ) && !hasShellBackground(trimmedCmd)
  );
}

function killShellRoot(pid: number, sig: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, sig);
    } catch {
      /* ESRCH */
    }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* ESRCH */
    }
  }
}

export class ToolExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly browser: BrowserSession,
    private readonly attachFileForUser?: (absolutePath: string) => void,
    private readonly shellApprovalBridge?: ShellApprovalBridge,
    private readonly memoryChatIdBridge?: MemoryChatIdBridge,
    private readonly attachImageForUser?: ImageAttachmentBridge,
  ) {}

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "run_shell":
          return await this.runShell(String(args.command ?? ""));
        case "read_file":
          return await this.readFile(
            String(args.path ?? ""),
            typeof args.max_chars === "number" ? args.max_chars : DEFAULT_READ_MAX,
          );
        case "send_file":
          return await this.sendFile(String(args.path ?? ""));
        case "write_file":
          return await this.writeFile(
            String(args.path ?? ""),
            String(args.content ?? ""),
            Boolean(args.create_directories),
          );
        case "list_dir":
          return await this.listDir(
            typeof args.path === "string" ? args.path : ".",
            typeof args.max_entries === "number" ? args.max_entries : DEFAULT_LIST_MAX,
            Boolean(args.recursive),
          );
        case "grep_workspace":
          return await this.grepWorkspace(
            String(args.pattern ?? ""),
            typeof args.path === "string" ? args.path : "",
            typeof args.glob === "string" ? args.glob : "",
            typeof args.max_matches === "number" ? args.max_matches : DEFAULT_GREP_MAX,
          );
        case "git_status":
          return await this.gitStatus();
        case "git_diff_stat":
          return await this.gitDiffStat(String(args.path ?? ""));
        case "run_tests":
          return await this.runTestsPreset(String(args.preset ?? "npm_test"));
        case "browse_web":
          return await this.browser.fetchPageText(String(args.url ?? ""));
        case "send_image_url":
          return await this.sendImageUrl(
            String(args.url ?? ""),
            String(args.caption ?? ""),
          );
        case "read_long_term_memory":
          return await this.readLongTermMemory(
            typeof args.max_chars === "number" ? args.max_chars : MAX_LONG_TERM_MEMORY_READ,
          );
        case "write_long_term_memory":
          return await this.writeLongTermMemory(String(args.content ?? ""));
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Tool error (${name}): ${msg}`;
    }
  }

  private async runShell(command: string): Promise<string> {
    if (!this.config.shellEnabled) {
      return "run_shell is disabled (safe mode — unset DEEPCLAW_SAFE_MODE or set 0/false for full tools).";
    }
    if (
      !shellAllowed(
        command,
        this.config.shellAllowlist,
        this.config.fullContainerAccess,
      )
    ) {
      return "Command not allowed (internal allowlist).";
    }
    const trimmedCmd = command.trim();
    const projectWs = agentProjectWorkspaceRoot(this.config.dataDir);
    const outsideShell = firstDisallowedShellAbsolutePath(trimmedCmd, projectWs);
    if (outsideShell) {
      return runShellPathRejectMessage(outsideShell);
    }
    if (isForegroundBlockingDevServerCommand(trimmedCmd)) {
      logWarn(
        `run_shell: rejected foreground dev server (would block until timeout): ${trimmedCmd.slice(0, 200)}${trimmedCmd.length > 200 ? "…" : ""}`,
      );
      return foregroundDevServerRejectionMessage();
    }
    const looksLikeBlocking = shellCommandLooksLikeBlockingServer(trimmedCmd);
    const effectiveTimeoutMs = looksLikeBlocking
      ? this.config.shellBlockingTimeoutMs
      : this.config.shellTimeoutMs;
    if (looksLikeBlocking) {
      logWarn(
        `run_shell: likely blocking dev server (no background); time limit ${effectiveTimeoutMs}ms: ${trimmedCmd.slice(0, 160)}${trimmedCmd.length > 160 ? "…" : ""}`,
      );
    }
    const mode = this.config.shellApprovalMode;
    const needApproval = mode === "dangerous" && isDangerousShellCommand(trimmedCmd);
    if (needApproval) {
      const req = this.shellApprovalBridge?.request;
      if (!req) {
        return "That command needs your confirmation in chat, but approval is not connected here. It was not run.";
      }
      const ok = await req(trimmedCmd);
      if (!ok) {
        return "You cancelled or did not confirm in time, so that command was not run.";
      }
    }
    return await this.runShellSpawn(
      command,
      projectWs,
      effectiveTimeoutMs,
    );
  }

  /**
   * POSIX: detached bash as process-group leader so kill(-pid) stops dev servers under it.
   * Windows: non-detached; root kill only (best effort).
   */
  private runShellSpawn(
    command: string,
    shellCwd: string,
    effectiveTimeoutMs: number,
  ): Promise<string> {
    const usePgroup = process.platform !== "win32";
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: shellCwd,
        env: { ...process.env, LC_ALL: "C.UTF-8" },
        detached: usePgroup,
        stdio: "pipe",
      });
      const bashPid = child.pid;
      if (bashPid === undefined) {
        resolve("spawn error: no pid");
        return;
      }

      let out = "";
      let err = "";
      let timedOut = false;
      let finished = false;

      const watchdog = setTimeout(() => {
        timedOut = true;
        logWarn(
          `run_shell: wall timeout ${effectiveTimeoutMs}ms reached, sending SIGTERM to process group ${bashPid}`,
        );
        killShellRoot(bashPid, "SIGTERM");
      }, effectiveTimeoutMs);

      const hardKill = setTimeout(() => {
        if (finished) return;
        logWarn(`run_shell: SIGKILL process group ${bashPid} after grace`);
        killShellRoot(bashPid, "SIGKILL");
      }, effectiveTimeoutMs + SHELL_KILL_GRACE_MS);

      const finish = (body: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        clearTimeout(hardKill);
        resolve(body.slice(0, MAX_TOOL_CHARS));
      };

      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        finish(`spawn error: ${e.message}`);
      });
      child.on("close", (code, signal) => {
        const parts: string[] = [];
        if (timedOut) {
          const sec = Math.max(1, Math.ceil(effectiveTimeoutMs / 1000));
          parts.push(
            `Shell stopped after ${sec}s (run_shell time limit). Long-running dev servers must run in the background.`,
          );
          parts.push(foregroundDevServerRejectionMessage());
        }
        if (code !== null && code !== 0) {
          parts.push(`exit code: ${code}`);
        }
        if (signal) {
          parts.push(
            `subprocess signal: ${signal}${code === null ? " (often: time limit or killed long-running foreground process)" : ""}`,
          );
          if (!timedOut) {
            parts.push(
              "Hint for web servers: run in background under the project workspace, e.g. `nohup python3 -m http.server 8000 --bind 0.0.0.0 > ./.http-server.log 2>&1 & sleep 1; head -5 ./.http-server.log`",
            );
          }
        }
        if (out) parts.push(`stdout:\n${out}`);
        if (err) parts.push(`stderr:\n${err}`);
        const combined = parts.filter(Boolean).join("\n\n");
        finish(combined || "(no output)");
      });
    });
  }

  private async writeFile(
    userPath: string,
    content: string,
    createDirectories: boolean,
  ): Promise<string> {
    const full = resolveToolPathUnderProjectWorkspace(this.config.dataDir, userPath);
    if (!full) {
      return WRITE_FILE_OUTSIDE_PROJECT_REJECT;
    }
    const buf = Buffer.from(content, "utf8");
    if (buf.length > MAX_WRITE_FILE_BYTES) {
      return `Content too large (max ${MAX_WRITE_FILE_BYTES} bytes).`;
    }
    try {
      const parent = path.dirname(full);
      if (createDirectories) {
        await fs.mkdir(parent, { recursive: true });
      }
      const tmp = path.join(
        parent,
        `.write_${path.basename(full)}.${randomBytes(8).toString("hex")}.tmp`,
      );
      await fs.writeFile(tmp, buf, { flag: "w", mode: 0o644 });
      await fs.rename(tmp, full);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `write_file failed: ${msg}`;
    }
    const displayRoot = agentProjectWorkspaceRoot(this.config.dataDir);
    return `Wrote ${buf.length} bytes to ${path.relative(displayRoot, full) || "."}`;
  }

  private async listDir(
    userPath: string,
    maxEntries: number,
    recursive: boolean,
  ): Promise<string> {
    const cap = Math.min(Math.max(1, maxEntries), CAP_LIST_MAX);
    const raw = userPath.trim() || ".";
    const full = resolveToolPathUnderProjectWorkspace(this.config.dataDir, raw);
    if (!full) {
      return TOOL_PATH_OUTSIDE_PROJECT_REJECT;
    }
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(full);
    } catch {
      return `Not found: ${userPath}`;
    }
    if (!st.isDirectory()) {
      return "Not a directory.";
    }
    const lines: string[] = [];
    const root = full;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (lines.length >= cap) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (lines.length >= cap) break;
        const abs = path.join(dir, ent.name);
        const rel = path.relative(root, abs) || ".";
        lines.push(ent.isDirectory() ? `[dir] ${rel}/` : rel);
        if (
          recursive &&
          ent.isDirectory() &&
          depth < LIST_RECURSIVE_MAX_DEPTH &&
          lines.length < cap
        ) {
          await walk(abs, depth + 1);
        }
      }
    };

    await walk(full, 0);
    if (lines.length === 0) {
      return "(empty directory)";
    }
    const suffix = lines.length >= cap ? `\n...[truncated at ${cap} entries]` : "";
    return lines.join("\n") + suffix;
  }

  private async grepWorkspace(
    pattern: string,
    userPath: string,
    glob: string,
    maxMatches: number,
  ): Promise<string> {
    if (!pattern.trim()) {
      return "pattern is required.";
    }
    const cap = Math.min(Math.max(1, maxMatches), CAP_GREP_MAX);
    const raw = userPath.trim() || ".";
    const resolved = resolveToolPathUnderProjectWorkspace(this.config.dataDir, raw);
    if (!resolved) {
      return TOOL_PATH_OUTSIDE_PROJECT_REJECT;
    }
    try {
      await fs.stat(resolved);
    } catch {
      return `Not found: ${userPath}`;
    }

    const args = [
      "--line-number",
      "--color",
      "never",
      "--max-count",
      String(cap),
      "--max-columns",
      "400",
    ];
    if (glob.trim()) {
      args.push("--glob", glob.trim());
    }
    args.push(pattern);
    args.push(resolved);

    const rgCwd = agentProjectWorkspaceRoot(this.config.dataDir);
    return await new Promise((resolve) => {
      const child = spawn("rg", args, {
        cwd: rgCwd,
        env: { ...process.env, LC_ALL: "C.UTF-8" },
        timeout: GREP_TIMEOUT_MS,
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        resolve(`grep_workspace failed (is ripgrep installed?): ${e.message}`);
      });
      child.on("close", (code) => {
        if (code === 1 && !out) {
          resolve("(no matches)");
          return;
        }
        if (code !== 0 && code !== 1) {
          const msg = [err && `stderr:\n${err}`, out && `stdout:\n${out}`]
            .filter(Boolean)
            .join("\n");
          resolve(`rg exited ${code}${msg ? `\n${msg}` : ""}`);
          return;
        }
        const combined = out.slice(0, MAX_TOOL_CHARS);
        resolve(
          combined.length < out.length ? `${combined}\n...[truncated]` : combined || "(no matches)",
        );
      });
    });
  }

  private async spawnCaptured(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<string> {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, LC_ALL: "C.UTF-8" },
        timeout: timeoutMs,
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        resolve(`${command}: ${e.message}`);
      });
      child.on("close", (code, killSignal) => {
        const parts: string[] = [];
        if (killSignal) parts.push(`signal: ${killSignal}`);
        if (code !== null && code !== 0) parts.push(`exit code: ${code}`);
        if (err.trim()) parts.push(`stderr:\n${err.trim()}`);
        if (out.trim()) parts.push(out.trim());
        const combined = parts.filter(Boolean).join("\n\n") || "(no output)";
        const cap = combined.slice(0, MAX_CAPTURE_OUT);
        resolve(cap.length < combined.length ? `${cap}\n...[truncated]` : cap);
      });
    });
  }

  private async gitStatus(): Promise<string> {
    const wd = agentProjectWorkspaceRoot(this.config.dataDir);
    return this.spawnCaptured(
      "git",
      ["-c", "safe.directory=*", "-C", wd, "status", "--porcelain", "-b"],
      wd,
      GIT_CAPTURE_TIMEOUT_MS,
    );
  }

  private async gitDiffStat(userPath: string): Promise<string> {
    const wd = agentProjectWorkspaceRoot(this.config.dataDir);
    const args = ["-c", "safe.directory=*", "-C", wd, "diff", "--stat"];
    const rel = userPath.trim();
    if (rel) {
      const full = resolveToolPathUnderProjectWorkspace(this.config.dataDir, rel);
      if (!full) {
        return TOOL_PATH_OUTSIDE_PROJECT_REJECT;
      }
      args.push("--", rel);
    }
    return this.spawnCaptured("git", args, wd, GIT_CAPTURE_TIMEOUT_MS);
  }

  private async runTestsPreset(preset: string): Promise<string> {
    if (!this.config.runTestsToolEnabled) {
      return "run_tests is disabled (DEEPCLAW_RUN_TESTS_TOOL=0 or safe mode).";
    }
    const wd = agentProjectWorkspaceRoot(this.config.dataDir);
    const p = preset.trim().toLowerCase();
    if (p === "npm_test" || p === "npm") {
      return this.spawnCaptured("npm", ["test"], wd, RUN_TESTS_TIMEOUT_MS);
    }
    if (p === "pytest") {
      return this.spawnCaptured("pytest", ["-q", "--maxfail", "1"], wd, RUN_TESTS_TIMEOUT_MS);
    }
    return "Unknown preset. Use npm_test or pytest.";
  }

  private async sendImageUrl(url: string, caption: string): Promise<string> {
    if (!this.config.browserEnabled) {
      return "send_image_url is disabled (safe mode — full tools required).";
    }
    if (!this.attachImageForUser) {
      return "send_image_url is not available in this channel.";
    }
    const cap = caption.trim();
    if (!cap) {
      return "caption is required: a short alt-style description tied to your answer (why this image helps).";
    }
    const telegramCap = cap.length > 1024 ? cap.slice(0, 1024) : cap;
    const dl = await downloadImageToTempFile(url, this.config, this.browser);
    if (!dl.ok) {
      return dl.error;
    }
    const attached = this.attachImageForUser(dl.filePath, telegramCap);
    if (!attached) {
      try {
        await fs.unlink(dl.filePath);
      } catch {
        /* ignore */
      }
      return "Maximum reference images for this reply reached; skip extra images or summarize in text only.";
    }
    return `Queued reference image for Telegram (${telegramCap.slice(0, 120)}${telegramCap.length > 120 ? "…" : ""}).`;
  }

  private async sendFile(userPath: string): Promise<string> {
    if (!this.attachFileForUser) {
      return "send_file is not available in this channel.";
    }
    const full = resolveToolPathUnderProjectWorkspace(this.config.dataDir, userPath);
    if (!full) {
      return TOOL_PATH_OUTSIDE_PROJECT_REJECT;
    }
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(full);
    } catch {
      return `File not found: ${userPath}`;
    }
    if (!st.isFile()) {
      return "Not a regular file.";
    }
    if (st.size === 0) {
      return "File is empty.";
    }
    if (st.size > MAX_SEND_FILE_BYTES) {
      return "File too large for Telegram (max 50 MB).";
    }
    this.attachFileForUser(full);
    return `Queued for Telegram: ${path.basename(full)} (${st.size} bytes).`;
  }

  private async readFile(userPath: string, maxChars: number): Promise<string> {
    const full = resolveToolPathUnderProjectWorkspace(this.config.dataDir, userPath);
    if (!full) {
      return TOOL_PATH_OUTSIDE_PROJECT_REJECT;
    }
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(full);
    } catch {
      return `File not found: ${userPath}`;
    }
    if (!st.isFile()) {
      return "Not a regular file.";
    }
    if (st.size > 2 * 1024 * 1024) {
      return "File too large (> 2 MiB).";
    }
    const buf = await fs.readFile(full);
    const text = buf.toString("utf8");
    const mc = Math.min(maxChars, MAX_TOOL_CHARS);
    return text.length > mc ? text.slice(0, mc) + "\n...[truncated]" : text;
  }

  private longTermMemoryAbsPath(): string | null {
    if (!this.config.longTermMemoryEnabled) return null;
    const id = this.memoryChatIdBridge?.chatId?.trim();
    if (!id) return null;
    return longTermMemoryFilePath(this.config.longTermMemoryDir, id);
  }

  private async readLongTermMemory(maxChars: number): Promise<string> {
    const abs = this.longTermMemoryAbsPath();
    if (!abs) {
      return "Long-term memory is not available for this chat.";
    }
    const cap = Math.min(Math.max(256, maxChars), MAX_LONG_TERM_MEMORY_READ);
    try {
      const buf = await fs.readFile(abs, "utf8");
      const t = buf.trim();
      if (!t) return "(No long-term notes saved yet for this chat.)";
      return t.length > cap ? `${t.slice(0, cap)}\n...[truncated]` : t;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return "(No long-term notes saved yet for this chat.)";
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `read_long_term_memory failed: ${msg}`;
    }
  }

  private async writeLongTermMemory(content: string): Promise<string> {
    const abs = this.longTermMemoryAbsPath();
    if (!abs) {
      return "Long-term memory is not available for this chat.";
    }
    const buf = Buffer.from(content, "utf8");
    if (buf.length > MAX_LONG_TERM_MEMORY_WRITE) {
      return `Content too large (max ${MAX_LONG_TERM_MEMORY_WRITE} bytes).`;
    }
    try {
      const dir = this.config.longTermMemoryDir;
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(
        dir,
        `.ltm_${path.basename(abs)}.${randomBytes(8).toString("hex")}.tmp`,
      );
      await fs.writeFile(tmp, buf, { flag: "w", mode: 0o644 });
      await fs.rename(tmp, abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `write_long_term_memory failed: ${msg}`;
    }
    return `Saved ${buf.length} bytes of long-term notes for this chat.`;
  }
}
