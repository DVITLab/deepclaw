/** Download a file from Telegram Bot API `getFile` path (HTTPS). */
export async function downloadTelegramBotFile(
  botToken: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get("content-length");
  if (lenHeader) {
    const n = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Telegram file too large (${n} bytes, max ${maxBytes})`);
    }
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`Telegram file too large (${ab.byteLength} bytes, max ${maxBytes})`);
  }
  return Buffer.from(ab);
}
