#!/usr/bin/env node
import { checkAlexaPlusConformance } from "./conformance.js";

const mcpUrl = process.argv[2] ?? process.env.MCP_URL?.trim();
if (!mcpUrl) {
  console.error("Usage: mcp-voice-simulator-conformance <mcp-url>  (or set MCP_URL)");
  process.exit(1);
}

const report = await checkAlexaPlusConformance(mcpUrl);

console.log(`Alexa+ MCP Toolkit conformance — published-requirements check\n${report.mcpUrl}\n`);
for (const result of report.results) {
  const icon = result.pass ? "✓" : result.confidence === "advisory" ? "?" : "✗";
  console.log(`${icon} [${result.confidence}] ${result.id}`);
  console.log(`  ${result.description}`);
  console.log(`  ${result.detail}`);
  console.log(`  source: ${result.source}\n`);
}

console.log(
  report.passed
    ? "All documented checks passed. See docs/ALEXA_AI_CONTRACT.md for what this does and doesn't confirm."
    : "One or more documented checks failed — see above. Advisory checks (marked '?') are informational only.",
);
process.exit(report.passed ? 0 : 1);
