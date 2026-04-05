import fs from "node:fs";

/**
 * Ensures the agent workspace directory exists (sandbox for shell + read_file).
 */
export function ensureAgentWorkspace(resolvedPath: string): void {
  fs.mkdirSync(resolvedPath, { recursive: true });
}
