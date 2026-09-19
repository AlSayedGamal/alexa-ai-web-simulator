# Plan: MCP Apps (`ui://`) support in the simulator

**Status:** draft plan, no code yet. Feedback wanted before implementation starts.

## Why

MCP servers can now return an on-screen view next to their spoken reply: a tool declares `_meta.ui.resourceUri: "ui://…"`, the host fetches that HTML resource and renders it in a sandboxed iframe, and the view talks back over `postMessage` ([MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/)). Alexa+'s MCP Toolkit docs say it supports MCP Apps through a webview.

The simulator can't show any of that today. Someone building an MCP Apps view for an Alexa+ server has nowhere to try it short of a full MCP Apps host. The simulator already stands in for Alexa+ as the MCP client; it should stand in for the screen too.

A useful side effect: an MCP Apps view can send the host a message (`ui/message`), which is how "Modify" buttons hand a change back to the assistant. The simulator would be the only free place to try that loop end to end.

## Goals

- When a tool call returns and the tool declares a `ui://` view, show that view on the simulator's device screen, fed with the tool's input and result exactly as a spec-compliant host would.
- Let the view call back into the server (`tools/call`), message the assistant (`ui/message`), open links, and resize, with the same rules a real host applies (tool visibility, CSP, sandbox).
- Show the developer what went wrong when a view misbehaves (blocked by CSP, wrong MIME type, tool call rejected) instead of failing silently.
- Keep text-only servers working exactly as they do now, and make it easy to turn the UI off to test a server's text fallback.

## Non-goals

- **Not a model of Alexa's own webview.** Alexa's docs only say the view renders "in the conversation view". This implements the MCP Apps *spec* host behaviour, and the README should say so, the same way it already scopes the conformance checker to what Amazon documents.
- No fullscreen/PiP display modes, no persistent view state across page reloads, no streaming partial tool input.
- No new brains. The two existing ones are covered below.

## What exists today (facts from the code)

| Piece | Today | Consequence |
| --- | --- | --- |
| `src/mcp.ts` `callTool` | Flattens the result to `text` (joined `text` content blocks) | `structuredContent`, non-text content and `_meta` are dropped before anything else sees them |
| `src/mcp.ts` `McpTool` | `name`, `description`, `title`, `inputSchema` | `_meta` (where `ui.resourceUri` lives) and `outputSchema` are dropped |
| `src/mcp.ts` `connectMcp` | `new Client({name, version})` with no capabilities | Never advertises MCP Apps support, so servers that only register UI tools for UI-capable clients would hide them |
| `src/brains/types.ts` `ToolCallTrace` | `{tool, args, text, isError, ms}` | No place for a result or a view |
| `src/brains/claude.ts` | Calls tools through `callTool` | Can be given the full result with a small change |
| `src/brains/cursor.ts` | Cursor is the MCP client; the trace is rebuilt from Cursor's stream | The simulator never makes these calls, so it may not see `structuredContent` at all (see Risks) |
| `src/server.ts` | `/api/status`, `/api/turn`, `/api/reset`, static `index.html` | Needs new routes for the view and its call-backs |
| `public/index.html` | One inline-script page, no build step; a 2:1 device `.screen` shows `heard` + `reply` | The view goes in that screen |
| Build | `tsc` for `src/`; `package.json` `files: ["dist","public"]` | Browser code needs a build step or has to be plain hand-written JS |

## Design

### 1. Capture the full tool result (no behaviour change)

- `McpTool` gains `_meta?` and `outputSchema?` (pass through what `listTools()` returns).
- `callTool` keeps its current `text`, and also returns the full result: `content`, `structuredContent`, `_meta`, `isError`.
- `ToolCallTrace` gains optional `result?` and `ui?: { resourceUri: string }` (set when the tool declared a view). All additive; existing brains and custom brains keep working.

### 2. Advertise MCP Apps support

`connectMcp` constructs the client with the capability the spec defines:

```json
{ "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } }
```

