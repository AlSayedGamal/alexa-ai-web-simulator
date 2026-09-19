# mcp-voice-simulator

> **Unofficial, community-built, not affiliated with or endorsed by Amazon.**
> Amazon's own docs state that ["Category SDK and MCP Toolkit are available to
> select partners only"](https://developer.amazon.com/docs/alexaplus/add-ons/home.html) —
> there is no public Alexa AI CLI, add-on registration, or device simulator
> available to most developers, including hackathon participants building for
> the Alexa+ track. This project does not use, wrap, or reverse-engineer any
> private Amazon tool or access. It's a clean-room implementation built only
> from published specs: MCP's own [Streamable HTTP
> transport](https://modelcontextprotocol.io/docs/latest/getting-started/intro),
> [OAuth 2.1](https://oauth.net/2.1/), PKCE
> ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), Protected Resource
> Metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), Authorization
> Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)), and
> Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)).

## What it does

Stands in for Alexa+ as the **MCP client**, in the same order a real Alexa+
integration would:

1. **Account linking** — OAuth 2.1 + PKCE, discovered via RFC 9728/8414 against
   *any* spec-compliant MCP server, not one hardcoded login flow. A human
   completes login in their own browser (the standard "loopback" pattern —
   the same one `gcloud auth login` and similar CLIs use), so it works
   whatever your server's login screen looks like.
2. **Tool discovery** — `tools/list` over MCP's Streamable HTTP transport.
3. **Per utterance** — pick a tool, call it, and speak the result back, via a
   pluggable **brain**.

Two brains ship ready to use, needing no per-server tuning because they pick
tools from whatever `tools/list` returns:

- **`createClaudeBrain`** — an Anthropic Messages API tool-use loop
  (needs `ANTHROPIC_API_KEY` and the peer dependency `@anthropic-ai/sdk`)
- **`createCursorBrain`** — a Cursor agent restricted to your server's MCP
  tools, so Cursor itself is the MCP client
  (needs `CURSOR_API_KEY` and the peer dependency `@cursor/sdk`)

There's no built-in "no API key" brain — picking a tool from open-ended
natural language needs an LLM unless you write one for your own specific
tools. `examples/scripted-brain.ts` shows exactly that pattern; copy it for
yours.

## Quickstart (CLI)

```bash
npm install -g mcp-voice-simulator
npm install @anthropic-ai/sdk   # or @cursor/sdk, whichever brain you want

MCP_URL=https://your-server.example.com/mcp \
ANTHROPIC_API_KEY=sk-ant-... \
mcp-voice-simulator
```

Open the printed `http://127.0.0.1:8790` URL. It links an account against
your server (opening the authorize URL for you to complete in a browser),
discovers its tools, and lets you type or speak utterances.

If your server doesn't implement RFC 7591 dynamic client registration (most
don't — it's optional even in a fully spec-compliant setup), set
`MCP_CLIENT_ID` to a pre-configured client id instead. If you already have a
bearer token and want to skip account linking entirely, set
`MCP_BEARER_TOKEN`.

| Env var | Purpose |
| --- | --- |
| `MCP_URL` | required — the MCP server's endpoint |
| `MCP_CLIENT_ID` | OAuth client id, if your server has no dynamic registration |
| `MCP_BEARER_TOKEN` | skip account linking entirely |
| `SIM_PORT` | default `8790` |
| `SIM_BRAIN` | force `claude` or `cursor` (default: cursor if `CURSOR_API_KEY` is set, else claude) |
| `ANTHROPIC_API_KEY`, `SIM_MODEL` | for the Claude brain (`SIM_MODEL` default `claude-sonnet-5`) |
| `CURSOR_API_KEY`, `SIM_CURSOR_MODEL` | for the Cursor brain (`SIM_CURSOR_MODEL` default `composer-2.5`) |

## Programmatic API

For a custom brain, or to embed the simulator in your own app:

```ts
import { McpSessionManager, createServer, createClaudeBrain } from "mcp-voice-simulator";

const sessionManager = new McpSessionManager({ mcpUrl: "https://your-server.example.com/mcp" });
const brain = createClaudeBrain({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  session: () => sessionManager.ensureSession(),
});

createServer({ sessionManager, brain, port: 8790 });
```

Write your own brain by implementing the `Brain` interface (`turn(utterance)`
→ `{ reply, trace }`, optional `reset()`) — see
`examples/scripted-brain.ts` for a complete keyword-routed example needing
no LLM at all.

The discovery and linking pieces are exported individually too
(`discoverProtectedResource`, `discoverAuthorizationServer`,
`registerDynamicClient`, `linkAccount`, `createPkce`) if you want to build
something other than the bundled server/UI on top of them.

## Conformance checker — "will this be a drop-in replacement?"

The point of building against published specs is that a server which passes
those checks today shouldn't need to change when real `alexa-ai` access
arrives. `mcp-voice-simulator-conformance` checks your MCP server against
Alexa+ MCP Toolkit's *documented* account-linking requirements — not by
guessing, but against claims traced to specific pages, each with an honest
confidence rating (see [docs/ALEXA_AI_CONTRACT.md](./docs/ALEXA_AI_CONTRACT.md)
for the full sourcing and what this deliberately does not attempt to fake):

```bash
npx mcp-voice-simulator-conformance https://your-server.example.com/mcp
```

Checks the spec transport, that unauthenticated requests get a 401, that
your authorization server's metadata advertises PKCE S256 (Amazon states
`alexa-ai deploy` is blocked without it — the highest-confidence check here),
and that `authorization_code` is an available grant type. One additional
check (whether the 401 omits a `WWW-Authenticate` header) is marked
`advisory` rather than `documented`, because that specific detail couldn't be
independently confirmed — see the contract doc before treating it as a hard
requirement.

```ts
import { checkAlexaPlusConformance } from "mcp-voice-simulator";

const report = await checkAlexaPlusConformance("https://your-server.example.com/mcp");
if (!report.passed) console.error(report.results.filter((r) => !r.pass));
```

## Architecture

```text
public/index.html   Browser UI: device-styled screen, mic (SpeechRecognition),
                     spoken replies (speechSynthesis), tool-call trace log
src/server.ts        HTTP API: /api/status, /api/turn, /api/reset
src/session.ts        Owns account linking + the MCP connection
src/link.ts            OAuth 2.1 + PKCE loopback flow (RFC 8252-style)
src/discovery.ts        RFC 9728 / RFC 8414 / RFC 7591 discovery
src/mcp.ts             Thin @modelcontextprotocol/client wrapper
src/brains/            Pluggable utterance -> tool-call(s) -> reply strategies
src/conformance.ts     Checks a server against Alexa+'s *documented* requirements
examples/              A no-API-key scripted brain, as a pattern to copy
docs/ALEXA_AI_CONTRACT.md   Exact source + confidence behind every conformance check
```

## Origin

Extracted from a hackathon MCP server's own simulator, built for an Alexa+
track entry in an Amazon developer hackathon, after discovering the Alexa AI
CLI / MCP Toolkit isn't accessible to hackathon participants — a wall every
team in that track hits. This is the generalized, server-agnostic version.

## Contributing

Issues and PRs welcome — especially real-world reports of MCP servers whose
OAuth discovery doesn't fit the two well-known URL shapes `discovery.ts`
tries (see its doc comment), and additional brains for other model providers.

## License

[MIT](./LICENSE)
