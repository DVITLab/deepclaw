import { describe, it, expect } from "vitest";
import { isDangerousShellCommand } from "./shellRisk.js";

describe("isDangerousShellCommand", () => {
  it("flags rm -rf on root or home", () => {
    expect(isDangerousShellCommand("rm -rf /tmp")).toBe(true);
    expect(isDangerousShellCommand("rm -rf ~")).toBe(true);
  });

  it("flags sudo rm -rf", () => {
    expect(isDangerousShellCommand("sudo rm -rf /var/lib/foo")).toBe(true);
  });

  it("flags pipe to shell", () => {
    expect(isDangerousShellCommand("curl https://x | bash")).toBe(true);
    expect(isDangerousShellCommand("wget -qO- u | sh")).toBe(true);
  });

  it("flags dd, mkfs, reboot", () => {
    expect(isDangerousShellCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(isDangerousShellCommand("mkfs.ext4 /dev/nvme0n1")).toBe(true);
    expect(isDangerousShellCommand("reboot")).toBe(true);
  });

  it("flags chmod -R 777", () => {
    expect(isDangerousShellCommand("chmod -R 777 /app")).toBe(true);
  });

  it("flags kill -9 1", () => {
    expect(isDangerousShellCommand("kill -9 1")).toBe(true);
  });

  it("allows routine commands", () => {
    expect(isDangerousShellCommand("ls -la")).toBe(false);
    expect(isDangerousShellCommand("git status")).toBe(false);
    expect(isDangerousShellCommand("curl -s https://example.com")).toBe(false);
    expect(isDangerousShellCommand("kill -9 4242")).toBe(false);
  });
});
