#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMeetMediaSidecar, type MeetMediaSidecarOptions } from './meet-sidecar.js';

interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

function help(): string {
  return `agenticmail-meet-sidecar

Runs a localhost Google Meet media sidecar endpoint for AgenticMail.

Usage:
  agenticmail-meet-sidecar [options]

Options:
  --host <host>                    Listen host (default: 127.0.0.1)
  --port <port>                    Listen port (default: 4999)
  --join-path <path>               HTTP join path (default: /join)
  --events-path <path>             Local driver event path (default: /events)
  --health-path <path>             Health path (default: /health)
  --sessions-path <path>           Session status path (default: /sessions)
  --token <token>                  Optional sidecar token required via x-agenticmail-meet-sidecar-token
  --driver-command <cmd>           Optional executable that receives the join JSON on stdin
  --driver-arg <arg>               Repeatable argument for --driver-command
  --driver-timeout-ms <ms>         Driver timeout (default: 30000)
  --help                           Show this help

AgenticMail setup:
  meet_setup({
    "accessToken": "<google-oauth-token>",
    "mediaApiDeveloperPreview": true,
    "mediaSidecarUrl": "http://127.0.0.1:4999",
    "mediaSidecarToken": "<token-if-set>",
    "consentPolicyAccepted": true
  })
`;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function readRepeatedFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    i++;
  }
  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
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
        io.error(`Meet sidecar shutdown failed: ${(err as Error).message}`);
      }
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function runMeetMediaSidecarCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIO = console,
): Promise<number> {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.log(help());
    return 0;
  }

  try {
    const opts: MeetMediaSidecarOptions = {
      host: readFlag(argv, '--host'),
      port: parseNumber(readFlag(argv, '--port'), '--port'),
      joinPath: readFlag(argv, '--join-path'),
      eventsPath: readFlag(argv, '--events-path'),
      healthPath: readFlag(argv, '--health-path'),
      sessionsPath: readFlag(argv, '--sessions-path'),
      sidecarToken: readFlag(argv, '--token') || env.AGENTICMAIL_MEET_SIDECAR_TOKEN,
      driverCommand: readFlag(argv, '--driver-command'),
      driverArgs: readRepeatedFlag(argv, '--driver-arg'),
      driverTimeoutMs: parsePositiveNumber(readFlag(argv, '--driver-timeout-ms'), '--driver-timeout-ms'),
    };
    const handle = await startMeetMediaSidecar(opts);
    io.log('');
    io.log('AgenticMail Google Meet setup:');
    io.log(`  mediaSidecarUrl=${handle.url}`);
    if (handle.options.sidecarToken) {
      io.log('  mediaSidecarToken=<same token>');
    }
    io.log(`  health: ${handle.healthUrl}`);
    io.log(`  events: ${handle.eventsUrl}`);
    io.log(`  sessions: ${handle.sessionsUrl}`);
    await waitForShutdown(handle.close, io);
    return 0;
  } catch (err) {
    io.error(`Meet sidecar failed: ${(err as Error).message}`);
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

if (isMainEntrypoint()) {
  void runMeetMediaSidecarCli().then((code) => {
    process.exitCode = code;
  });
}
