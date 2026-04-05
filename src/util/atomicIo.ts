import fs from "node:fs/promises";
import path from "node:path";
import { logWarn } from "./logger.js";

/** Timestamp suffix for backup filenames (local time via ISO). */
function corruptBackupSuffix(): string {
  const s = new Date().toISOString().replace(/[:.]/g, "-");
  return s.slice(0, 19);
}

/**
 * Move a corrupt file aside so a new file can be created. Same directory, unique name.
 * Logs on failure (best effort).
 */
export async function backupCorruptFile(
  filePath: string,
  reason: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const bak = path.join(
    dir,
    `${base}.corrupt-${corruptBackupSuffix()}.${reason}.bak`,
  );
  try {
    await fs.rename(filePath, bak);
    logWarn(`corrupt file moved to backup: ${bak} (${reason})`);
  } catch (e) {
    logWarn(
      `corrupt file backup failed ${filePath} → ${bak}: ${String(e)} (${reason})`,
    );
  }
}
