import { linkAccount, type LinkOptions } from "./link.js";
import { connectMcp, type McpSession } from "./mcp.js";

export interface McpSessionManagerOptions {
  mcpUrl: string;
  /** Skip the OAuth flow entirely if you already have a token. */
  bearerToken?: string;
  /** Passed through to linkAccount() when bearerToken isn't set. */
  link?: Omit<LinkOptions, "mcpUrl">;
}

/** Owns account linking + the MCP connection, lazily and once, re-linking on
 *  demand after invalidate() (e.g. a dead session from an expired token). */
export class McpSessionManager {
  private session: McpSession | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly options: McpSessionManagerOptions) {}

  get mcpUrl(): string {
    return this.options.mcpUrl;
  }

  async accessToken(): Promise<string> {
    if (this.options.bearerToken) return this.options.bearerToken;
    if (!this.tokenPromise) {
      this.tokenPromise = linkAccount({ mcpUrl: this.options.mcpUrl, ...this.options.link }).then(
        (result) => result.accessToken,
      );
    }
    return this.tokenPromise;
  }

  async ensureSession(): Promise<McpSession> {
    if (this.session) return this.session;
    const token = await this.accessToken();
    this.session = await connectMcp(this.options.mcpUrl, token);
    return this.session;
  }

  /** Call after a request fails with an auth error, so the next call re-links. */
  invalidate(): void {
    this.session = null;
    this.tokenPromise = null;
  }
}
