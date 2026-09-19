/**
 * The MCP Apps host, in the browser: puts a view in a sandboxed iframe and
 * speaks the protocol to it with AppBridge (the official host-side library).
 *
 *   simulator page ──iframe──▶ sandbox proxy (another origin, its own CSP)
 *                                   └──iframe──▶ the view
 *
 * Bundled into public/host.js by scripts/build-host.mjs.
 */
import { AppBridge, PostMessageTransport, buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";

import { clampSize, createHostHandlers, type HostHandlers } from "./handlers.js";

export { clampSize, createHostHandlers, safeHttpsUrl, type HostDeps, type HostHandlers } from "./handlers.js";

/** What the server sends for a view (src/ui/resolve.ts `UiPayload`). */
export interface UiPayload {
  resourceUri: string;
  tool: string;
  html: string;
  csp: Record<string, string[] | undefined>;
  permissions: Record<string, object | undefined>;
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown>;
}

export interface MountOptions {
  container: HTMLElement;
  ui: UiPayload;
  /** Origin of the sandbox proxy (a different origin from this page). */
  sandboxOrigin: string;
  handlers: HostHandlers;
  /** Tallest a view may ask to be, in px. */
  maxHeight: number;
  /** The view broke its CSP (blocked request, disallowed inline script, ...). */
  onCspViolation?: (violation: { directive: string; blockedUri: string }) => void;
  /** Something a developer should hear about (the view never finished starting, ...). */
  onProblem?: (message: string) => void;
}

const HANDSHAKE_TIMEOUT_MS = 8000;
const TEARDOWN_TIMEOUT_MS = 500;

const SIM_MESSAGE_SOURCE = "mcp-voice-simulator";

function timeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function mountView(options: MountOptions): Promise<{ destroy(): Promise<void> }> {
  const { container, ui, sandboxOrigin, handlers, maxHeight } = options;

  const iframe = document.createElement("iframe");
  iframe.title = "MCP view";
  iframe.className = "view-frame";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  const allow = buildAllowAttribute(ui.permissions as never);
  if (allow) iframe.setAttribute("allow", allow);

  const src = new URL("/sandbox.html", sandboxOrigin);
  src.searchParams.set("csp", JSON.stringify(ui.csp));

  const seenViolations = new Set<string>();
  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as { source?: string; type?: string; directive?: string; blockedUri?: string } | undefined;
    if (data?.source === SIM_MESSAGE_SOURCE && data.type === "csp-violation") {
      const key = `${data.directive}|${data.blockedUri}`;
      if (seenViolations.has(key)) return;
      seenViolations.add(key);
      options.onCspViolation?.({ directive: String(data.directive), blockedUri: String(data.blockedUri) });
    }
  };
  window.addEventListener("message", onWindowMessage);

  // Wait for the proxy to say it's up before speaking to it.
  const proxyReady = new Promise<void>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow && event.data?.method === "ui/notifications/sandbox-proxy-ready") {
        window.removeEventListener("message", listener);
        resolve();
      }
    };
    window.addEventListener("message", listener);
  });

  iframe.src = src.href;
  container.replaceChildren(iframe);

  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const bridge = new AppBridge(
    null, // no MCP client here: tool calls go through the simulator's server, see oncalltool
    { name: "mcp-voice-simulator", version: "0.1.0" },
    { openLinks: {}, serverTools: {}, message: { text: {} }, logging: {} },
    {
      hostContext: {
        theme: prefersDark ? "dark" : "light",
        platform: "web",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { maxHeight },
      },
    },
  );

  bridge.oncalltool = (params) => handlers.callTool(params as never) as never;
  bridge.onmessage = (params) => handlers.message(params as never) as never;
  bridge.onopenlink = (params) => handlers.openLink(params) as never;
  bridge.onsizechange = ({ height }) => {
    const clamped = clampSize(height, maxHeight);
    if (clamped !== undefined) iframe.style.height = `${clamped}px`;
  };
  // Handlers are registered before connect(), so nothing the view sends first is missed.

  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });

  await proxyReady;
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await bridge.sendSandboxResourceReady({
    html: ui.html,
    csp: ui.csp as never,
    permissions: ui.permissions as never,
  });

  // A view that is slow, or never completes the handshake, still gets its data: the
  // spec has tool-input then tool-result follow initialization, and a developer is
  // better served by the timeout message below than by a silent blank screen.
  await timeout(initialized, HANDSHAKE_TIMEOUT_MS, () =>
    options.onProblem?.(
      `The view for "${ui.tool}" didn't finish starting within ${HANDSHAKE_TIMEOUT_MS / 1000}s. It should call app.connect() and complete the ui/initialize handshake; check its console for errors.`,
    ),
  );
  bridge.sendToolInput({ arguments: ui.toolInput });
  bridge.sendToolResult(ui.toolResult as never);

  return {
    async destroy() {
      window.removeEventListener("message", onWindowMessage);
      await timeout(bridge.teardownResource({}).catch(() => undefined), TEARDOWN_TIMEOUT_MS, () => {});
      await bridge.close().catch(() => undefined);
      iframe.remove();
    },
  };
}
