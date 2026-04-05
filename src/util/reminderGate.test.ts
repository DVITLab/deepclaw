import { describe, it, expect } from "vitest";
import {
  parseReminderGateResponse,
  REMINDER_GATE_SYSTEM_PROMPT,
} from "./reminderGate.js";

const proposeExtras =
  '"proposalMessage":"Save this?","pingMessage":"Hi","confirmButton":"Save","cancelButton":"Discard"';

describe("parseReminderGateResponse", () => {
  it("parses propose cron (legacy JSON without scheduleKind)", () => {
    const r = parseReminderGateResponse(
      `{"action":"propose","cron":"0 8 * * *","reminderText":"Hi","summary":"Daily 8am",${proposeExtras}}`,
    );
    expect(r.action).toBe("propose");
    expect(r.scheduleKind).toBe("cron");
    expect(r.cron).toBe("0 8 * * *");
    expect(r.fireInMinutes).toBe(0);
    expect(r.reminderText).toBe("Hi");
    expect(r.summary).toBe("Daily 8am");
    expect(r.confirmButton).toBe("Save");
    expect(r.cancelButton).toBe("Discard");
  });

  it("parses propose once with fireInMinutes", () => {
    const r = parseReminderGateResponse(
      `{"action":"propose","scheduleKind":"once","fireInMinutes":30,"reminderText":"Go","summary":"After 30 min",${proposeExtras}}`,
    );
    expect(r.action).toBe("propose");
    expect(r.scheduleKind).toBe("once");
    expect(r.fireInMinutes).toBe(30);
    expect(r.cron).toBe("");
    expect(r.reminderText).toBe("Go");
  });

  it("parses once when fireInMinutes set and no cron", () => {
    const r = parseReminderGateResponse(
      `{"action":"propose","fireInMinutes":1,"reminderText":"x","summary":"y",${proposeExtras}}`,
    );
    expect(r.scheduleKind).toBe("once");
    expect(r.fireInMinutes).toBe(1);
  });

  it("accepts one-shot far beyond one week", () => {
    const mins = 30 * 24 * 60;
    const r = parseReminderGateResponse(
      `{"action":"propose","scheduleKind":"once","fireInMinutes":${mins},"reminderText":"x","summary":"y",${proposeExtras}}`,
    );
    expect(r.action).toBe("propose");
    expect(r.fireInMinutes).toBe(mins);
  });

  it("rejects propose when confirm/cancel buttons missing", () => {
    const r = parseReminderGateResponse(
      '{"action":"propose","cron":"0 8 * * *","reminderText":"Hi","summary":"x","proposalMessage":"p","pingMessage":"p"}',
    );
    expect(r.action).toBe("none");
  });

  it("parses clarify with message", () => {
    const r = parseReminderGateResponse(
      '{"action":"clarify","clarifyMessage":"Say when to remind you."}',
    );
    expect(r.action).toBe("clarify");
    expect(r.clarifyMessage).toBe("Say when to remind you.");
  });

  it("clarify without message becomes none", () => {
    expect(parseReminderGateResponse('{"action":"clarify"}').action).toBe(
      "none",
    );
  });

  it("parses remove with reminderIds", () => {
    const r = parseReminderGateResponse(
      '{"action":"remove","reminderIds":["a1","b2"]}',
    );
    expect(r.action).toBe("remove");
    expect(r.removeReminderIds).toEqual(["a1", "b2"]);
    expect(r.removeTextMatch).toBe("");
  });

  it("maps delete to remove", () => {
    const r = parseReminderGateResponse(
      '{"action":"delete","reminderId":"x9"}',
    );
    expect(r.action).toBe("remove");
    expect(r.removeReminderIds).toContain("x9");
  });

  it("remove without targets becomes none", () => {
    expect(parseReminderGateResponse('{"action":"remove"}').action).toBe("none");
  });

  it("parses list", () => {
    expect(parseReminderGateResponse('{"action":"list"}').action).toBe("list");
  });

  it("parses none", () => {
    expect(parseReminderGateResponse('{"action":"none"}').action).toBe("none");
  });

  it("falls back to none on garbage", () => {
    expect(parseReminderGateResponse("").action).toBe("none");
    expect(parseReminderGateResponse("not json").action).toBe("none");
  });

  it("propose without cron and without fireInMinutes becomes none", () => {
    expect(
      parseReminderGateResponse(
        `{"action":"propose","reminderText":"x",${proposeExtras}}`,
      ).action,
    ).toBe("none");
  });

  it("extracts JSON from markdown fence", () => {
    const r = parseReminderGateResponse(
      "```json\n{\"action\":\"list\"}\n```",
    );
    expect(r.action).toBe("list");
  });

  it("has a non-empty system prompt", () => {
    expect(REMINDER_GATE_SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });
});
