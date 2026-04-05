import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadChatHistory,
  messagesFromJson,
  messagesToJson,
  sanitizeChatIdForFilename,
} from "./chatHistoryPersistence.js";

describe("sanitizeChatIdForFilename", () => {
  it("keeps digits and minus", () => {
    expect(sanitizeChatIdForFilename("-1001234567890")).toBe("-1001234567890");
  });
});

describe("messagesToJson / messagesFromJson", () => {
  it("round-trips user and assistant", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const json = messagesToJson(msgs);
    expect(json).toContain('"role": "user"');
    expect(messagesFromJson(json)).toEqual(msgs);
  });

  it("round-trips assistant with tool_calls and tool", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "run_shell", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    const back = messagesFromJson(messagesToJson(msgs));
    expect(back).toHaveLength(4);
    expect(back[0]).toEqual(msgs[0]);
    expect(back[1].role).toBe("assistant");
    expect((back[1] as { tool_calls?: unknown }).tool_calls).toEqual(
      (msgs[1] as { tool_calls: unknown }).tool_calls,
    );
    expect(back[2]).toEqual(msgs[2]);
    expect(back[3]).toEqual(msgs[3]);
  });

  it("handles special characters in content", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "line\n\"quotes\" and \t tabs" },
    ];
    expect(messagesFromJson(messagesToJson(msgs))).toEqual(msgs);
  });
});

describe("loadChatHistory", () => {
  it("moves corrupt JSON aside and returns empty array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deepclaw-ch-"));
    const chatId = "99";
    const fp = path.join(dir, `chat_${chatId}.json`);
    await writeFile(fp, "{ not valid json", "utf8");
    const msgs = await loadChatHistory(dir, chatId);
    expect(msgs).toEqual([]);
    const names = await readdir(dir);
    expect(names.some((n) => n.includes(".corrupt-") && n.endsWith(".bak"))).toBe(
      true,
    );
  });
});
