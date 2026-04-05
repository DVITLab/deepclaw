import dns from "node:dns/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import { readBodyCapped } from "../util/readBodyCapped.js";

/**
 * Block obvious loopback / private targets to reduce SSRF when browse_web is wide open
 * (full access + empty allowlist). Still used when an allowlist is set, for IP-literal URLs.
 */
export function isBrowseWebHostBlocked(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;

  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m4) {
    const a = Number(m4[1]);
    const b = Number(m4[2]);
    if (![a, b, Number(m4[3]), Number(m4[4])].every((n) => n >= 0 && n <= 255)) {
      return true;
    }
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (h.includes(":")) {
    if (h === "::1") return true;
    const head = h.split(":", 1)[0] ?? "";
    if (/^fe[89ab][0-9a-f]{0,2}$/i.test(head)) return true;
    if (/^fc[0-9a-f]{0,2}$/i.test(head) || /^fd[0-9a-f]{0,2}$/i.test(head)) return true;
  }

  return false;
}

/** True if hostname is already a numeric IP (v4 or v6), so DNS resolution is unnecessary. */
export function isHostnameIpLiteral(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(":")) return true;
  return false;
}

/**
 * If hostname resolves to any private/reserved IP, returns an error message; otherwise undefined.
 * Uses the same rules as literal host blocking.
 */
export async function dnsRejectsResolvedHost(
  hostname: string,
): Promise<string | undefined> {
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const r of results) {
      if (isBrowseWebHostBlocked(r.address)) {
        return `Host ${hostname} resolves to disallowed address ${r.address} (private/reserved).`;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `DNS lookup failed for ${hostname}: ${msg}`;
  }
  return undefined;
}

/** Allowlist entries: hostname like `example.com` or `*.example.com` (subdomains). Optional full URL — host is extracted. */
export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();

  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    let pattern = entry.toLowerCase();
    if (pattern.includes("://")) {
      try {
        pattern = new URL(pattern).hostname;
      } catch {
        continue;
      }
    }
    const wildcard = pattern.startsWith("*.") ? pattern.slice(2) : null;
    if (wildcard) {
      if (host === wildcard) continue;
      if (host.endsWith("." + wildcard)) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

/** User-Agent for HTTP image fetch and Playwright context (keep in sync). */
export const BROWSE_WEB_USER_AGENT =
  "Mozilla/5.0 (compatible; DeepclawBot/0.1; +https://github.com/dngvn/deepclaw)";

/**
 * Same URL rules as browse_web / send_image_url: protocol, host blocklist,
 * allowlist (unless full+empty list), optional DNS rebinding check.
 * Returns parsed URL or a user-facing error string.
 */
export async function assertBrowseWebUrl(
  urlInput: string,
  config: AppConfig,
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  if (!config.browserEnabled) {
    return {
      ok: false,
      error:
        "browse_web is disabled (safe mode — unset DEEPCLAW_SAFE_MODE or set 0/false for full tools).",
    };
  }
  let u: URL;
  try {
    u = new URL(urlInput.trim());
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs are allowed." };
  }
  if (isBrowseWebHostBlocked(u.hostname)) {
    return {
      ok: false,
      error: `URL host is not allowed (private/loopback): ${u.hostname}`,
    };
  }
  const allowAllBrowser =
    config.fullContainerAccess && config.browserAllowlist.length === 0;
  if (!allowAllBrowser && !isUrlAllowed(urlInput, config.browserAllowlist)) {
    return { ok: false, error: `URL not allowed (internal allowlist): ${urlInput}` };
  }
  if (
    config.browserResolveDns &&
    !isHostnameIpLiteral(u.hostname) &&
    !isBrowseWebHostBlocked(u.hostname)
  ) {
    const dnsErr = await dnsRejectsResolvedHost(u.hostname);
    if (dnsErr) {
      return { ok: false, error: dnsErr };
    }
  }
  return { ok: true, url: u };
}

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly config: AppConfig) {}

  async ensure(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.context = await this.browser.newContext({
      userAgent: BROWSE_WEB_USER_AGENT,
    });
    this.page = await this.context.newPage();
  }

  /**
   * GET binary body (e.g. send_image_url Playwright mode). URL must already pass `assertBrowseWebUrl`.
   * Reads the body with a capped stream (see `readBodyCapped` / `fetchImageUrl.ts`) so huge responses
   * are not fully buffered before enforcing `maxBytes`.
   */
  async requestGetBinary(
    url: string,
    headers: Record<string, string>,
    maxBytes: number,
  ): Promise<
    | { ok: true; status: number; contentType: string; buffer: Buffer }
    | { ok: false; status: number; error: string }
  > {
    await this.ensure();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.config.browserTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers,
        signal: ac.signal,
        redirect: "follow",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError") {
        return { ok: false, status: 0, error: "Image download timed out." };
      }
      return { ok: false, status: 0, error: `Image download failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    const rawCt = res.headers.get("content-type") ?? "";
    const contentType = rawCt.split(";")[0]?.trim().toLowerCase() ?? "";
    const lenHeader = res.headers.get("content-length");
    if (lenHeader) {
      const n = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(n) && n > maxBytes) {
        return {
          ok: false,
          status,
          error: `Image too large (server Content-Length ${n} > ${maxBytes}).`,
        };
      }
    }

    const buf = await readBodyCapped(res, maxBytes);
    if (!buf) {
      return {
        ok: false,
        status,
        error: `Response body exceeds download limit (${maxBytes} bytes).`,
      };
    }
    if (!res.ok) {
      const snippet = buf
        .subarray(0, Math.min(buf.length, 400))
        .toString("utf8")
        .replace(/\s+/g, " ")
        .slice(0, 200);
      const extra = snippet ? ` Body snippet: ${snippet}${snippet.length >= 200 ? "…" : ""}` : "";
      return {
        ok: false,
        status,
        error: `HTTP ${status} from Playwright fetch.${extra}`,
      };
    }
    return { ok: true, status, contentType, buffer: buf };
  }

  async fetchPageText(url: string): Promise<string> {
    const v = await assertBrowseWebUrl(url, this.config);
    if (!v.ok) {
      return v.error;
    }
    await this.ensure();
    const page = this.page!;
    await page.goto(v.url.href, {
      waitUntil: "domcontentloaded",
      timeout: this.config.browserTimeoutMs,
    });
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const combined = `Title: ${title}\n\n${text}`.slice(
      0,
      this.config.browserMaxContentChars,
    );
    return combined;
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      try {
        await this.browser?.close();
      } finally {
        this.page = null;
        this.context = null;
        this.browser = null;
      }
    }
  }
}
