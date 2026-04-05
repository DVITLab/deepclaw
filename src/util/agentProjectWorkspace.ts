import path from "node:path";

/** Every path argument for file tools and shell cwd is confined here (default: agent-data/workspace). Not overridable by DEEPCLAW_WORKSPACE. */
export function agentProjectWorkspaceRoot(dataDir: string): string {
  return path.resolve(path.join(dataDir, "workspace"));
}

export const TOOL_PATH_OUTSIDE_PROJECT_REJECT =
  "Path must lie under <data-dir>/workspace (the agent project sandbox). Use a relative path there or an absolute path inside it.";

export const WRITE_FILE_OUTSIDE_PROJECT_REJECT =
  "write_file may only create files under <data-dir>/workspace. Use a relative path there or an absolute path inside it. This rule is always enforced (ignores DEEPCLAW_WORKSPACE).";

const ALLOWED_ABS_SHELL_PATHS = new Set<string>(["/dev/null"]);

function trimShellPathToken(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[),;`]+$/g, "")
    .replace(/\)+$/g, "");
}

/**
 * Heuristic: literal Unix absolute paths in a shell string (redirect targets, path args).
 * Intentionally coarse; subshell variables and obfuscation can still bypass — cwd is also locked.
 */
export function collectShellAbsolutePathLiterals(command: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  const redirect = /(?:^|\s)\d*>>?\s*(\/[^\s'"`;|&<>]+)/g;
  while ((m = redirect.exec(command)) !== null) {
    found.add(trimShellPathToken(m[1]));
  }

  const generic =
    /(?:^|[\s=:,;'"`(|[{])(\/(?:[\w@.~-]+(?:\/[\w@.~-]+)*|\.(?:\.?))(?:\/[\w@.~-]+)*)/g;
  while ((m = generic.exec(command)) !== null) {
    found.add(trimShellPathToken(m[1]));
  }

  return [...found].filter(Boolean);
}

/** First absolute path in `command` that is not under project root (except allowlist). */
export function firstDisallowedShellAbsolutePath(
  command: string,
  projectRoot: string,
): string | null {
  const root = path.resolve(projectRoot);
  for (const raw of collectShellAbsolutePathLiterals(command)) {
    if (!raw.startsWith("/")) continue;
    const norm = path.normalize(raw);
    if (ALLOWED_ABS_SHELL_PATHS.has(norm)) continue;
    if (norm === root || norm.startsWith(root + path.sep)) continue;
    return norm;
  }
  return null;
}

export const RUN_SHELL_PATH_REJECT_PREFIX =
  "run_shell rejected: the command references an absolute filesystem path outside the project workspace:";

export function runShellPathRejectMessage(offendingPath: string): string {
  return (
    `${RUN_SHELL_PATH_REJECT_PREFIX} ${offendingPath}. ` +
    "Use only paths under <data-dir>/workspace (relative paths are resolved there). " +
    "Exception: /dev/null for redirects."
  );
}

/** Resolve user path for read/list/grep/send/write tools — always under agent project workspace. */
export function resolveToolPathUnderProjectWorkspace(
  dataDir: string,
  userPath: string,
): string | null {
  const root = agentProjectWorkspaceRoot(dataDir);
  const p = userPath.trim();
  if (!p) return null;
  if (path.isAbsolute(p)) {
    const resolved = path.normalize(p);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
    return null;
  }
  const resolved = path.resolve(root, p);
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return resolved;
  }
  return null;
}
