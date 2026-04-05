import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OCR_TIMEOUT_MS = 90_000;

/** Default cap for OCR text passed to the LLM (characters). */
export const OCR_MAX_OUTPUT_CHARS = 12_000;

export function truncateOcrText(s: string, maxChars: number = OCR_MAX_OUTPUT_CHARS): string {
  const t = s.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n…[OCR truncated]`;
}

function runTesseractStdout(inputPath: string, langs: string): Promise<string> {
  const langArg = langs.trim() || "eng";
  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", [inputPath, "stdout", "-l", langArg], {
      env: { ...process.env, LC_ALL: "C.UTF-8" },
      timeout: OCR_TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(
          new Error(
            "tesseract not found — install Tesseract OCR (e.g. apt install tesseract-ocr) or use the Docker image",
          ),
        );
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      const body = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0) {
        const errText = Buffer.concat(err).toString().trim().slice(0, 800);
        reject(new Error(`tesseract failed (exit ${code})${errText ? `: ${errText}` : ""}`));
        return;
      }
      resolve(body);
    });
  });
}

/**
 * Extract text from an image using the local `tesseract` CLI (free, open source).
 * Writes a temp file because Tesseract expects a path.
 */
export async function ocrImageBuffer(
  imageBytes: Buffer,
  langs: string,
  maxOutputChars: number = OCR_MAX_OUTPUT_CHARS,
): Promise<string> {
  if (imageBytes.length === 0) return "";
  const dir = await mkdtemp(join(tmpdir(), "deepclaw-ocr-"));
  const inputPath = join(dir, "in");
  try {
    await writeFile(inputPath, imageBytes);
    const raw = await runTesseractStdout(inputPath, langs);
    return truncateOcrText(raw, maxOutputChars);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
