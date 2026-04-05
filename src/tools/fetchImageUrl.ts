import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { readBodyCapped } from "../util/readBodyCapped.js";
import {
  assertBrowseWebUrl,
  BROWSE_WEB_USER_AGENT,
  type BrowserSession,
} from "./browser.js";

/** Telegram upload practical limit for photos (bytes). */
export const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Used on HTTP retry attempts when the bot UA or first attempt is blocked. */
export const CHROME_COMPAT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RETRYABLE_HTTP_STATUS = new Set([401, 403, 429, 502, 503, 504]);

function detectImageMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true;
  }
  const head4 = buf.subarray(0, 4).toString("ascii");
  if (head4 === "GIF8") return true;
  if (
    head4 === "RIFF" &&
    buf.length >= 12 &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }
  return false;
}

function isLikelyImageBuffer(buf: Buffer, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) {
    if (ct.includes("svg")) return false;
    return true;
  }
  return detectImageMagic(buf);
}

function guessExtension(buf: Buffer, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "RIFF") {
    return ".webp";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return ".png";
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "GIF") {
    return ".gif";
  }
  return ".jpg";
}

function bodySnippet(buf: Buffer, maxChars: number): string {
  const t = buf
    .subarray(0, Math.min(buf.length, maxChars))
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

function httpErrorDetail(status: number, buf: Buffer): string {
  const snip = buf.length > 0 ? bodySnippet(buf, 800) : "";
  const hint = snip ? ` Response snippet: ${snip}` : "";
  return `HTTP ${status} when fetching image.${hint}`;
}

type HeaderVariant = 0 | 1 | 2;

function buildImageFetchHeaders(
  url: URL,
  config: AppConfig,
  variant: HeaderVariant,
): Record<string, string> {
  const customUa = config.imageFetchUserAgent.trim();
  let ua: string;
  if (variant === 0) {
    ua = customUa || BROWSE_WEB_USER_AGENT;
  } else {
    ua = customUa || CHROME_COMPAT_UA;
  }
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "image/*,*/*;q=0.8",
    "Accept-Language": ACCEPT_LANGUAGE,
  };
  const useReferer =
    config.imageFetchReferrerPolicy === "same-origin" && variant < 2;
  if (useReferer) {
    headers.Referer = `${url.origin}/`;
  }
  return headers;
}

type HttpImageAttempt =
  | { ok: true; buffer: Buffer; contentType: string }
  | {
      ok: false;
      error: string;
      lastStatus?: number;
      tryPlaywrightFallback?: boolean;
      abortedSibling?: boolean;
    };

