import { describe, it, expect } from "vitest";
import { isBrowseWebHostBlocked } from "./browser.js";

describe("isBrowseWebHostBlocked", () => {
  it("blocks localhost and loopback IPv4", () => {
    expect(isBrowseWebHostBlocked("localhost")).toBe(true);
    expect(isBrowseWebHostBlocked("127.0.0.1")).toBe(true);
    expect(isBrowseWebHostBlocked("10.0.0.1")).toBe(true);
    expect(isBrowseWebHostBlocked("192.168.1.1")).toBe(true);
    expect(isBrowseWebHostBlocked("172.16.0.1")).toBe(true);
    expect(isBrowseWebHostBlocked("169.254.1.1")).toBe(true);
  });

  it("allows public hosts", () => {
    expect(isBrowseWebHostBlocked("example.com")).toBe(false);
    expect(isBrowseWebHostBlocked("api.deepseek.com")).toBe(false);
    expect(isBrowseWebHostBlocked("8.8.8.8")).toBe(false);
  });

  it("blocks IPv6 loopback and link-local style", () => {
    expect(isBrowseWebHostBlocked("::1")).toBe(true);
    expect(isBrowseWebHostBlocked("fe80::1")).toBe(true);
    expect(isBrowseWebHostBlocked("fd00::1")).toBe(true);
  });
});
