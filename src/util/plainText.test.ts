import { describe, it, expect } from "vitest";
import { formatReplyForChat } from "./plainText.js";

describe("formatReplyForChat", () => {
  it("strips bold, code fences, links, headings", () => {
    const raw = `## Title\n\n**bold** and \`code\` and [a](https://x.com)\n\n\`\`\`js\nx = 1\n\`\`\``;
    const out = formatReplyForChat(raw);
    expect(out).not.toContain("**");
    expect(out).not.toContain("```");
    expect(out).not.toContain("#");
    expect(out).toContain("bold");
    expect(out).toContain("code");
    expect(out).toContain("https://x.com");
  });
});
