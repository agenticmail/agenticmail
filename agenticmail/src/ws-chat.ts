/**
 * WebSocket chat client for OpenClaw Gateway.
 * Uses device auth (Ed25519 keypair) for full scope access.
 */

import { createPrivateKey, createPublicKey, sign, createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PROTOCOL_VERSION = 3;

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface WsChatOptions {
  gatewayUrl: string;
  token: string;
  sessionKey?: string;
}

interface ChatResponse {
  text: string;
  done: boolean;
  error?: string;
}

// --- Device Identity ---

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI is 44 bytes: 12 byte header + 32 byte key
  return Buffer.from(spki).subarray(-32);
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return createHash('sha256').update(raw).digest('hex');
}

function loadOrCreateIdentity(): DeviceIdentity {
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  const filePath = join(homedir, '.agenticmail', 'device-identity.json');

  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed?.version === 1 && parsed.privateKeyPem && parsed.publicKeyPem) {
        return {
          deviceId: fingerprintPublicKey(parsed.publicKeyPem),
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch { /* regenerate */ }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const deviceId = fingerprintPublicKey(publicKeyPem);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() }, null, 2) + '\n', { mode: 0o600 });

  return { deviceId, publicKeyPem, privateKeyPem };
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(sign(null, Buffer.from(payload, 'utf8'), key));
}

// --- WebSocket Client ---

export class WsChat {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private connected = false;
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private chatResolve: ((resp: ChatResponse) => void) | null = null;
  private chatBuffer = '';
  private onDelta: ((text: string) => void) | null = null;
  private opts: WsChatOptions;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private identity: DeviceIdentity;
  private connectNonce: string | undefined;

  constructor(opts: WsChatOptions) {
    this.opts = opts;
    this.identity = loadOrCreateIdentity();
  }

  private sendConnect() {
    const id = String(++this.reqId);
    this.pendingRequests.set(id, {
      resolve: () => {
        this.connected = true;
        this.connectResolve?.();
      },
      reject: (err) => {
        this.connectReject?.(err);
      },
    });

    const scopes = ['operator.admin', 'operator.write', 'operator.read'];
    const signedAtMs = Date.now();
    const nonce = this.connectNonce;

    // Build device auth payload (v2 if nonce present)
    const version = nonce ? 'v2' : 'v1';
    const payloadParts = [
      version,
      this.identity.deviceId,
      'gateway-client',
      'backend',
      'operator',
      scopes.join(','),
      String(signedAtMs),
      this.opts.token,
    ];
    if (version === 'v2') payloadParts.push(nonce ?? '');
    const payloadStr = payloadParts.join('|');
    const signature = signPayload(this.identity.privateKeyPem, payloadStr);

    this.ws!.send(JSON.stringify({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: 'gateway-client',
          displayName: 'AgenticMail Chat',
          version: '1.0.0',
          platform: process.platform,
          mode: 'backend',
        },
        caps: [],
        auth: { token: this.opts.token },
        role: 'operator',
        scopes,
        device: {
          id: this.identity.deviceId,
          publicKey: base64UrlEncode(derivePublicKeyRaw(this.identity.publicKeyPem)),
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      },
    }));
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const url = this.opts.gatewayUrl.replace(/^http/, 'ws');
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.ws?.close();
      }, 15_000);

      this.ws.onopen = () => {
        // Don't send connect yet — wait for challenge to get nonce
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());

          // Handle connect challenge — use nonce for device auth v2
          if (data.type === 'event' && data.event === 'connect.challenge') {
            this.connectNonce = data.payload?.nonce;
            this.sendConnect();
            return;
          }

          this.handleMessage(data);
        } catch { /* ignore */ }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Connection failed'));
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        this.connected = false;
        if (this.chatResolve) {
          this.chatResolve({ text: this.chatBuffer, done: true, error: 'connection closed' });
          this.chatResolve = null;
        }
      };

      const origResolve = this.connectResolve;
      this.connectResolve = () => { clearTimeout(timeout); origResolve?.(); };
    });
  }

  private handleMessage(data: any) {
    if (data.type === 'res' && typeof data.id === 'string') {
      const pending = this.pendingRequests.get(data.id);
      if (pending) {
        this.pendingRequests.delete(data.id);
        if (data.ok === false) {
          pending.reject(new Error(data.error?.message || 'request failed'));
        } else {
          pending.resolve(data.result ?? data);
        }
      }
      return;
    }

    if (data.type === 'event' || data.type === 'evt') {
      const event = data.event;
      const payload = data.payload;

      if (event === 'chat') {
        const text = payload?.message?.content?.[0]?.text ?? '';
        const state = payload?.state;

        if (state === 'delta' && text) {
          this.chatBuffer = text;
          this.onDelta?.(text);
        }

        if (state === 'final') {
          if (text) this.chatBuffer = text;
          if (this.chatResolve) {
            this.chatResolve({ text: this.chatBuffer, done: true });
            this.chatResolve = null;
          }
        }
      }
    }
  }

  async send(message: string, opts?: {
    sessionKey?: string;
    onDelta?: (text: string) => void;
    timeoutMs?: number;
  }): Promise<ChatResponse> {
    if (!this.connected || !this.ws) throw new Error('Not connected');

    this.chatBuffer = '';
    this.onDelta = opts?.onDelta ?? null;
    const id = String(++this.reqId);
    const timeoutMs = opts?.timeoutMs ?? 120_000;

    return new Promise((resolve, reject) => {
      this.chatResolve = resolve;

      const timer = setTimeout(() => {
        if (this.chatResolve) {
          this.chatResolve({ text: this.chatBuffer, done: true, error: 'timeout' });
          this.chatResolve = null;
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: () => { /* ack — wait for chat events */ },
        reject: (err) => {
          clearTimeout(timer);
          this.chatResolve = null;
          reject(err);
        },
      });

      const idempotencyKey = randomUUID();
      this.ws!.send(JSON.stringify({
        type: 'req',
        id,
        method: 'chat.send',
        params: {
          message,
          sessionKey: opts?.sessionKey ?? this.opts.sessionKey ?? 'agenticmail-chat',
          idempotencyKey,
        },
      }));
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  get isConnected() { return this.connected; }
}
