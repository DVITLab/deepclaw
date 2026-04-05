import http from "node:http";
import { logInfo, logWarn } from "./logger.js";

/**
 * Minimal GET /health for Docker HEALTHCHECK. Bind loopback by default.
 * Returns close() to stop the server.
 */
export function startHealthServer(
  host: string,
  port: number,
): { close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("error", (err) => {
    logWarn(`health server error: ${String(err)}`);
  });

  server.listen(port, host, () => {
    logInfo(`health server listening on http://${host}:${port}/health`);
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
