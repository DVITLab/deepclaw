/** Telegram Bot API max message length (UTF-16 code units in practice; slice is safe for ASCII-heavy agent output). */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Split text into chunks that fit Telegram's per-message limit.
 * Prefers breaking at newlines when possible.
 */
export function splitForTelegram(text: string, maxLen = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let take = maxLen;
    const window = rest.slice(0, maxLen);
    const lastNl = window.lastIndexOf("\n");
    if (lastNl > maxLen * 0.4) {
      take = lastNl + 1;
    }
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return chunks;
}
