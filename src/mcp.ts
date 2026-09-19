/**
 * Thin wrapper around @modelcontextprotocol/client's Streamable HTTP
 * transport — deliberately generic, no assumptions about which tools a
 * server exposes.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
}

export interface McpSession {
  client: Client;
  tools: McpTool[];
}

export async function connectMcp(mcpUrl: string, accessToken: string): Promise<McpSession> {
  const client = new Client({ name: "mcp-voice-simulator", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const { tools } = await client.listTools();
  return { client, tools };
}

export interface ToolCallTrace {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  ms: number;
}

export async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallTrace> {
  const started = Date.now();
  const result = await session.client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
  return { tool: name, args, text, isError: Boolean(result.isError), ms: Date.now() - started };
}
