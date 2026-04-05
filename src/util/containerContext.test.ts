import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      String(p) === "/.dockerenv" ? false : actual.existsSync(p),
  };
});

describe("containerContext (no /.dockerenv)", () => {
  it("isRunningInContainer is false", async () => {
    const { isRunningInContainer } = await import("./containerContext.js");
    expect(isRunningInContainer()).toBe(false);
  });

  it("assertContainerRequired throws", async () => {
    const { assertContainerRequired } = await import("./containerContext.js");
    expect(() => assertContainerRequired("deepclaw run")).toThrow(
      /only supported inside a container/i,
    );
  });
});
