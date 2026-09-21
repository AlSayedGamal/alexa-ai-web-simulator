/**
 * A tiny generic MCP server used only to demonstrate the simulator.
 * It is a fictional task tracker — not a stand-in for any real product.
 *
 * Tools:
 * - `list_tasks` — model-visible, declares `ui://demo/tasks`
 * - `create_task` — spoken confirm/dry-run, no view (so Confirm/Cancel show)
 * - `get_task_status` — spoken status
 * - `complete_task` — app-only (`visibility: ["app"]`), called from the view
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { build } from "esbuild";
import { z } from "zod";

export interface DemoTask {
  id: string;
  title: string;
  status: "open" | "in progress" | "done";
}

export interface DemoServer {
  url: string;
  token: string;
  tasks: DemoTask[];
  close(): Promise<void>;
}

const dropZodLocales = {
  name: "drop-zod-locales",
  setup(b: { onResolve: Function; onLoad: Function }) {
    b.onResolve({ filter: /locales\/index\.js$/ }, (args: { importer: string; path: string }) =>
      args.importer.includes("/node_modules/zod/") ? { path: args.path, namespace: "empty-locales" } : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "empty-locales" }, () => ({ contents: "export {};", loader: "js" }));
  },
};

let viewScript: string | undefined;

async function bundleViewScript(): Promise<string> {
  if (viewScript) return viewScript;
  const entry = join(dirname(fileURLToPath(import.meta.url)), "demo-view.ts");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [dropZodLocales],
  });
  viewScript = result.outputFiles[0]!.text;
  return viewScript;
}

function tasksHtml(script: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ui://demo/tasks</title>
<style>
  html, body { margin: 0; height: 100%; background: #05080d; color: #e6edf3; font: 15px/1.4 system-ui, sans-serif; }
  #root { height: 100%; padding: 16px 20px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .kicker { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #8b949e; font-weight: 600; }
  code { font: 12px ui-monospace, monospace; color: #00caff; }
  p { margin: 0; color: #8b949e; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; overflow: auto; }
  .task { display: grid; grid-template-columns: 64px 1fr auto auto; gap: 10px; align-items: center;
          background: #161b22; border: 1px solid #2a313c; border-radius: 10px; padding: 10px 12px; }
  .id { font: 12px ui-monospace, monospace; color: #8b949e; }
  .status { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; border-radius: 999px; padding: 3px 8px; }
  .status.ok { color: #3fb950; background: rgba(63,185,80,.12); }
  .status.live { color: #00caff; background: rgba(0,202,255,.12); }
  .status.open { color: #d29922; background: rgba(210,153,34,.12); }
  button { background: #161b22; color: #e6edf3; border: 1px solid #2a313c; border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { border-color: #00caff; }
  .ask { align-self: start; background: #00caff; color: #002733; border-color: #00caff; font-weight: 600; }
</style>
</head>
<body>
  <div id="root">
    <header>
      <span class="kicker">MCP Apps view</span>
      <code>ui://demo/tasks</code>
    </header>
    <p>Connecting to host…</p>
  </div>
  <script>${script.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}

function spokenList(tasks: DemoTask[]): string {
  if (!tasks.length) return "You have no tasks.";
  return `Here are your ${tasks.length} tasks. The first is ${tasks[0]!.title}.`;
}

function buildServer(tasks: DemoTask[], script: string): McpServer {
  const server = new McpServer({ name: "sample-tasks", version: "0.0.0" });
  let nextId = tasks.length + 1;
  const VIEW = "ui://demo/tasks";

  registerAppResource(
    server,
    "Task board",
    VIEW,
    { description: "A board of the current tasks" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: tasksHtml(script),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "list_tasks",
    {
      description: "List the current tasks",
      inputSchema: z.object({ query: z.string().optional() }),
      _meta: { ui: { resourceUri: VIEW } },
    },
    async (args: { query?: string }) => {
      const query = (args.query ?? "").trim().toLowerCase();
      const matches = query ? tasks.filter((task) => task.title.toLowerCase().includes(query)) : [...tasks];
      return {
        content: [{ type: "text" as const, text: spokenList(matches) }],
        structuredContent: { tasks: matches },
      };
    },
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task",
      inputSchema: z.object({
        title: z.string(),
        dryRun: z.boolean().optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async (args: { title: string; dryRun?: boolean; confirm?: boolean }) => {
      const title = args.title.trim() || "Untitled task";
      if (args.dryRun && !args.confirm) {
        return {
          content: [{ type: "text" as const, text: `I'll add a task called ${title}. Shall I go ahead?` }],
        };
      }
      const task: DemoTask = { id: `task-${nextId++}`, title, status: "open" };
      tasks.push(task);
      return {
        content: [{ type: "text" as const, text: `Done. I created ${task.id}: ${task.title}.` }],
        structuredContent: { task },
      };
    },
  );

  server.registerTool(
    "get_task_status",
    {
      description: "Check a task's status",
      inputSchema: z.object({ taskId: z.string().optional() }),
    },
    async (args: { taskId?: string }) => {
      const task = args.taskId ? tasks.find((item) => item.id === args.taskId) : tasks.at(-1);
      if (!task) return { content: [{ type: "text" as const, text: "I couldn't find that task." }] };
      return {
        content: [{ type: "text" as const, text: `${task.id} is ${task.status}: ${task.title}.` }],
        structuredContent: { task },
      };
    },
  );

  registerAppTool(
    server,
    "complete_task",
    {
      description: "Mark a task done (callable from the view)",
      inputSchema: z.object({ taskId: z.string() }),
      _meta: { ui: { resourceUri: VIEW, visibility: ["app"] } },
    },
    async (args: { taskId: string }) => {
      const task = tasks.find((item) => item.id === args.taskId);
      if (task) task.status = "done";
      return {
        content: [{ type: "text" as const, text: task ? `${task.id} is done.` : "I couldn't find that task." }],
        structuredContent: { tasks: [...tasks] },
      };
    },
  );

  return server;
}

export async function startDemoServer(options: { token?: string; port?: number } = {}): Promise<DemoServer> {
  const token = options.token ?? "demo-token";
  const script = await bundleViewScript();
  const tasks: DemoTask[] = [
    { id: "task-1", title: "Buy oat milk", status: "done" },
    { id: "task-2", title: "Book the dentist", status: "in progress" },
  ];
  const handler = createMcpHandler(() => buildServer(tasks, script));

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
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
    tasks,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