The SDK's capability schema already has an `extensions` record, so this should need no SDK change (verify in the spike below). Controlled by `SIM_UI` (default on). `SIM_UI=off` omits the capability and skips all view handling, which is exactly the "host without MCP Apps" case servers must degrade for.

### 3. Resolve the view on the server side of the simulator

After a brain turn, for each trace entry whose tool declared `_meta.ui.resourceUri`:

1. `resources/read` the URI through the existing MCP session. Take `contents[0]`, `text` or base64 `blob`.
2. Require `mimeType === "text/html;profile=mcp-app"`. Anything else is skipped with a warning in the trace (a real host would refuse it too).
3. Read per-view metadata from the content item's `_meta.ui` (`csp`, `permissions`, `prefersBorder`, `domain`), falling back to the `resources/list` entry's, as the spec says the content item takes precedence.
4. Cache by URI for the session; drop the cache on `/api/reset` and on reconnect.

`/api/turn` then returns the existing `{reply, trace, brain, awaitingConfirm}` plus, for the **last** view-bearing call of the turn, `ui: { resourceUri, html, meta, toolInput, toolResult }`. The screen shows one view at a time; earlier calls in the turn only get `resourceUri` in their trace entry.

### 4. Host the view in the browser

The spec is explicit for web hosts: **"The Host and the Sandbox MUST have different origins"**, with the view inside a sandbox proxy iframe. So:

