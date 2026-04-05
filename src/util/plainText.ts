/**
 * Strip common Markdown so chat clients (e.g. Telegram) show readable plain text.
 */
export function formatReplyForChat(input: string): string {
  let s = input;
  // Fenced code blocks: keep inner text
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => `${inner.trim()}\n\n`);
  // Inline code
  s = s.replace(/`([^`]+)`/g, "$1");
  // Bold / strong
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  // Links [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // ATX headings
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Italic *word* (not **), line by line to reduce false positives with list markers
  s = s.replace(/(?<![*])\*([^*\n]+)\*(?!\*)/g, "$1");
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