/** One HTTP attempt; aborted when another parallel variant wins or `outer` fires. */
async function fetchImageHttpVariant(
  url: URL,
  config: AppConfig,
  variant: HeaderVariant,
  outer: AbortSignal,
): Promise<HttpImageAttempt> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.browserTimeoutMs);
  const onOuterAbort = () => ac.abort();
  outer.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url.href, {
      headers: buildImageFetchHeaders(url, config, variant),
      signal: ac.signal,
      redirect: "follow",
    });
    const lastStatus = res.status;
    const rawCt = res.headers.get("content-type");
    const contentType = rawCt?.split(";")[0]?.trim().toLowerCase() ?? "";
    const lenHeader = res.headers.get("content-length");
    if (lenHeader) {
      const n = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(n) && n > MAX_TELEGRAM_PHOTO_BYTES) {
        return {
          ok: false,
          error: "Image too large (server Content-Length).",
          lastStatus,
        };
      }
    }

    const buf = await readBodyCapped(res, MAX_TELEGRAM_PHOTO_BYTES);
    if (!buf || buf.length === 0) {
      const err = res.ok
        ? "Empty response or image larger than download limit."
        : httpErrorDetail(res.status, Buffer.alloc(0));
      return {
        ok: false,
        error: err,
        lastStatus,
        tryPlaywrightFallback: res.ok ? true : RETRYABLE_HTTP_STATUS.has(res.status),
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: httpErrorDetail(res.status, buf),
        lastStatus,
        tryPlaywrightFallback: RETRYABLE_HTTP_STATUS.has(res.status),
      };
    }

    if (!isLikelyImageBuffer(buf, contentType)) {
      return {
        ok: false,
        error:
          "Response is not a supported image (direct JPEG/PNG/GIF/WebP URL required). " +
          "The server may have returned HTML (login wall, hotlink block, or wrong URL). " +
          "Try a direct image link, upload.wikimedia.org for Commons, or set DEEPCLAW_SEND_IMAGE_FETCH_MODE=auto or playwright.",
        tryPlaywrightFallback: true,
      };
    }

    return { ok: true, buffer: buf, contentType };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (outer.aborted) {
        return {
          ok: false,
          error: "aborted",
          abortedSibling: true,
        };
      }
      return { ok: false, error: "Image download timed out." };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Image download failed: ${msg}` };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onOuterAbort);
  }
}

async function tryFetchImageHttp(
  url: URL,
  config: AppConfig,
): Promise<
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; error: string; lastStatus?: number; tryPlaywrightFallback?: boolean }
> {
  const parent = new AbortController();
  const variants = [0, 1, 2] as const;
  const attempts = variants.map((variant) =>
    fetchImageHttpVariant(url, config, variant, parent.signal).then((r) => {
      if (r.ok) {
        parent.abort();
      }
      return r;
    }),
  );
  const results = await Promise.all(attempts);

  for (const r of results) {
    if (r.ok) {
      return r;
    }
  }

  let lastError = "Image download failed.";
  let lastStatus: number | undefined;
  let tryPlaywrightFallback = false;
  for (const r of results) {
    if (!r.ok && !r.abortedSibling) {
      lastError = r.error;
      lastStatus = r.lastStatus ?? lastStatus;
      tryPlaywrightFallback =
        tryPlaywrightFallback || !!r.tryPlaywrightFallback;
    }
  }

  return {
    ok: false,
    error: lastError,
    lastStatus,
    tryPlaywrightFallback,
  };
}

async function tryFetchImagePlaywright(
  url: URL,
  config: AppConfig,
  browser: BrowserSession,
): Promise<
  { ok: true; buffer: Buffer; contentType: string } | { ok: false; error: string }
> {
  const headers = buildImageFetchHeaders(url, config, 1);
  const r = await browser.requestGetBinary(url.href, headers, MAX_TELEGRAM_PHOTO_BYTES);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  if (!isLikelyImageBuffer(r.buffer, r.contentType)) {
    return {
      ok: false,
      error:
        "Playwright fetch: response is not a supported image (still HTML or non-image?). " +
        "Use a direct image file URL.",
    };
  }
  return { ok: true, buffer: r.buffer, contentType: r.contentType };
}

async function writeTempImage(buf: Buffer, contentType: string): Promise<string> {
  const ext = guessExtension(buf, contentType);
  const tmp = path.join(
    os.tmpdir(),
    `deepclaw-img-${randomBytes(8).toString("hex")}${ext}`,
  );
  await fs.writeFile(tmp, buf, { mode: 0o644 });
  return tmp;
}

/**
 * Download a direct image URL after browse_web-style checks. Writes a temp file.
 * Optional `browser` is required when config.sendImageFetchMode is playwright or auto fallback.
 */
export async function downloadImageToTempFile(
  urlInput: string,
  config: AppConfig,
  browser?: BrowserSession,
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  const v = await assertBrowseWebUrl(urlInput, config);
  if (!v.ok) return v;

  const mode = config.sendImageFetchMode;

  if (mode === "playwright") {
    if (!browser) {
      return {
        ok: false,
        error: "send_image_url Playwright mode requires a browser session (internal error).",
      };
    }
    const pw = await tryFetchImagePlaywright(v.url, config, browser);
    if (!pw.ok) {
      return { ok: false, error: pw.error };
    }
    try {
      const filePath = await writeTempImage(pw.buffer, pw.contentType);
      return { ok: true, filePath };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `write temp image failed: ${msg}` };
    }
  }

  const http = await tryFetchImageHttp(v.url, config);
  if (http.ok) {
    try {
      const filePath = await writeTempImage(http.buffer, http.contentType);
      return { ok: true, filePath };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `write temp image failed: ${msg}` };
    }
  }

  if (mode === "auto" && browser && http.tryPlaywrightFallback) {
    const pw = await tryFetchImagePlaywright(v.url, config, browser);
    if (pw.ok) {
      try {
        const filePath = await writeTempImage(pw.buffer, pw.contentType);
        return { ok: true, filePath };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `write temp image failed: ${msg}` };
      }
    }
    return {
      ok: false,
      error: `${http.error} Playwright fallback also failed: ${pw.error}`,
    };
  }

  return { ok: false, error: http.error };
}
