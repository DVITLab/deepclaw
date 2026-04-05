import { spawn } from "node:child_process";

const PROBE_MS = 12_000;

/** True if `python -c "import faster_whisper"` exits 0 within PROBE_MS. */
export function probeWhisperImport(pythonBinary: string): Promise<boolean> {
  const py = pythonBinary.trim() || "python3";
  return new Promise((resolve) => {
    const child = spawn(py, ["-c", "import faster_whisper"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, PROBE_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
