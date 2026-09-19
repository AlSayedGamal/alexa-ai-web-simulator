/**
 * Turns "a tool declared a view and returned a result" into what the browser
 * needs to show it: the view's HTML, its CSP/permissions metadata, and the
 * tool's input and result (fed to the view as `tool-input` / `tool-result`).
 */
import type { McpSession, ToolCallResult, ToolCallTrace } from "../mcp.js";

import { sanitizeCspMeta, type UiCspMeta } from "./csp.js";
import { UI_MIME_TYPE, uiResourceUri } from "./meta.js";

export interface UiPermissions {
  camera?: object;
  microphone?: object;
  geolocation?: object;
  clipboardWrite?: object;
}

export interface UiPayload {
  resourceUri: string;
  /** The tool call this view belongs to. */
  tool: string;
  html: string;
  csp: UiCspMeta;
  permissions: UiPermissions;
  prefersBorder?: boolean;
  toolInput: Record<string, unknown>;
  toolResult: ToolCallResult;
}

export interface ResolvedUi {
  ui?: UiPayload;
  /** Things a real host would also refuse or skip, for the trace panel. */
  warnings: string[];
}

interface ResourceView {
  html: string;
  csp: UiCspMeta;
  permissions: UiPermissions;
  prefersBorder?: boolean;
}

type UiResourceMeta = { csp?: unknown; permissions?: unknown; prefersBorder?: unknown };

function metaOf(value: unknown): UiResourceMeta | undefined {
  const ui = (value as { _meta?: { ui?: unknown } } | undefined)?._meta?.ui;
  return typeof ui === "object" && ui !== null ? (ui as UiResourceMeta) : undefined;
}

function sanitizePermissions(raw: unknown): UiPermissions {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const out: UiPermissions = {};
  for (const key of ["camera", "microphone", "geolocation", "clipboardWrite"] as const) {
    if (typeof source[key] === "object" && source[key] !== null) out[key] = {};
  }
  return out;
}

/**
 * Read one `ui://` resource. Throws with a message fit for the trace panel when a
 * spec-compliant host would refuse it (wrong MIME type, no content, read failure).
 */
export async function readUiResource(session: McpSession, uri: string): Promise<ResourceView> {
  const read = await session.client.readResource({ uri });
  const content = read.contents[0] as
    | { mimeType?: string; text?: string; blob?: string; _meta?: unknown }
    | undefined;
  if (!content) throw new Error(`"${uri}" returned no content.`);
  if (content.mimeType !== UI_MIME_TYPE) {
    throw new Error(`"${uri}" has MIME type "${content.mimeType ?? "(none)"}", but a view must be "${UI_MIME_TYPE}".`);
  }

  let html: string;
  if (typeof content.text === "string") html = content.text;
  else if (typeof content.blob === "string") html = Buffer.from(content.blob, "base64").toString("utf8");
  else throw new Error(`"${uri}" has neither text nor blob content.`);

  // Metadata on the content item wins; the resources/list entry is the fallback.
  let meta = metaOf(content);
  if (!meta) {
    try {
      const { resources } = await session.client.listResources();
      meta = metaOf(resources.find((r) => r.uri === uri));
    } catch {
      // a server without resources/list just has no listing-level metadata
    }
  }

  return {
    html,
    csp: sanitizeCspMeta(meta?.csp),
    permissions: sanitizePermissions(meta?.permissions),
    ...(typeof meta?.prefersBorder === "boolean" ? { prefersBorder: meta.prefersBorder } : {}),
  };
}

/**
 * Pick the view to show for a turn: the LAST tool call that declared one (the
 * screen shows one view at a time). Never re-calls a tool to get a missing
 * result — a mutating tool would repeat its side effects.
 */
export async function resolveUiForTurn(
  session: McpSession,
  trace: ToolCallTrace[],
  brainName: string,
): Promise<ResolvedUi> {
  const warnings: string[] = [];
  if (!session.ui) return { warnings };

  for (const entry of trace) {
    if (entry.result || entry.ui) continue;
    const tool = session.tools.find((t) => t.name === entry.tool);
    if (tool && uiResourceUri(tool)) {
      warnings.push(
        `"${entry.tool}" declares a view, but the ${brainName} brain makes tool calls itself and doesn't hand back the full result, so the view can't be shown.`,
      );
    }
  }

  const withView = trace.filter((t) => t.ui && t.result);
  const last = withView[withView.length - 1];
  if (!last?.ui || !last.result) return { warnings };

  try {
    const view = await readUiResource(session, last.ui.resourceUri);
    return {
      warnings,
      ui: {
        resourceUri: last.ui.resourceUri,
        tool: last.tool,
        toolInput: last.args,
        toolResult: last.result,
        ...view,
      },
    };
  } catch (err) {
    warnings.push(`Could not show the view for "${last.tool}": ${err instanceof Error ? err.message : String(err)}`);
    return { warnings };
  }
}
