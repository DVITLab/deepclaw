import { describe, it, expect } from "vitest";
import {
  createSnoozeOnceJob,
  isValidCronExpression,
  normalizeReminderJobRow,
  reminderSendText,
  reminderSendThreadOpts,
  resolveRemoveReminderIds,
  type ReminderJob,
} from "./reminderService.js";

describe("isValidCronExpression", () => {
  it("accepts common 5-field cron", () => {
    expect(isValidCronExpression("0 8 * * *")).toBe(true);
    expect(isValidCronExpression("30 9 * * 1")).toBe(true);
  });

  it("rejects empty or invalid", () => {
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression("not a cron")).toBe(false);
  });
});

describe("reminderSendText", () => {
  const base: ReminderJob = {
    id: "a",
    chatId: "1",
    userId: 1,
    kind: "cron",
    cron: "0 8 * * *",
    reminderText: "Hi",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("uses reminderText when deliveryMessage absent", () => {
    expect(reminderSendText(base)).toBe("Hi");
  });

  it("prefers deliveryMessage when set", () => {
    expect(
      reminderSendText({
        ...base,
        deliveryMessage: "Ping from LLM",
      }),
    ).toBe("Ping from LLM");
  });
});

describe("resolveRemoveReminderIds", () => {
  const job = (
    id: string,
    chatId: string,
    userId: number,
    text: string,
  ): ReminderJob => ({
    id,
    chatId,
    userId,
    kind: "cron",
    cron: "0 8 * * *",
    reminderText: text,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("resolves explicit ids for same chat and user", () => {
    const jobs = [
      job("j1", "10", 1, "A"),
      job("j2", "10", 1, "B"),
      job("j3", "99", 1, "C"),
    ];
    expect(resolveRemoveReminderIds(jobs, "10", 1, ["j2"], "")).toEqual(["j2"]);
  });

  it("resolves unique substring match", () => {
    const jobs = [job("j1", "1", 5, "Drink water daily")];
    expect(resolveRemoveReminderIds(jobs, "1", 5, [], "water")).toEqual(["j1"]);
  });

  it("returns empty when substring matches multiple", () => {
    const jobs = [
      job("a", "1", 1, "water A"),
      job("b", "1", 1, "water B"),
    ];
    expect(resolveRemoveReminderIds(jobs, "1", 1, [], "water")).toEqual([]);
  });

  it("ignores other users jobs", () => {
    const jobs = [job("x", "1", 2, "mine")];
    expect(resolveRemoveReminderIds(jobs, "1", 1, ["x"], "")).toEqual([]);
  });
});

describe("normalizeReminderJobRow", () => {
  it("migrates legacy cron job without kind", () => {
    const j = normalizeReminderJobRow({
      id: "a",
      chatId: "1",
      userId: 1,
      cron: "0 8 * * *",
      reminderText: "Hi",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(j?.kind).toBe("cron");
  });

  it("reads optional deliveryMessage", () => {
    const j = normalizeReminderJobRow({
      id: "a",
      chatId: "1",
      userId: 1,
      cron: "0 8 * * *",
      reminderText: "Hi",
      deliveryMessage: "  wrap  ",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(j?.deliveryMessage).toBe("wrap");
  });

  it("reads positive messageThreadId for cron", () => {
    const j = normalizeReminderJobRow({
      id: "a",
      chatId: "1",
      userId: 1,
      cron: "0 8 * * *",
      reminderText: "Hi",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      messageThreadId: 42,
    });
    expect(j?.messageThreadId).toBe(42);
  });

  it("drops non-positive messageThreadId", () => {
    const j = normalizeReminderJobRow({
      id: "a",
      chatId: "1",
      userId: 1,
      cron: "0 8 * * *",
      reminderText: "Hi",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      messageThreadId: 0,
    });
    expect(j?.messageThreadId).toBeUndefined();
  });
});

describe("reminderSendThreadOpts", () => {
  it("is empty without messageThreadId", () => {
    const j: ReminderJob = {
      id: "a",
      chatId: "1",
      userId: 1,
      kind: "cron",
      cron: "0 8 * * *",
      reminderText: "Hi",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(reminderSendThreadOpts(j)).toEqual({});
  });

  it("maps messageThreadId to Bot API field", () => {
    const j: ReminderJob = {
      id: "a",
      chatId: "1",
      userId: 1,
      kind: "cron",
      cron: "0 8 * * *",
      reminderText: "Hi",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      messageThreadId: 7,
    };
    expect(reminderSendThreadOpts(j)).toEqual({ message_thread_id: 7 });
  });
});

describe("createSnoozeOnceJob", () => {
  const source: ReminderJob = {
    id: "old",
    chatId: "-1001",
    userId: 9,
    kind: "once",
    cron: "",
    fireAt: "2026-01-02T00:00:00.000Z",
    reminderText: "R",
    deliveryMessage: "D",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    messageThreadId: 3,
    timeZone: "UTC",
  };

  it("copies messageThreadId and delivery fields", () => {
    const next = createSnoozeOnceJob(source, 15, "newid");
    expect(next.id).toBe("newid");
    expect(next.kind).toBe("once");
    expect(next.messageThreadId).toBe(3);
    expect(next.deliveryMessage).toBe("D");
    expect(next.timeZone).toBe("UTC");
    expect(next.fireAt).not.toBe(source.fireAt);
  });
});
