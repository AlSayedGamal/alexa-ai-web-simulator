# The Alexa+ MCP Toolkit contract this library targets

Goal: when Amazon eventually grants MCP Toolkit / Alexa AI CLI access to this
project, swapping this simulator out for real `alexa-ai` should require no
changes to the target MCP server — because the server already meets the same
bar `alexa-ai deploy` enforces. `src/conformance.ts` encodes that bar as
automated checks; this document is the paper trail behind each one: exact
claim, exact source, and — critically — how confident we actually are in it.

## How this was sourced

The environment this library was built in has `developer.amazon.com` blocked
at the network layer (an unrelated, environment-specific egress restriction —
not an access-control decision by Amazon). Every claim below therefore comes
from search-engine result summaries **about** those pages, not a fetch of the
pages' own HTML — the search tool paraphrases what it finds, it does not
return verified exact quotes. Confidence levels reflect that:

- **`documented`** — the claim showed up consistently, in specific and
  operationally-testable terms (e.g. "deployment is blocked without X"),
  across independent searches. Encoded as a hard pass/fail check.
- **`advisory`** — seen once, in less specific terms, or plausible but not
  independently corroborated. Encoded as an informational check that never
  fails the overall report.

**If you have real access to these pages (or to `alexa-ai` itself), please
open an issue or PR correcting anything below** — that's exactly the kind of
contribution this project exists to take.

Source pages referenced (all under `developer.amazon.com/docs/alexaplus/`):

- `add-ons/mcp-toolkit-overview.html`
- `add-ons/mcp-toolkit-account-linking.html`
- `add-ons/mcp-toolkit-quickstart.html`
- `account-linking/requirements-account-linking.html`

## Requirements, by confidence

### `documented`

| Check id | Claim | Source |
| --- | --- | --- |
| `streamable-http` | MCP spec 2025-11-25 deprecated standalone HTTP+SSE; the add-on's server must speak Streamable HTTP. | mcp-toolkit-overview.html |
| `unauthenticated-401` | An unauthenticated request to the server returns 401. | mcp-toolkit-overview.html |
| `pkce-s256-supported` | The authorization server's metadata must advertise `S256` in `code_challenge_methods_supported`. Amazon states `alexa-ai deploy` is **blocked** if it's missing — this is the most-cited specific, operational claim found, hence the highest-confidence check in this library. | mcp-toolkit-account-linking.html, requirements-account-linking.html |
| `authorization-code-grant` | "Alexa+ add-ons support only the Authorization Code Grant" — the server must support `authorization_code` (other grants, e.g. `refresh_token`, may coexist; the check only requires `authorization_code` be present when the field is given at all). | mcp-toolkit-overview.html |
| (not automated — needs a real login) | The authorization server must issue a refresh token, recommended TTL ≥ 180 days or non-expiring, so Alexa can silently refresh without re-linking. | requirements-account-linking.html |
| (not automated — needs `alexa-ai` itself) | Account linking discovers the endpoints via the server's **well-known metadata document** (RFC 8414-shaped), not a hardcoded flow — this is *why* `discoverAuthorizationServer`/`discoverProtectedResource` exist in this library rather than a scripted login. | mcp-toolkit-account-linking.html |
| (not automated) | Client registration is **not** dynamic (no RFC 7591 in the documented flow): the developer creates an application in their own auth service and provides a client id (and optional secret) to Alexa via `alexa-ai configure-account-linking`, which then displays Alexa's own (multiple, region-specific) redirect URIs to register. | requirements-account-linking.html |

### `advisory`

| Check id | Claim | Why advisory |
| --- | --- | --- |
| `no-www-authenticate-on-401` | The 401 response should **not** include a `WWW-Authenticate` header. | Seen in only one summarized result, phrased less specifically than the other claims, and it runs counter to the more common modern MCP-auth convention (returning `WWW-Authenticate: Bearer resource_metadata="..."`) that most MCP OAuth libraries — including `@cloudflare/workers-oauth-provider`, which this library's own origin server uses — implement by default. Do not remove a working `WWW-Authenticate` header on the strength of this check alone. |

## What this deliberately does not attempt

- **Simulating `alexa-ai`'s own request shapes** (exact headers, exact retry
  behavior, exact error-handling) — none of that was discoverable from public
  docs in the form needed to implement it honestly. `link.ts`'s OAuth loopback
  flow is *this library's own* client behavior (closer to how a CLI like
  `gcloud auth login` behaves), not a reproduction of Alexa+'s.
- **The dynamic-client-registration path** (`registerDynamicClient` in
  `discovery.ts`) — real Alexa+ apparently doesn't use RFC 7591 at all (see
  the client-registration row above). It stays in this library because it's a
  legitimate, more-automatable path for *other* MCP clients that do support
  it; a server built only for Alexa+ can ignore it and pass a `clientId`
  directly instead.
- **CLI command names** (`alexa-ai configure-account-linking`, `alexa-ai
  deploy`) beyond citing them for context — this library never shells out to
  or imitates the actual CLI.

## Updating this contract

If you get real `alexa-ai` access before this project does: running
`mcp-voice-simulator-conformance <your-mcp-url>` first, then the same
server through real `alexa-ai deploy` + account linking, and diffing what
each one actually required, is the single most valuable contribution this
project could receive.
