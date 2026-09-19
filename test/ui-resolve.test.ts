import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { callTool, connectMcp, type McpSession, type ToolCallTrace } from "../src/mcp.js";
import { readUiResource, resolveUiForTurn } from "../src/ui/resolve.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE, uiResourceUri } from "../src/ui/meta.js";

import { startAppsFixture, type AppsFixture } from "./fixtures/apps-server.js";

let fixture: AppsFixture;
let session: McpSession;

beforeAll(async () => {
  fixture = await startAppsFixture();
  session = await connectMcp(fixture.url, fixture.token);
});
afterAll(() => fixture.close());

describe("connecting", () => {
  it("advertises MCP Apps support to the server by default", () => {
    const initialize = fixture.initCapabilities[0] as { extensions?: Record<string, { mimeTypes?: string[] }> };
    expect(initialize.extensions?.[UI_EXTENSION_ID]?.mimeTypes).toEqual([UI_MIME_TYPE]);
    expect(session.ui).toBe(true);
  });

  it("advertises nothing when views are off, like a host without MCP Apps", async () => {
    const before = fixture.initCapabilities.length;
    const off = await connectMcp(fixture.url, fixture.token, { ui: false });
    const initialize = fixture.initCapabilities[before] as { extensions?: unknown } | undefined;
    expect(initialize).toBeDefined();
    expect(initialize?.extensions).toBeUndefined();
    expect(off.ui).toBe(false);
  });

  it("keeps each tool's _meta so a declared view can be found", () => {
    const show = session.tools.find((t) => t.name === "show_card")!;
    expect(uiResourceUri(show)).toBe("ui://fixture/card");
    expect(uiResourceUri(session.tools.find((t) => t.name === "plain")!)).toBeUndefined();
    expect(session.tools.find((t) => t.name === "refresh_card")?._meta?.ui).toMatchObject({ visibility: ["app"] });
  });
});

describe("callTool", () => {
  it("returns the full result, not just its text", async () => {
    const entry = await callTool(session, "show_card", { title: "Hi" });
    expect(entry.text).toBe("show_card ran with Hi");
    expect(entry.result?.structuredContent).toEqual({ title: "Hi", tool: "show_card" });
    expect(entry.result?.content).toEqual([{ type: "text", text: "show_card ran with Hi" }]);
    expect(entry.origin).toBe("brain");
    expect(entry.ui).toEqual({ resourceUri: "ui://fixture/card" });
  });

  it("marks a call made by a view", async () => {
    expect((await callTool(session, "refresh_card", {}, "view")).origin).toBe("view");
  });

  it("carries no view for a tool that declares none, or when views are off", async () => {
    expect((await callTool(session, "plain", {})).ui).toBeUndefined();
    const off = await connectMcp(fixture.url, fixture.token, { ui: false });
    expect((await callTool(off, "show_card", { title: "x" })).ui).toBeUndefined();
  });
});

describe("readUiResource", () => {
  it("reads the html and the metadata on the content item", async () => {
    const view = await readUiResource(session, "ui://fixture/card");
    expect(view.html).toContain("card view");
    expect(view.csp.connectDomains).toEqual(["https://content.example"]);
    expect(view.permissions).toEqual({ clipboardWrite: {} });
    expect(view.prefersBorder).toBe(true);
  });

  it("falls back to the listing's metadata when the content item has none", async () => {
    const view = await readUiResource(session, "ui://fixture/listing-only");
    expect(view.csp.connectDomains).toEqual(["https://listing.example"]);
  });

  it("refuses a view with the wrong MIME type", async () => {
    await expect(readUiResource(session, "ui://fixture/badmime")).rejects.toThrow(/MIME type "text\/plain"/);
  });

  it("rejects a resource the server doesn't have", async () => {
    await expect(readUiResource(session, "ui://fixture/does-not-exist")).rejects.toThrow();
  });
});

describe("resolveUiForTurn", () => {
  it("builds the payload for a view-bearing call: html, metadata, tool input and result", async () => {
    const entry = await callTool(session, "show_card", { title: "Hello" });
    const { ui, warnings } = await resolveUiForTurn(session, [entry], "claude");
    expect(warnings).toEqual([]);
    expect(ui).toMatchObject({
      resourceUri: "ui://fixture/card",
      tool: "show_card",
      toolInput: { title: "Hello" },
      toolResult: { structuredContent: { title: "Hello", tool: "show_card" } },
    });
    expect(ui?.html).toContain("card view");
    expect(ui?.csp.connectDomains).toEqual(["https://content.example"]);
  });

  it("shows the LAST view-bearing call of the turn", async () => {
    const first = await callTool(session, "show_card", { title: "one" });
    const second = await callTool(session, "listing_view", { title: "two" });
    const plain = await callTool(session, "plain", {});
    const { ui } = await resolveUiForTurn(session, [first, second, plain], "claude");
    expect(ui?.tool).toBe("listing_view");
  });

  it("has no view for a turn with no view-bearing call", async () => {
    const { ui, warnings } = await resolveUiForTurn(session, [await callTool(session, "plain", {})], "claude");
    expect(ui).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns instead of failing when the view can't be shown", async () => {
    const bad = await resolveUiForTurn(session, [await callTool(session, "bad_view", {})], "claude");
    expect(bad.ui).toBeUndefined();
    expect(bad.warnings[0]).toMatch(/Could not show the view for "bad_view".*MIME type/);

    const missing = await resolveUiForTurn(session, [await callTool(session, "missing_view", {})], "claude");
    expect(missing.ui).toBeUndefined();
    expect(missing.warnings[0]).toMatch(/Could not show the view for "missing_view"/);
  });

  it("explains, and never re-calls the tool, when a brain doesn't return the full result", async () => {
    const before = fixture.calls.length;
    // What a brain that makes tool calls itself (Cursor) hands back: text only.
    const textOnly: ToolCallTrace = { tool: "show_card", args: { title: "x" }, text: "ran", isError: false, ms: 1 };
    const { ui, warnings } = await resolveUiForTurn(session, [textOnly], "cursor");
    expect(ui).toBeUndefined();
    expect(warnings[0]).toMatch(/"show_card" declares a view, but the cursor brain makes tool calls itself/);
    expect(fixture.calls.length).toBe(before); // a mutating tool would repeat its side effects
  });

  it("does nothing when views are off", async () => {
    const off = await connectMcp(fixture.url, fixture.token, { ui: false });
    const entry = await callTool(off, "show_card", { title: "x" });
    expect(await resolveUiForTurn(off, [entry], "claude")).toEqual({ warnings: [] });
  });
});
