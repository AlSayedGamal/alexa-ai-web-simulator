import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCsp } from "../src/ui/csp.js";
import { CSP_VIOLATION_TYPE, SIM_MESSAGE_SOURCE, createSandboxServer } from "../src/ui/sandbox.js";

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("sandbox proxy server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = createSandboxServer({ port: 0 });
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("serves the proxy page with the default CSP as an HTTP header", async () => {
    const res = await get(port, "/sandbox.html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(`${buildCsp()}; frame-ancestors http://127.0.0.1:* http://localhost:*`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("applies the view's declared domains from the csp query parameter", async () => {
    const csp = encodeURIComponent(JSON.stringify({ connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] }));
    const res = await get(port, `/sandbox.html?csp=${csp}`);
    const header = res.headers["content-security-policy"] as string;
    expect(header).toContain("connect-src https://api.example.com;");
    expect(header).toContain("img-src 'self' data: https://cdn.example.com;");
  });

  it("falls back to the default policy for unparseable or hostile csp values", async () => {
    const bad = await get(port, "/sandbox.html?csp=%7Bnot-json");
    expect(bad.headers["content-security-policy"]).toContain("connect-src 'none'");

    const inject = encodeURIComponent(JSON.stringify({ connectDomains: ["https://a.example; script-src *"] }));
    const hostile = await get(port, `/sandbox.html?csp=${inject}`);
    const header = hostile.headers["content-security-policy"] as string;
    expect(header).toContain("connect-src 'none'");
    expect(header).not.toContain("script-src *");
  });

  it("contains the proxy that hands the view its sandbox and relays messages", async () => {
    const { text } = await get(port, "/sandbox.html");
    expect(text).toContain("ui/notifications/sandbox-proxy-ready");
    expect(text).toContain("ui/notifications/sandbox-resource-ready");
    expect(text).toContain('setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms")');
    // Only a loopback page may host it, and it answers only that page.
    expect(text).toContain("document.referrer");
    expect(text).toContain("event.origin !== hostOrigin");
    // CSP violations are reported to the page under an ignorable (non JSON-RPC) shape.
    expect(text).toContain(SIM_MESSAGE_SOURCE);
    expect(text).toContain(CSP_VIOLATION_TYPE);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await get(port, "/sandbox.html", { host: `attacker.example:${port}` })).status).toBe(403);
  });

  it("serves nothing else", async () => {
    expect((await get(port, "/")).status).toBe(404);
    expect((await get(port, "/api/status")).status).toBe(404);
    expect((await get(port, "/sandbox.html", {}, "POST")).status).toBe(404);
  });
});
