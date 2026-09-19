import { describe, expect, it } from "vitest";

import { buildCsp, safeSources, sanitizeCspMeta } from "../src/ui/csp.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE, isAppCallable, uiResourceUri, uiVisibility } from "../src/ui/meta.js";

describe("buildCsp", () => {
  it("is deny-by-default with no metadata: no network, no frames, inline script and style only", () => {
    expect(buildCsp()).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'self'; object-src 'none'",
    );
    expect(buildCsp({})).toBe(buildCsp());
  });

  it("maps connectDomains to connect-src only", () => {
    const csp = buildCsp({ connectDomains: ["https://api.example.com", "wss://live.example.com"] });
    expect(csp).toContain("connect-src https://api.example.com wss://live.example.com;");
    expect(csp).not.toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
  });

  it("maps resourceDomains to the asset directives, and adds font-src", () => {
    const csp = buildCsp({ resourceDomains: ["https://cdn.example.com"] });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com;");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.example.com;");
    expect(csp).toContain("img-src 'self' data: https://cdn.example.com;");
    expect(csp).toContain("media-src 'self' data: https://cdn.example.com;");
    expect(csp).toContain("font-src https://cdn.example.com;");
    expect(csp).toContain("connect-src 'none'");
  });

  it("maps frameDomains and baseUriDomains", () => {
    const csp = buildCsp({ frameDomains: ["https://embed.example.com"], baseUriDomains: ["https://base.example.com"] });
    expect(csp).toContain("frame-src https://embed.example.com;");
    expect(csp).toContain("base-uri 'self' https://base.example.com;");
  });

  it("always blocks plugins", () => {
    expect(buildCsp({ resourceDomains: ["https://a.example"] })).toMatch(/object-src 'none'$/);
  });

  it("de-duplicates repeated origins", () => {
    const csp = buildCsp({ connectDomains: ["https://a.example", "https://a.example"] });
    expect(csp.match(/https:\/\/a\.example/g)).toHaveLength(1);
  });

  it("can't be used to add directives or loosen the policy", () => {
    const csp = buildCsp({
      connectDomains: ["https://ok.example; script-src *", "https://evil.example 'unsafe-eval'", "*", "https://*"],
      resourceDomains: ["javascript:alert(1)", "data:", "'self'", "https://good.example"],
    });
    expect(csp).not.toContain("evil.example");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("script-src *");
    expect(csp).not.toContain("javascript:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("https://good.example");
  });
});

describe("safeSources", () => {
  it("accepts plain origins, wildcard subdomains and ports", () => {
    expect(safeSources(["https://a.example", "http://localhost:3000", "https://*.example.com", "wss://x.example:8443"])).toEqual([
      "https://a.example",
      "http://localhost:3000",
      "https://*.example.com",
      "wss://x.example:8443",
    ]);
  });

  it("rejects paths, whitespace, quotes, semicolons, bare schemes and non-strings", () => {
    expect(
      safeSources(["https://a.example/path", "https://a b.example", "https://a.example;", "https://a'.example", "https:", "ftp://a.example", 5, null]),
    ).toEqual([]);
    expect(safeSources("https://a.example")).toEqual([]);
    expect(safeSources(undefined)).toEqual([]);
  });
});

describe("sanitizeCspMeta", () => {
  it("copes with junk", () => {
    expect(sanitizeCspMeta(null)).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(sanitizeCspMeta("nope")).toEqual(sanitizeCspMeta(undefined));
  });
});

describe("tool metadata readers", () => {
  it("reads the view from _meta.ui.resourceUri or the older flat key", () => {
    expect(uiResourceUri({ _meta: { ui: { resourceUri: "ui://a/b" } } })).toBe("ui://a/b");
    expect(uiResourceUri({ _meta: { "ui/resourceUri": "ui://legacy" } })).toBe("ui://legacy");
    expect(uiResourceUri({ _meta: { ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://old" } })).toBe("ui://new");
  });

  it("ignores anything that isn't a ui:// uri", () => {
    expect(uiResourceUri({})).toBeUndefined();
    expect(uiResourceUri({ _meta: { ui: { resourceUri: "https://evil.example" } } })).toBeUndefined();
    expect(uiResourceUri({ _meta: { ui: { resourceUri: 5 } } })).toBeUndefined();
    expect(uiResourceUri({ _meta: { ui: "x" } })).toBeUndefined();
  });

  it("defaults visibility to both, and honours a declared list", () => {
    expect(uiVisibility({})).toEqual(["model", "app"]);
    expect(uiVisibility({ _meta: { ui: { visibility: ["app"] } } })).toEqual(["app"]);
    expect(uiVisibility({ _meta: { ui: { visibility: ["model"] } } })).toEqual(["model"]);
    expect(uiVisibility({ _meta: { ui: { visibility: ["model", "junk"] } } })).toEqual(["model"]);
  });

  it("lets a view call a tool only when its visibility includes app", () => {
    expect(isAppCallable({})).toBe(true);
    expect(isAppCallable({ _meta: { ui: { visibility: ["app"] } } })).toBe(true);
    expect(isAppCallable({ _meta: { ui: { visibility: ["model", "app"] } } })).toBe(true);
    expect(isAppCallable({ _meta: { ui: { visibility: ["model"] } } })).toBe(false);
    expect(isAppCallable({ _meta: { ui: { visibility: [] } } })).toBe(false);
  });

  it("uses the spec's identifiers", () => {
    expect(UI_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(UI_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });
});
