/**
 * HTTP server: a tiny API (`/api/status`, `/api/turn`, `/api/reset`, `/api/tts`)
 * plus the static browser UI in public/, wired to a Brain and an McpSessionManager.
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Brain } from "./brains/types.js";
import { HTML_SECURITY_HEADERS, guardRequest } from "./security.js";
import type { McpSessionManager } from "./session.js";
import { createTtsRoute } from "./tts/route.js";
import type { TtsProvider } from "./tts/types.js";

const DEFAULT_PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface CreateServerOptions {
  sessionManager: McpSessionManager;
  brain: Brain;
  port?: number;
  publicDir?: string;
  /** Server-side voice (e.g. ElevenLabs). Omit to use the browser's own, as before. */
  tts?: TtsProvider;
  /** Longest reply sent to the TTS provider, in characters. Default 500. */
  ttsMaxChars?: number;
  /** How many synthesized clips to keep in memory. Default 20; 0 disables. */
  ttsCacheEntries?: number;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A client mistake, answered with `status` instead of being treated as a dead session. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

export function createServer(options: CreateServerOptions): http.Server {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  let lastAwaitingConfirm = false;
  const tts = createTtsRoute({
    provider: options.tts,
    maxChars: options.ttsMaxChars ?? 500,
    cacheEntries: options.ttsCacheEntries ?? 20,
  });

  const server = http.createServer(async (req, res) => {
    try {
      // The port is only known once we're listening (it may have been 0).
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 8790);
      const guard = guardRequest(req, port);
      if (!guard.ok) return json(res, guard.status, { error: guard.error });

      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      if (req.method === "GET" && path === "/api/status") {
        try {
          const session = await options.sessionManager.ensureSession();
          return json(res, 200, {
            linked: true,
            mcpUrl: options.sessionManager.mcpUrl,
            brain: options.brain.name,
            tts: { name: tts.name },
            tools: session.tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
          });
        } catch (err) {
          return json(res, 200, {
            linked: false,
            mcpUrl: options.sessionManager.mcpUrl,
            brain: options.brain.name,
            tts: { name: tts.name },
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (req.method === "POST" && path === "/api/turn") {
        const body = (await readJsonBody(req)) as { utterance?: unknown };
        if (typeof body.utterance !== "string" || !body.utterance.trim()) {
          return json(res, 400, { error: "utterance is required" });
        }
        const cleaned = body.utterance.replace(/^\s*(alexa|hey\s+\w+)[,.!]?\s*/i, "").trim();
        const { reply, trace } = await options.brain.turn(cleaned);
        lastAwaitingConfirm = /\b(confirm|say yes|shall i|want me to)\b/i.test(reply);
        return json(res, 200, { reply, trace, brain: options.brain.name, awaitingConfirm: lastAwaitingConfirm });
      }

      if (req.method === "POST" && path === "/api/tts") {
        return await tts.handle(res, await readJsonBody(req));
      }

      if (req.method === "POST" && path === "/api/reset") {
        await options.brain.reset?.();
        lastAwaitingConfirm = false;
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS });
        return res.end(await readFile(join(publicDir, "index.html")));
      }

      if (req.method === "GET" && path === "/tts.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" });
        return res.end(await readFile(join(publicDir, "tts.js")));
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      // A dead session (server restarted, token expired) should relink next turn.
      options.sessionManager.invalidate();
      await options.brain.reset?.();
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(options.port ?? 8790, "127.0.0.1");
  return server;
}
