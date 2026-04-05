import { spawn } from "node:child_process";
import path from "node:path";

export type WhisperTranscribeConfig = {
  whisperPython: string;
  whisperModel: string;
  whisperDevice: string;
  whisperComputeType: string;
  whisperTimeoutMs: number;
};

function resolvedPython(explicit: string): string {
  const t = explicit.trim();
  return t || "python3";
}

function scriptPath(): string {
  return path.resolve(process.cwd(), "scripts", "whisper_transcribe.py");
}

/**
 * Run local faster-whisper via `scripts/whisper_transcribe.py`.
 * Requires `pip install faster-whisper` in the chosen Python environment and ffmpeg on PATH.
 */
export async function transcribeVoiceFileLocal(
  audioFilePath: string,
  cfg: WhisperTranscribeConfig,
): Promise<string> {
  const py = resolvedPython(cfg.whisperPython);
  const script = scriptPath();
  const childEnv = {
    ...process.env,
    DEEPCLAW_WHISPER_MODEL: cfg.whisperModel,
    DEEPCLAW_WHISPER_DEVICE: cfg.whisperDevice,
    DEEPCLAW_WHISPER_COMPUTE_TYPE: cfg.whisperComputeType,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, audioFilePath], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Voice transcription timed out"));
    }, cfg.whisperTimeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(
          new Error(
            `Python not found (${py}). Set DEEPCLAW_WHISPER_PYTHON to your venv python (see README).`,
          ),
        );
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const body = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0) {
        const errText = Buffer.concat(err).toString("utf8").trim().slice(0, 800);
        reject(
          new Error(
            errText
              ? `Whisper failed (exit ${code}): ${errText}`
              : `Whisper failed with exit ${code}`,
          ),
        );
        return;
      }
      resolve(body);
    });
  });
}