- The simulator serves a tiny sandbox-proxy page from a **second listener on `port + 1`** (`localhost:8790` and `localhost:8791` are different origins). Same shape as the reference `basic-host` in the ext-apps repo.
- The host page (`public/`) creates an iframe pointing at that page, and drives it with `AppBridge` from `@modelcontextprotocol/ext-apps/app-bridge`, constructed with no MCP client (`null`) and manual handlers.
- Order the spec requires after the view sends `ui/notifications/initialized`: send `ui/notifications/tool-input` (the call's arguments), then `ui/notifications/tool-result`. The host page does exactly that from the `ui` payload.
- One fresh iframe per view-bearing tool call, the way chat hosts do it (not reused across calls), so views written for a single result behave the same here.

**Fallback if the two-origin setup proves painful:** a single iframe with `srcdoc` and `sandbox="allow-scripts"` (opaque origin). Simpler and still isolated, but not spec-faithful, and views that assume `allow-same-origin` would behave differently. Only take this fallback if the spike finds a real blocker, and say so in the docs.

**Bundling `AppBridge`:** it's an ES module with dependencies, so `public/index.html`'s no-build inline script can't import it directly. Recommended: a small `scripts/build-host.mjs` (esbuild as a devDependency) bundles a `public/host/` entry into `public/host.js`; the built file is committed and `npm run check` fails if it's stale (the same pattern used for the view bundle in the hackathon repo). If the bundle is much larger than ~400 KB or awkward, fall back to a hand-written host of ~150 lines implementing the small slice of the protocol needed. That's smaller than it sounds (initialize response, the two notifications, `tools/call`, `ui/message`), at the cost of owning protocol drift.

### 5. Call-backs from the view

| View sends | Host does |
| --- | --- |
| `tools/call` | `POST /api/ui/tool-call {name, arguments}` → the simulator calls the tool on the MCP session and returns the result. **Rejected unless the tool's `_meta.ui.visibility` includes `"app"`** (default `["model","app"]`), per the spec's MUST. The call shows up in the trace panel tagged "from view". |
| `ui/message` | Becomes a new utterance to the brain, exactly as if typed, tagged "from view" in the log. This is how "Modify" round-trips. The spec allows a host to ask for user consent; the simulator should show what was sent rather than prompt. |
| `ui/open-link` | `https:` only; opens in a new tab with `noopener` after a one-click confirm. |
| `ui/notifications/size-changed` | Resize the iframe inside the screen (clamped to the screen). |
| logging messages | Append to the trace panel. |

### 6. Security model

- **CSP.** Build the policy the spec defines. With no `csp` metadata the default is `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none';`. `connectDomains` → `connect-src`; `resourceDomains` → `img-src`, `script-src`, `style-src`, `font-src`, `media-src`; `frameDomains` → `frame-src` (default `'none'`); `baseUriDomains` → `base-uri` (default `'self'`); always `object-src 'none'`. Pure function `buildCsp(meta)`, unit tested, delivered by the sandbox proxy.
- **Surface violations.** Listen for `securitypolicyviolation` in the sandbox and show "your view tried to load X, blocked by CSP" in the trace panel. This is the single most useful thing the simulator can tell a view author.
- **Permissions.** Map `_meta.ui.permissions` to the iframe `allow` attribute only for what's declared; default none.
- **The new local endpoints are dangerous.** `/api/ui/tool-call` executes tools with the user's linked account. See "Phase 0" below; it is a prerequisite.
- The sandbox proxy page must not be able to reach the host page's origin or its API (different origin plus no CORS headers on `/api`).

### 7. Brains

- **Claude brain:** already goes through `callTool`. Pass the full result into the trace. The model still sees only `content` text, matching the spec (`structuredContent` is for the view, not the model).
- **Cursor brain:** Cursor is the MCP client and the simulator rebuilds the trace from Cursor's stream, so it can render a view only if that stream carries the full result. **Do not re-call the tool to get it**, because that would repeat side effects such as creating a ticket. Spike: check what the stream's `result` contains. If it lacks `structuredContent`, show the reply and trace as today plus a visible note ("view unavailable with the Cursor brain"), and document that.

### 8. Screen layout

When a view is present, the `.screen` switches to a UI mode: the spoken reply shrinks to a caption strip and the iframe takes the rest. A small viewport picker (a few presets plus custom width × height) lets an author see their view at different sizes; the default keeps today's 2:1 ratio. Don't hard-code claims about specific real devices' resolutions in the UI or docs unless verified.

The existing synthetic Confirm/Cancel buttons (driven by a regex over the reply) stay for servers with no view. When a view is showing, hide them, since the view owns confirmation.

### 9. API and type changes (all additive)

- `McpTool`: `_meta?`, `outputSchema?`. `ToolCallTrace`: `result?`, `ui?`, `origin?: "brain" | "view"`.
- `CreateServerOptions`: `ui?: boolean | { sandboxPort?: number }`.
- New routes: `POST /api/ui/tool-call`; the sandbox proxy on `port + 1`.
- `/api/status`: `ui: { enabled }`, and each tool gets `ui?: resourceUri` so the Tools card can badge tools that declare a view.
- Env: `SIM_UI` (`on` default, `off`), `SIM_SANDBOX_PORT` (default `SIM_PORT + 1`).

## Phase 0 (prerequisite, shared with the TTS plan): harden the local API

Found while reading `src/server.ts`, **not yet reproduced**: `readJsonBody` parses the body regardless of `content-type`, and there is no `Host` or `Origin` check. That means:

- A web page open in the same browser can send a cross-origin "simple" `POST` (`text/plain`, `mode: "no-cors"`) to `http://127.0.0.1:8790/api/turn`. No preflight is required, so it runs a brain turn on the user's linked MCP account and LLM key.
- A DNS-rebinding page can do the same with a chosen `Host`.

This already applies to `/api/turn` and `/api/reset`. It gets worse with a route that runs tools on behalf of a view (`/api/ui/tool-call`) or spends money (the TTS plan's `/api/tts`). Fix first, as a small PR:

1. Reject any `/api/*` request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`.
2. Reject any request that carries an `Origin` that isn't the server's own origin.
3. Require `content-type: application/json` on `POST`s, and send no CORS headers.
4. Tests for each of those rejecting, and for the normal browser flow still working.

Whichever of the UI and TTS work lands first takes this PR.

## Phases (each its own PR)

| # | PR | Size | Notes |
| --- | --- | --- | --- |
| 0 | Local API hardening (above) | S | Independent, do first |
| 1 | Capture full results, advertise the capability, `SIM_UI` | S | No visible change. Ships the type additions and tests |
| 2 | Resolve views + `/api/turn` `ui` payload + `/api/ui/tool-call` proxy + `buildCsp` | M | Server side only, fully testable without a browser |
| 3 | Browser host: sandbox proxy on `port + 1`, `AppBridge` bundle, screen layout, `ui/message` → turn | L | The spike happens at the start of this PR |
| 4 | DX: CSP-violation reporting, viewport presets, tool badges, README section, demo GIF | M | Optional: a `mcp-voice-simulator-conformance --ui` check (tools that declare `ui://` have a readable, correctly-typed, self-contained resource) |

## Spike (first task of Phase 3, ~half a day, timeboxed)

Answer these before committing to the design, and record the outcomes in this doc:

1. Does `new Client(..., { capabilities: { extensions: {...} } })` actually send the extension on `initialize`? (Read the server's `getClientCapabilities()` in a throwaway test.)
2. Does `AppBridge` bundle for the browser cleanly, and at what size?
3. Does the two-origin sandbox proxy work with `AppBridge` over `postMessage` on localhost as in the reference host?
4. What does the Cursor stream's tool `result` contain? Is `structuredContent` there?

## Testing

- **Unit (vitest, no browser):** `buildCsp` (exact default string, every domain mapping, `object-src 'none'`); view resolution (good resource, wrong MIME type, `resources/read` failing, `SIM_UI=off`, content-level `_meta` overriding list-level); visibility check on the call-back route (`["model"]`-only tool rejected, default and `["app"]` allowed); `callTool` returning `structuredContent`/`_meta`.
- **Server routes:** fake session + fake brain over a real `http` server, in the style of the existing tests: `ui` payload present only when expected; Phase 0 rejections.
- **Real protocol, no browser:** a fixture MCP server in `test/fixtures/` using `@modelcontextprotocol/server` and the ext-apps `registerAppTool`/`registerAppResource` (devDependencies), on an ephemeral port with a bearer token accepted. Connect with `connectMcp`, and assert capability advertisement, `resources/read`, and a full tool-call → `ui` payload.
- **Host page:** run the built host page in `jsdom` (`runScripts: "dangerously"`) with a stubbed `fetch` and a fixture view, and assert the handshake, that `tool-input` then `tool-result` arrive in order, that `tools/call` goes to `/api/ui/tool-call`, and that `ui/message` triggers a new turn. jsdom can't model real cross-origin isolation, so the two-origin behaviour and CSP enforcement are covered by the manual checklist; add a Playwright smoke test later if that proves flaky.
- CI already runs `npm run check`; the host-bundle drift check joins it.

## Manual verification (real server)

Against the hackathon MCP server, which already exposes five `ui://` views (recap, action, jobs, ticket, checklist) across six tools (currently on the `alexa-plus-mcp-hackathon` PRs #2 and #3; use those branches until they merge):

1. "Let's recap the meeting" → the recap view appears in the screen.
2. "Let's action the meeting" → the preview with Confirm/Cancel; Confirm calls `action_meeting` through `/api/ui/tool-call` and the view updates to "Done".
3. Create a ticket → the draft view; **Modify** arrives as a "from view" turn and produces a fresh draft.
4. `SIM_UI=off` → text-only behaviour, no capability advertised.
5. A view that tries to `fetch` an external URL → blocked, and the violation appears in the trace panel.

## Risks and open questions

- **Cursor brain fidelity** (see Design 7): may need to ship as "Claude brain only" for views. That is acceptable if documented.
- **Bundle size / build step** for `AppBridge`: mitigated by the hand-written-host fallback.
- **Fidelity claim.** Whether Alexa's webview enforces the same sandbox and CSP as the spec is unknown. Keep the README scoped to "MCP Apps spec host".
- **Two-port setup** adds a moving part (`SIM_SANDBOX_PORT` collisions). The `srcdoc` fallback exists for that reason.
- **Scope creep** toward being a general MCP Apps host. The non-goals above are the guardrail.

## Definition of done

Against the hackathon server, the five manual checks above pass; `SIM_UI=off` restores the old behaviour; the new tests and the drift check are in CI; the README documents `SIM_UI`, the second port, and what is and isn't emulated.
