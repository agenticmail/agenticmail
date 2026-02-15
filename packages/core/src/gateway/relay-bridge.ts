import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTransport } from 'nodemailer';

export interface RelayBridgeOptions {
  /** Port for the HTTP bridge server */
  port: number;
  /** Shared secret for authenticating requests */
  secret: string;
  /** Local Stalwart SMTP host (default: 127.0.0.1) */
  smtpHost?: string;
  /** Local Stalwart SMTP submission port (default: 587) */
  smtpPort?: number;
  /** Stalwart auth credentials for the sending agent */
  smtpUser: string;
  smtpPass: string;
}

/**
 * RelayBridge — A local HTTP-to-SMTP bridge that submits email to Stalwart.
 *
 * Stalwart then handles DKIM signing, MX resolution, and direct delivery
 * to the recipient's mail server on port 25. FROM is preserved exactly.
 *
 * This bridge is exposed via Cloudflare Tunnel so Cloudflare Workers
 * (which can't connect to port 25) can trigger outbound email through it.
 *
 * For production, deploy on a VPS with proper PTR/FCrDNS for reliable
 * delivery to all providers (Gmail, Outlook, etc.).
 */
export class RelayBridge {
  private server: ReturnType<typeof createServer> | null = null;
  private options: RelayBridgeOptions;

  constructor(options: RelayBridgeOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.options.port, '127.0.0.1', () => {
        console.log(`[RelayBridge] Listening on 127.0.0.1:${this.options.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const secret = req.headers['x-relay-secret'] as string;
    if (secret !== this.options.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const payload = JSON.parse(body);
      const result = await this.submitToStalwart(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[RelayBridge] Delivery failed:', (err as Error).message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async submitToStalwart(payload: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ ok: boolean; messageId: string; response: string }> {
    const { from, to, subject, text, html, replyTo, inReplyTo, references } = payload;
    const recipients = Array.isArray(to) ? to : [to];

    console.log(`[RelayBridge] Submitting to Stalwart: ${from} → ${recipients.join(', ')}`);

    // Submit to local Stalwart — it handles DKIM signing and MX delivery
    const transport = createTransport({
      host: this.options.smtpHost ?? '127.0.0.1',
      port: this.options.smtpPort ?? 587,
      secure: false,
      auth: {
        user: this.options.smtpUser,
        pass: this.options.smtpPass,
      },
      tls: { rejectUnauthorized: false },
    });

    try {
      const info = await transport.sendMail({
        from,
        to: recipients.join(', '),
        subject,
        text: text || undefined,
        html: html || undefined,
        replyTo: replyTo || undefined,
        inReplyTo: inReplyTo || undefined,
        references: references || undefined,
        headers: {
          'X-Mailer': 'AgenticMail/1.0',
        },
      });

      console.log(`[RelayBridge] Queued: ${info.messageId} → ${info.response}`);
      return {
        ok: true,
        messageId: info.messageId,
        response: info.response,
      };
    } finally {
      transport.close();
    }
  }
}

export function startRelayBridge(options: RelayBridgeOptions): RelayBridge {
  const bridge = new RelayBridge(options);
  bridge.start().catch((err) => {
    console.error('[RelayBridge] Failed to start:', err);
  });
  return bridge;
}
