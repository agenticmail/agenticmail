#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toolDefinitions, handleToolCall } from './tools.js';
import { resourceDefinitions, handleResourceRead } from './resources.js';
import { setTelemetryVersion } from '@agenticmail/core';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

setTelemetryVersion('0.5.50');

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: '🎀 AgenticMail',
    version: '0.2.27',
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

  return server;
}

// Parse CLI args
const args = process.argv.slice(2);
const httpFlag = args.includes('--http');
const portArg = args.find(a => a.startsWith('--port='));
const httpPort = portArg ? parseInt(portArg.split('=')[1], 10) : (parseInt(process.env.MCP_PORT || '', 10) || 8014);

if (httpFlag || process.env.MCP_HTTP === '1') {
  // ─── HTTP/Streamable HTTP Transport ───────────────────────────────
  // Supports both SSE streaming and direct JSON responses per MCP spec.
  // Usage: agenticmail-mcp --http [--port=8014]
  const server = createMcpServer();

  // Map of session ID -> transport for stateful connections
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${httpPort}`);
    const path = url.pathname;

    // Health check
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', sessions: transports.size }));
      return;
    }

    // Only handle /mcp endpoint
    if (path !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is POST /mcp' }));
      return;
    }

    // Handle DELETE for session termination
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      }
      return;
    }

    // Handle GET for SSE stream (session resumption)
    if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID for SSE stream. Send a POST /mcp with initialize first.' }));
      }
      return;
    }

    // Handle POST for JSON-RPC messages
    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create transport and connect
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) transports.delete(sid);
      };

      // Connect a new server instance per session
      const sessionServer = createMcpServer();
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // Other methods
    res.writeHead(405, { 'Allow': 'GET, POST, DELETE', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST /mcp for JSON-RPC, GET /mcp for SSE stream.' }));
  });

  httpServer.listen(httpPort, () => {
    console.log(`🎀 AgenticMail MCP Server (Streamable HTTP)`);
    console.log(`   Endpoint: http://localhost:${httpPort}/mcp`);
    console.log(`   Health:   http://localhost:${httpPort}/health`);
    console.log(`   Transport: Streamable HTTP (SSE + JSON responses)`);
  });

  // Graceful shutdown
  async function shutdown() {
    for (const transport of transports.values()) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

} else {
  // ─── Stdio Transport (default) ────────────────────────────────────
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error('[agenticmail-mcp] Failed to start:', err);
    process.exit(1);
  }

  async function shutdown() {
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}
