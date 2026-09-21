/**
 * Record a walkthrough of the simulator against the sample MCP server.
 *
 *   npx tsx examples/record-demo.ts
 *
 * Covers: account-linked status, tool discovery (including 🖼 / ui:// tools),
 * typed utterances, the thinking ring, MCP call traces, an MCP Apps view,
 * tools/call from the view, ui/message from the view, Confirm, and screen
 * shapes. The sample server is fictional — nothing from a real application
 * is shown.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type FrameLocator, type Page } from "playwright";

import { createServer, McpSessionManager } from "../src/index.js";
import { startDemoServer } from "./demo-server.js";
import { createScriptedBrain } from "./scripted-brain.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const port = Number(process.env.SIM_PORT ?? 8870);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(cmd: string, args: string[]): Promise<void> {
  const child = spawn(cmd, args, { stdio: "inherit" });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

async function typeUtterance(page: Page, text: string): Promise<void> {
  await page.locator("#input").click();
  await page.locator("#input").fill("");
  await page.locator("#input").pressSequentially(text, { delay: 36 });
  await sleep(280);
  await page.locator("#send").click();
}

function viewFrame(page: Page): FrameLocator {
  return page.frameLocator("#view iframe").frameLocator("iframe");
}

const demo = await startDemoServer({ port: port + 2 });
const sessionManager = new McpSessionManager({ mcpUrl: demo.url, bearerToken: demo.token, ui: true });
const brain = createScriptedBrain(() => sessionManager.ensureSession());
const server = createServer({ sessionManager, brain, port, ui: { sandboxPort: port + 1 } });
await once(server, "listening");

await mkdir(docs, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--disable-speech-api"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: docs, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.locator("#status").getByText("Account linked").waitFor({ timeout: 15_000 });
  await page.locator("#tools").getByText("list_tasks").waitFor();
  await page.locator("#tools").getByText("complete_task").waitFor();
  await page.locator("#speak").click();
  await sleep(1400);

  await typeUtterance(page, "List my tasks");
  await page.locator("#screen[data-ui='true']").waitFor({ timeout: 15_000 });
  await viewFrame(page).getByText("ui://demo/tasks").waitFor({ timeout: 15_000 });
  await viewFrame(page).getByText("Book the dentist").waitFor();
  await sleep(1600);

  await page.locator(".log details summary").first().click();
  await sleep(1200);

  await page.locator("#size").selectOption("tall");
  await sleep(1400);
  await page.locator("#size").selectOption("small");
  await sleep(1200);
  await page.locator("#size").selectOption("");
  await sleep(800);

  await viewFrame(page).getByRole("button", { name: "Mark done" }).click();
  await page.locator(".log").getByText("from view").waitFor({ timeout: 10_000 });
  await viewFrame(page).locator(".status.ok").nth(1).waitFor();
  await sleep(1600);

  await viewFrame(page).getByRole("button", { name: "Ask to add a task" }).click();
  await page.locator("#screen[data-confirm='true']").waitFor({ timeout: 10_000 });
  await page.locator("#reply").getByText("Shall I go ahead").waitFor();
  await page.locator(".log").getByText("from a view").waitFor();
  await sleep(1500);

  await page.locator(".confirm .primary").click();
  await page.locator("#reply").getByText("Done. I created task-3").waitFor({ timeout: 10_000 });
  await sleep(1400);

  await typeUtterance(page, "List my tasks");
  await viewFrame(page).getByText("water the plants").waitFor({ timeout: 15_000 });
  await sleep(2800);
} catch (err) {
  await page.screenshot({ path: join(docs, "demo-failure.png"), fullPage: true }).catch(() => undefined);
  throw err;
} finally {
  await context.close();
  await browser.close();
  server.close();
  await demo.close();
}

const recorded = (await readdir(docs)).find((name) => name.endsWith(".webm"));
if (!recorded) throw new Error("Playwright did not write a webm recording.");
const webm = join(docs, "demo.webm");
if (recorded !== "demo.webm") await rename(join(docs, recorded), webm);

const mp4 = join(docs, "demo.mp4");
const gif = join(docs, "demo.gif");
await run("ffmpeg", ["-y", "-i", webm, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
await run("ffmpeg", [
  "-y",
  "-i",
  webm,
  "-an",
  "-vf",
  "fps=12,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
  gif,
]);

console.log(`wrote ${mp4}`);
console.log(`wrote ${gif}`);
