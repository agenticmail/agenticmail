#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolDefinitions, handleToolCall } from './tools.js';
import { resourceDefinitions, handleResourceRead } from './resources.js';

const server = new McpServer({
  name: '🎀 AgenticMail',
  version: '0.2.26',
  description: '🎀 AgenticMail — Email infrastructure for AI agents. By Ope Olatunji (https://github.com/agenticmail/agenticmail)',
} as any);

// Register tools
for (const tool of toolDefinitions) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema as any,
    async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
      try {
        const result = await handleToolCall(tool.name, args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

// Register resources
for (const resource of resourceDefinitions) {
  server.resource(
    resource.name,
    resource.uri,
    { description: resource.description, mimeType: resource.mimeType },
    async () => {
      try {
        const content = await handleResourceRead(resource.uri);
        return {
          contents: [{ uri: resource.uri, text: content, mimeType: resource.mimeType }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [{ uri: resource.uri, text: `Error: ${message}`, mimeType: 'text/plain' }],
        };
      }
    },
  );
}

// Start server with stdio transport
const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error('[agenticmail-mcp] Failed to start:', err);
  process.exit(1);
}

// Graceful shutdown
async function shutdown() {
  try { await server.close(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
