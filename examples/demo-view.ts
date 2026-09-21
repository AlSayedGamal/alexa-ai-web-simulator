/**
 * Browser view for `ui://demo/tasks`. Bundled into the resource HTML so the
 * sample server can show a real MCP Apps handshake (tool-result, tools/call,
 * ui/message) without loading anything from the network.
 */
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

interface Task {
  id: string;
  title: string;
  status: "open" | "in progress" | "done";
}

const app = new App({ name: "sample-task-board", version: "0.0.0" });
const root = document.getElementById("root")!;

function tasksOf(value: unknown): Task[] {
  if (!value || typeof value !== "object") return [];
  const tasks = (value as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? (tasks as Task[]) : [];
}

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function render(tasks: Task[]): void {
  const rows = tasks
    .map((task) => {
      const tone = task.status === "done" ? "ok" : task.status === "in progress" ? "live" : "open";
      const action =
        task.status === "done"
          ? ""
          : `<button type="button" data-complete="${esc(task.id)}">Mark done</button>`;
      return `<li class="task">
        <span class="id">${esc(task.id)}</span>
        <span class="title">${esc(task.title)}</span>
        <span class="status ${tone}">${esc(task.status)}</span>
        ${action}
      </li>`;
    })
    .join("");

  root.innerHTML = `
    <header>
      <span class="kicker">MCP Apps view</span>
      <code>ui://demo/tasks</code>
    </header>
    <p>${tasks.length} tasks from the sample MCP server</p>
    <ul>${rows}</ul>
    <button type="button" class="ask" data-ask="1">Ask to add a task</button>
  `;
}

async function complete(taskId: string): Promise<void> {
  const result = await app.callServerTool({ name: "complete_task", arguments: { taskId } });
  render(tasksOf(result.structuredContent));
}

async function ask(): Promise<void> {
  await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: "Create a task to water the plants" }],
  });
}

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest("button");
  if (!target) return;
  if (target.dataset.complete) void complete(target.dataset.complete);
  if (target.dataset.ask) void ask();
});

async function main(): Promise<void> {
  app.ontoolresult = (params) => render(tasksOf(params.structuredContent));
  await app.connect(new PostMessageTransport(window.parent, window.parent));
}

void main();
