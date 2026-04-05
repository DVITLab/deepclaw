/**
 * Detect shell commands that typically block until Ctrl+C (dev servers).
 * When these run without nohup/background &, run_shell would hang until tool timeout.
 */

const HINT =
  "That command would block the agent until the shell tool times out (dev servers keep running). " +
  "Run the server in the background instead, then verify with curl or logs (keep logs under the project workspace, e.g. ./.http-server.log). " +
  "Examples:\n" +
  "  nohup python3 -m http.server 8000 --bind 0.0.0.0 > ./.http-server.log 2>&1 & sleep 1; tail -5 ./.http-server.log\n" +
  "  nohup npx vite --host 0.0.0.0 --port 5173 > ./.vite.log 2>&1 & sleep 2; tail -8 ./.vite.log\n" +
  "Tell the user the host-mapped URL (see system prompt for Docker port mapping).";

/**
 * True if the command likely backgrounds a long-running job (nohup or shell `&`),
 * including `cmd & sleep 1` style (not only trailing `&`).
 * Excludes `>&` / `2>&1` style redirects via `(?<![>&])` before the job-control `&`.
 */
export function hasShellBackground(cmd: string): boolean {
  return (
    /\bnohup\b/i.test(cmd) ||
    /\s&\s*$/.test(cmd) ||
    /;\s*&\s*$/.test(cmd) ||
    /&&\s*&\s*$/.test(cmd) ||
    /* `python ... 2>&1 & sleep 2 && curl ...` — background then continue in foreground */
    /(?<![>&])\s&\s+\S/.test(cmd)
  );
}

/**
 * True if `cmd` looks like a long-running local dev server without backgrounding.
 * Conservative: avoids matching `vite build`, `npm run build`, etc.
 */
export function isForegroundBlockingDevServerCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || hasShellBackground(c)) return false;

  if (/\bnpm\s+run\s+dev\b/i.test(c)) return true;
  if (/\bnpm\s+start\b/i.test(c)) return true;
  if (/\bnext\s+dev\b/i.test(c)) return true;
  if (/\bnpx\s+serve\b/i.test(c)) return true;
  if (/\bwebpack\s+serve\b/i.test(c)) return true;
  if (/\bpython\d*\s+(-m\s+)?http\.server\b/i.test(c)) return true;
  if (/\bvite\s+dev\b/i.test(c)) return true;
  if (/\bvite\s+preview\b/i.test(c)) return true;
  /* `npx vite` and `npx vite preview` block; `npx vite build` exits. */
  if (/\bnpx\s+vite\b(?!\s+build\b)/i.test(c)) return true;
  if (/\b&&\s*vite\s*$/i.test(c)) return true;
  if (/;\s*vite\s*$/i.test(c)) return true;
  if (/^vite\s*$/i.test(c)) return true;

  return false;
}

export function foregroundDevServerRejectionMessage(): string {
  return HINT;
}
