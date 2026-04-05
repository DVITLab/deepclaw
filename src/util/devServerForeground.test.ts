import { describe, it, expect } from "vitest";
import { isForegroundBlockingDevServerCommand } from "./devServerForeground.js";

describe("isForegroundBlockingDevServerCommand", () => {
  it("is false when empty or backgrounded", () => {
    expect(isForegroundBlockingDevServerCommand("")).toBe(false);
    expect(
      isForegroundBlockingDevServerCommand(
        "nohup python3 -m http.server 8000 --bind 0.0.0.0 &",
      ),
    ).toBe(false);
    expect(isForegroundBlockingDevServerCommand("sleep 1 &")).toBe(false);
    expect(
      isForegroundBlockingDevServerCommand("cd /app && nohup npx vite --host 0.0.0.0 &"),
    ).toBe(false);
    expect(
      isForegroundBlockingDevServerCommand(
        "cd /app && python3 -m http.server 8000 --bind 0.0.0.0 > ./server.log 2>&1 & sleep 2 && echo ok && curl -s http://localhost:8000/",
      ),
    ).toBe(false);
  });

  it("detects python http.server and npm dev without background", () => {
    expect(isForegroundBlockingDevServerCommand("python3 -m http.server 8000")).toBe(
      true,
    );
    expect(isForegroundBlockingDevServerCommand("npm run dev")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("npm start")).toBe(true);
  });

  it("detects vite / next dev patterns", () => {
    expect(isForegroundBlockingDevServerCommand("npx vite --host 0.0.0.0")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("cd /w && vite")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("vite")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("next dev")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("npx vite preview")).toBe(true);
    expect(isForegroundBlockingDevServerCommand("vite preview")).toBe(true);
  });

  it("does not block vite build or npm run build", () => {
    expect(isForegroundBlockingDevServerCommand("npx vite build")).toBe(false);
    expect(isForegroundBlockingDevServerCommand("npm run build")).toBe(false);
    expect(isForegroundBlockingDevServerCommand("vite build")).toBe(false);
  });
});
