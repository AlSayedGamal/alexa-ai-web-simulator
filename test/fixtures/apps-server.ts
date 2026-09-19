/**
 * A small real MCP server with MCP Apps tools and views, on an ephemeral port,
 * for tests and for driving the simulator in a browser. It speaks the actual
 * protocol (via @modelcontextprotocol/server and the ext-apps helpers), so
 * tests exercise the simulator's client against a real server, not a mock.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface AppsFixtureOptions {
  /** The HTML served for `ui://fixture/card`. */
  cardHtml?: string;
  /** Bearer token the server requires. */
  token?: string;
  port?: number;
}

export interface AppsFixture {
  url: string;
  token: string;
  /** The `capabilities` object from every `initialize` the server saw. */
  initCapabilities: unknown[];
  /** Tool names the server was asked to call, in order. */
  calls: string[];
  close(): Promise<void>;
}

const DEFAULT_CARD = "<!doctype html><html><head><title>card</title></head><body>card view</body></html>";

function buildServer(cardHtml: string, calls: string[]): McpServer {
  const server = new McpServer({ name: "apps-fixture", version: "0.0.0" });

  registerAppResource(
    server,
    "Card",
    "ui://fixture/card",
    { description: "Card view" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: cardHtml,
          _meta: {
            ui: {
              csp: { connectDomains: ["https://content.example"] },
              permissions: { clipboardWrite: {} },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  // Metadata only on the resources/list entry: the content item has none.
  registerAppResource(
    server,
    "Listing-only view",
    "ui://fixture/listing-only",
    { description: "View whose metadata is on the listing", _meta: { ui: { csp: { connectDomains: ["https://listing.example"] } } } },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: "<html><head></head><body>listing</body></html>" }] }),
  );

  // A view with the wrong MIME type: a spec-compliant host must refuse it.
  server.registerResource(
    "Wrong MIME type",
    "ui://fixture/badmime",
    { mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "not html" }] }),
  );

  const tool = (name: string, uri: string, visibility?: Array<"model" | "app">) =>
    registerAppTool(
      server,
      name,
      {
        description: `${name} tool`,
        inputSchema: z.object({ title: z.string().optional() }),
        _meta: { ui: { resourceUri: uri, ...(visibility ? { visibility } : {}) } },
      },
      async (args: { title?: string }) => {
        calls.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} ran with ${args.title ?? "no title"}` }],
          structuredContent: { title: args.title ?? "", tool: name },
        };
      },
    );

  tool("show_card", "ui://fixture/card");
  tool("refresh_card", "ui://fixture/card", ["app"]); // callable by a view, hidden from the model
  tool("model_only", "ui://fixture/card", ["model"]); // a view must NOT be able to call this
  tool("listing_view", "ui://fixture/listing-only");
  tool("bad_view", "ui://fixture/badmime");
  tool("missing_view", "ui://fixture/does-not-exist");

  server.registerTool("plain", { description: "A tool with no view" }, async () => {
    calls.push("plain");
    return { content: [{ type: "text" as const, text: "plain result" }] };
  });

  return server;
}

export async function startAppsFixture(options: AppsFixtureOptions = {}): Promise<AppsFixture> {
  const token = options.token ?? "fixture-token";
  const initCapabilities: unknown[] = [];
  const calls: string[] = [];
  const handler = createMcpHandler(() => buildServer(options.cardHtml ?? DEFAULT_CARD, calls));

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    try {
      const parsed = JSON.parse(body.toString() || "null");
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (message?.method === "initialize") initCapabilities.push(message.params?.capabilities);
      }
    } catch {
      // not JSON: let the handler deal with it
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    initCapabilities,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
