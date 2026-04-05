import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  agentProjectWorkspaceRoot,
  collectShellAbsolutePathLiterals,
  firstDisallowedShellAbsolutePath,
  resolveToolPathUnderProjectWorkspace,
} from "./agentProjectWorkspace.js";

describe("agentProjectWorkspaceRoot", () => {
  it("is <dataDir>/workspace resolved", () => {
    const r = agentProjectWorkspaceRoot("/app/agent-data");
    expect(r).toBe(path.resolve("/app/agent-data/workspace"));
  });
});

describe("resolveToolPathUnderProjectWorkspace", () => {
  const dd = "/tmp/dc-apw-dd";
  const root = path.join(dd, "workspace");

  it("resolves relative under root", () => {
    expect(resolveToolPathUnderProjectWorkspace(dd, "src/a.ts")).toBe(path.join(root, "src/a.ts"));
  });

  it("rejects absolute outside root", () => {
    expect(resolveToolPathUnderProjectWorkspace(dd, "/etc/passwd")).toBe(null);
  });
});

describe("firstDisallowedShellAbsolutePath", () => {
  const proj = "/app/agent-data/workspace";

  it("allows only project paths and /dev/null", () => {
    expect(
      firstDisallowedShellAbsolutePath(
        `nohup python3 -m http.server 8000 >./.http.log 2>&1 & sleep 1; head ./.http.log`,
        proj,
      ),
    ).toBe(null);
    expect(firstDisallowedShellAbsolutePath("echo x > /dev/null", proj)).toBe(null);
    expect(
      firstDisallowedShellAbsolutePath(`cat ${proj}/README.md`, proj),
    ).toBe(null);
  });

  it("flags /tmp and /etc", () => {
    expect(firstDisallowedShellAbsolutePath("echo x > /tmp/a.log", proj)).toBe("/tmp/a.log");
    expect(firstDisallowedShellAbsolutePath("cat /etc/passwd", proj)).toBe("/etc/passwd");
  });
});

describe("collectShellAbsolutePathLiterals", () => {
  it("finds redirect targets", () => {
    const s = collectShellAbsolutePathLiterals("echo 1 > /tmp/x 2> /dev/y");
    expect(s).toContain("/tmp/x");
    expect(s).toContain("/dev/y");
  });
});
