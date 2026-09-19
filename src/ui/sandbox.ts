/**
 * The MCP Apps sandbox proxy, served from its own origin.
 *
 * The spec is explicit for web hosts: "The Host and the Sandbox MUST have
 * different origins." The simulator's page is on `127.0.0.1:<port>` and this
 * server is on `127.0.0.1:<port + 1>` — a different origin — so a view, which
 * runs inside an iframe inside this page, can never touch the simulator's own
 * origin or its API.
 *
 * Layout (same shape as the reference `basic-host` in the ext-apps repo):
 *
 *   simulator page ──iframe──▶ /sandbox.html?csp=…  (this file's HTML; the proxy)
 *                                   └──iframe (srcdoc)──▶ the view
 *
 * The proxy relays `postMessage` between the page and the view, and applies the
 * view's CSP as an HTTP header on this document, which its srcdoc child inherits.
 */
import http from "node:http";

import { allowedHosts } from "../security.js";

import { buildCsp, sanitizeCspMeta } from "./csp.js";

/** Reported to the page when a view breaks its CSP. Not JSON-RPC, so AppBridge ignores it. */
export const CSP_VIOLATION_TYPE = "csp-violation";
export const SIM_MESSAGE_SOURCE = "mcp-voice-simulator";

const SANDBOX_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>MCP view sandbox</title>
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><script>
(function () {
  var LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  var hostOrigin;
  try { hostOrigin = new URL(document.referrer).origin; } catch (e) {}
  if (!hostOrigin || !LOCAL.test(hostOrigin) || window.parent === window) {
    document.body.textContent = "This is the MCP Apps sandbox proxy. It only works inside the simulator.";
    return;
  }

  var inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  document.body.appendChild(inner);

  function allowFor(p) {
    var out = [];
    if (p && p.camera) out.push("camera");
    if (p && p.microphone) out.push("microphone");
    if (p && p.geolocation) out.push("geolocation");
    if (p && p.clipboardWrite) out.push("clipboard-write");
    return out.join("; ");
  }

  // Runs first inside the view, so violations while the page is still parsing are seen too.
  var LISTENER = "<script>document.addEventListener('securitypolicyviolation',function(e){parent.postMessage({source:'${SIM_MESSAGE_SOURCE}',type:'${CSP_VIOLATION_TYPE}',directive:e.violatedDirective,blockedUri:e.blockedURI},'*')})<\/script>";

  function instrument(html) {
    var head = /<head[^>]*>/i.exec(html);
    if (!head) return { html: html, injected: false };
    var at = head.index + head[0].length;
    return { html: html.slice(0, at) + LISTENER + html.slice(at), injected: true };
  }

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;
      var msg = event.data;
      if (msg && msg.method === "ui/notifications/sandbox-resource-ready") {
        var params = msg.params || {};
        var allow = allowFor(params.permissions);
        if (allow) inner.setAttribute("allow", allow);
        var prepared = instrument(String(params.html || ""));
        if (!prepared.injected) {
          inner.addEventListener("load", function () {
            try {
              inner.contentWindow.addEventListener("securitypolicyviolation", function (e) {
                window.parent.postMessage({ source: "${SIM_MESSAGE_SOURCE}", type: "${CSP_VIOLATION_TYPE}", directive: e.violatedDirective, blockedUri: e.blockedURI }, hostOrigin);
              });
            } catch (err) {}
          }, { once: true });
        }
        inner.srcdoc = prepared.html;
        return;
      }
      if (inner.contentWindow) inner.contentWindow.postMessage(msg, location.origin);
    } else if (inner.contentWindow && event.source === inner.contentWindow) {
      window.parent.postMessage(event.data, hostOrigin);
    }
  });

  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, hostOrigin);
})();
</script></body></html>`;

function parseCspParam(raw: string | null): ReturnType<typeof sanitizeCspMeta> {
  if (!raw) return sanitizeCspMeta(undefined);
  try {
    return sanitizeCspMeta(JSON.parse(raw));
  } catch {
    return sanitizeCspMeta(undefined);
  }
}

export interface SandboxServerOptions {
  /** Default: the simulator's port + 1, or any free port when that is 0. */
  port: number;
}

export function createSandboxServer(options: SandboxServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;

    const host = req.headers.host?.toLowerCase();
    if (!host || !allowedHosts(port).includes(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("Forbidden: unexpected Host header.");
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/sandbox.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found.");
    }

    const csp = `${buildCsp(parseCspParam(url.searchParams.get("csp")))}; frame-ancestors http://127.0.0.1:* http://localhost:*`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(SANDBOX_HTML);
  });

  server.listen(options.port, "127.0.0.1");
  return server;
}
