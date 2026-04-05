import fs from "node:fs";
import os from "node:os";

/**
 * Heuristic: Docker creates `/.dockerenv`; Linux cgroups often name the runtime.
 * Not all engines set `/.dockerenv` (e.g. some Podman setups); cgroup names help.
 */
export function isRunningInContainer(): boolean {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {
    /* ignore */
  }
  if (os.platform() === "linux") {
    try {
      const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
      if (/\/(docker|kubepods|libpod|containerd|crio|lxc)\b/i.test(cgroup)) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function assertContainerRequired(feature: string): void {
  if (isRunningInContainer()) return;
  throw new Error(
    `${feature} is only supported inside a container. Use Docker (e.g. docker compose up). See README.`,
  );
}
