import { serve } from "../../mcp/server.ts";

/**
 * `groundhog serve` — MCP server on stdio.
 *
 * stdout belongs to the protocol, so nothing else may be written to it. Any
 * status output goes to stderr, which MCP clients surface as server logs.
 */
export async function serveCommand(): Promise<void> {
  process.stderr.write("groundhog: MCP server ready on stdio\n");
  await serve();
}
