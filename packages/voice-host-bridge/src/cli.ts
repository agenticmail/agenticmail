#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVoiceHostBridge, type VoiceHostBridgeOptions } from './index.js';

interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

function help(): string {
  return `agenticmail-voice-host-bridge

Runs a localhost OpenAI-Realtime-compatible bridge for AgenticMail's host_bridge runtime.

Usage:
  agenticmail-voice-host-bridge [options]

Options:
  --host <host>              Listen host (default: 127.0.0.1)
  --port <port>              Listen port (default: 3999)
  --path <path>              WebSocket path (default: /realtime)
  --provider <id>            Upstream provider: openai, xai/grok, custom
  --upstream-url <url>       Upstream realtime WebSocket URL
  --upstream-key <key>       Upstream provider API key
  --upstream-auth <mode>     Use "none" to allow a custom no-auth upstream
  --model <model>            Realtime model (default: gpt-realtime)
  --token <token>            Optional token AgenticMail must present to this bridge
  --help                     Show this help

AgenticMail env:
  AGENTICMAIL_VOICE_RUNTIME=host_bridge
  AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime
  AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN=<token>  # only if --token is set
`;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${label} must be an integer port between 0 and 65535`);
  }
  return parsed;
}

async function waitForShutdown(close: () => Promise<void>, io: CliIO): Promise<void> {
  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try {
        await close();
      } catch (err) {
        io.error(`voice host bridge shutdown failed: ${(err as Error).message}`);
      }
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function runVoiceHostBridgeCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIO = console,
): Promise<number> {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.log(help());
    return 0;
  }

  try {
    const provider = readFlag(argv, '--provider');
    const upstreamAuth = readFlag(argv, '--upstream-auth') || env.AGENTICMAIL_VOICE_HOST_BRIDGE_UPSTREAM_AUTH;
    const opts: VoiceHostBridgeOptions = {
      host: readFlag(argv, '--host'),
      port: parseNumber(readFlag(argv, '--port'), '--port'),
      path: readFlag(argv, '--path'),
      provider,
      upstreamUrl: readFlag(argv, '--upstream-url'),
      upstreamApiKey: readFlag(argv, '--upstream-key'),
      upstreamApiKeyRequired: upstreamAuth === 'none' ? false : undefined,
      model: readFlag(argv, '--model'),
      bridgeToken: readFlag(argv, '--token'),
    };
    const handle = await startVoiceHostBridge(opts);
    io.log('');
    io.log('AgenticMail host_bridge config:');
    io.log('  AGENTICMAIL_VOICE_RUNTIME=host_bridge');
    io.log(`  AGENTICMAIL_VOICE_HOST_BRIDGE_URL=${handle.url}`);
    if (handle.options.bridgeToken) {
      io.log('  AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN=<same token>');
    }
    io.log(`  health: ${handle.healthUrl}`);
    await waitForShutdown(handle.close, io);
    return 0;
  } catch (err) {
    io.error(`voice host bridge failed: ${(err as Error).message}`);
    return 1;
  }
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

const isMain = isMainEntrypoint();
if (isMain) {
  void runVoiceHostBridgeCli().then((code) => {
    process.exitCode = code;
  });
}
