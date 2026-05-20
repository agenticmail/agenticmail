import 'dotenv/config';
import { networkInterfaces } from 'node:os';
import { createApp, prepareIntegrations } from './app.js';
import { closeCaches } from './routes/mail.js';
import { closeAllWatchers } from './routes/events.js';
import { closeAllSystemEventListeners } from './routes/system-events.js';
import { startScheduledSender } from './routes/features.js';
import { createRealtimeVoiceServer, REALTIME_WS_PATH } from './realtime-ws.js';
import { startCallbackScheduler } from './callback-scheduler.js';

// Pre-resolve dynamically-loaded integration packages (e.g. @agenticmail/claudecode)
// BEFORE the app is constructed, so their Express routes get mounted in the
// correct middleware order. Without this, the routes would land after the
// master-key auth middleware and unauthenticated callers (the AI agents we
// want to support) would get 401 instead of the install endpoint.
await prepareIntegrations();

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Works from both src/ (dev) and dist/ (built)
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch { return '0.5.31'; }
})();

const { app, context } = createApp();
const { port, host } = context.config.api;

let scheduledTimer: ReturnType<typeof setInterval> | null = null;
let stopCallbackScheduler: (() => void) | null = null;

const server = app.listen(port, host, async () => {
  const displayHost = host === '127.0.0.1' || host === '0.0.0.0' ? getLocalIp() : host;
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                 🎀 AgenticMail v' + VERSION.padEnd(29) + '║');
  console.log('  ║              Built by Ope Olatunji                           ║');
  console.log('  ║       github.com/agenticmail/agenticmail                     ║');
  console.log('  ╠═══════════════════════════════════════════════════════════════╣');
  console.log('  ║                                                             ║');
  console.log('  ║  What 🎀 AgenticMail gives your agents:                     ║');
  console.log('  ║                                                             ║');
  console.log('  ║  📧 Real Email        Send, receive, reply, forward with    ║');
  console.log('  ║                       full DKIM/SPF/DMARC authentication    ║');
  console.log('  ║                                                             ║');
  console.log('  ║  🤝 Agent Coordination  Task queues, synchronous RPC,       ║');
  console.log('  ║                         push notifications, structured      ║');
  console.log('  ║                         results — replaces fire-and-forget  ║');
  console.log('  ║                         session spawning                    ║');
  console.log('  ║                                                             ║');
  console.log('  ║  🔒 Security           Outbound PII/credential scanning,   ║');
  console.log('  ║                        inbound spam filtering, human-in-   ║');
  console.log('  ║                        the-loop approval for sensitive      ║');
  console.log('  ║                        content                              ║');
  console.log('  ║                                                             ║');
  console.log('  ║  ⚡ Efficiency         ~60% fewer tokens on multi-agent    ║');
  console.log('  ║                        tasks vs session polling. Persistent ║');
  console.log('  ║                        task state survives crashes.         ║');
  console.log('  ║                        Push-based — no wasted poll cycles.  ║');
  console.log('  ║                                                             ║');
  console.log('  ║  54 tools • MIT license • Contributions welcome             ║');
  console.log('  ║                                                             ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🚀 API: http://${displayHost}:${port}`);
  console.log(`  ❤️  Health: http://${displayHost}:${port}/api/agenticmail/health`);
  console.log(`  📖 About: http://${displayHost}:${port}/api/agenticmail/about`);
  if (context.config.openaiApiKey) {
    console.log(`  📞 Realtime voice: ws://${displayHost}:${port}${REALTIME_WS_PATH}`);
  }

  // Start scheduled email sender
  scheduledTimer = startScheduledSender(context.db, context.accountManager, context.config, context.gatewayManager);

  // v0.9.81 — start the scheduled-callback loop so `schedule_callback`
  // requests from live voice calls actually get dialed when their `at`
  // time arrives. Tick is unref'd so it doesn't keep the process alive
  // by itself; cleanup is wired into shutdown() below.
  stopCallbackScheduler = startCallbackScheduler(context.db, context.config);

  // Resume gateway (relay polling, domain tunnel) from saved config
  try {
    await context.gatewayManager.resume();
    const status = context.gatewayManager.getStatus();
    if (status.mode !== 'none') {
      console.log(`   Gateway: ${status.mode} mode resumed${status.relay?.polling ? ' (polling)' : ''}`);
    }
  } catch (err) {
    console.error('   Gateway resume failed:', err);
  }
});

// Realtime voice WebSocket — 46elks streams live call audio here and it
// is bridged to an OpenAI Realtime session (see realtime-ws.ts). Mounted
// on the HTTP server's `upgrade` event so it shares the API port; any
// upgrade for a non-matching path is destroyed rather than left hanging.
const realtimeVoice = createRealtimeVoiceServer(context.db, context.config);
server.on('upgrade', (req, socket, head) => {
  try {
    if (!realtimeVoice.tryHandleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  } catch (err) {
    console.error('[AgenticMail] WebSocket upgrade failed:', (err as Error)?.message ?? err);
    try { socket.destroy(); } catch { /* ignore */ }
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`);
  } else {
    console.error('Failed to start server:', err);
  }
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');
  if (scheduledTimer) { try { clearInterval(scheduledTimer); } catch { /* ignore */ } }
  if (stopCallbackScheduler) { try { stopCallbackScheduler(); } catch { /* ignore */ } }
  try { realtimeVoice.close(); } catch { /* ignore */ }
  try { await closeAllWatchers(); } catch { /* ignore */ }
  try { closeAllSystemEventListeners(); } catch { /* ignore */ }
  try { await closeCaches(); } catch { /* ignore */ }
  try { await context.gatewayManager.shutdown(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));

// Prevent crashes from unhandled errors — log and continue
process.on('uncaughtException', (err) => {
  console.error('[AgenticMail] Uncaught exception (server will continue):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[AgenticMail] Unhandled promise rejection (server will continue):', msg);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
});
