/**
 * The Content-Security-Policy a host must apply to an MCP Apps view, built from
 * the resource's `_meta.ui.csp` (MCP Apps spec, "Content Security Policy Enforcement").
 *
 * With no metadata the policy is deny-by-default: inline script/style and
 * same-origin/data assets only, no network (`connect-src 'none'`), no nested frames.
 */

export interface UiCspMeta {
  /** Origins for fetch / XHR / WebSocket → `connect-src`. */
  connectDomains?: string[];
  /** Origins for static assets → `img-src`, `script-src`, `style-src`, `font-src`, `media-src`. */
  resourceDomains?: string[];
  /** Origins for nested iframes → `frame-src` (default `'none'`). */
  frameDomains?: string[];
  /** Origins for `<base>` → `base-uri` (default `'self'`). */
  baseUriDomains?: string[];
}

/**
 * Only plain origins are accepted (scheme, optional `*.` wildcard, host, optional
 * port). Anything else is dropped rather than being spliced into a header, so a
 * hostile resource can't smuggle in `;`, spaces or quotes to add its own directives.
 */
const SAFE_SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::(?:\d{1,5}|\*))?$/i;

export function safeSources(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && SAFE_SOURCE.test(value)) seen.add(value);
  }
  return [...seen];
}

/** Coerce untrusted JSON (a resource's `_meta`, a query string) into a `UiCspMeta` with only safe origins. */
export function sanitizeCspMeta(raw: unknown): UiCspMeta {
  const meta = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    connectDomains: safeSources(meta.connectDomains),
    resourceDomains: safeSources(meta.resourceDomains),
    frameDomains: safeSources(meta.frameDomains),
    baseUriDomains: safeSources(meta.baseUriDomains),
  };
}

export function buildCsp(input?: UiCspMeta): string {
  const meta = sanitizeCspMeta(input);
  const connect = meta.connectDomains ?? [];
  const resources = meta.resourceDomains ?? [];
  const frames = meta.frameDomains ?? [];
  const bases = meta.baseUriDomains ?? [];

  const directives: string[] = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resources.map((d) => ` ${d}`).join("")}`,
    `style-src 'self' 'unsafe-inline'${resources.map((d) => ` ${d}`).join("")}`,
    `img-src 'self' data:${resources.map((d) => ` ${d}`).join("")}`,
    `media-src 'self' data:${resources.map((d) => ` ${d}`).join("")}`,
  ];
  if (resources.length) directives.push(`font-src ${resources.join(" ")}`);
  directives.push(`connect-src ${connect.length ? connect.join(" ") : "'none'"}`);
  directives.push(`frame-src ${frames.length ? frames.join(" ") : "'none'"}`);
  directives.push(`base-uri ${["'self'", ...bases].join(" ")}`);
  directives.push("object-src 'none'");
  return directives.join("; ");
}
