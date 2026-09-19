/**
 * MCP Apps constants and the small readers for a tool's `_meta.ui`.
 * https://apps.extensions.modelcontextprotocol.io/api/
 */

/** Key under a client's `capabilities.extensions` that advertises MCP Apps support. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** The only content type a view resource may have. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export type ToolVisibility = "model" | "app";

interface HasMeta {
  _meta?: Record<string, unknown>;
}

function uiMeta(tool: HasMeta): Record<string, unknown> | undefined {
  const ui = tool._meta?.ui;
  return typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>) : undefined;
}

/** The `ui://` view a tool declares, from `_meta.ui.resourceUri` or the older flat `_meta["ui/resourceUri"]`. */
export function uiResourceUri(tool: HasMeta): string | undefined {
  const uri = uiMeta(tool)?.resourceUri ?? tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/** Who may call a tool. Defaults to both the model and the view when undeclared. */
export function uiVisibility(tool: HasMeta): ToolVisibility[] {
  const declared = uiMeta(tool)?.visibility;
  if (!Array.isArray(declared)) return ["model", "app"];
  return declared.filter((v): v is ToolVisibility => v === "model" || v === "app");
}

/** The spec: a host MUST reject a view's `tools/call` unless the tool's visibility includes "app". */
export function isAppCallable(tool: HasMeta): boolean {
  return uiVisibility(tool).includes("app");
}
