import { recordInboundAgentMessage, type ToolContext } from './tools.js';

/** Resolved mail account from OpenClaw channel config */
export interface ResolvedMailAccount {
  accountId: string;
  apiUrl: string;
  apiKey: string;
  watchMailboxes: string[];
  pollIntervalMs: number;
  enabled: boolean;
}

/** Resolve a mail account from OpenClaw config */
function resolveAccount(ctx: ToolContext, cfg: any, accountId?: string | null): ResolvedMailAccount {
  const id = accountId || 'default';
  const mailCfg = cfg?.channels?.mail?.accounts?.[id] ?? {};
  return {
    accountId: id,
    apiUrl: mailCfg.apiUrl ?? ctx.config.apiUrl,
    apiKey: mailCfg.apiKey ?? ctx.config.apiKey,
    watchMailboxes: mailCfg.watchMailboxes ?? ['INBOX'],
    pollIntervalMs: mailCfg.pollIntervalMs ?? 30_000,
    enabled: mailCfg.enabled !== false,
  };
}

/** Fetch from AgenticMail API with auth */
export async function mailApi(
  account: ResolvedMailAccount,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.apiKey}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${account.apiUrl}/api/agenticmail${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AgenticMail ${res.status}: ${text}`);
  }

  const ct = res.headers.get('content-type');
  if (ct?.includes('application/json')) return res.json();
  return null;
}

/** Sleep helper that respects abort signals */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

// ─── SSE Client ───────────────────────────────────────────────────────

/**
 * Connect to the AgenticMail SSE events endpoint and stream events.
 * Returns when the connection closes or errors. Caller handles reconnection.
 */
async function streamSSE(
  account: ResolvedMailAccount,
  onEvent: (event: any) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${account.apiUrl}/api/agenticmail/events`, {
    headers: { 'Authorization': `Bearer ${account.apiKey}`, 'Accept': 'text/event-stream' },
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SSE connect failed ${res.status}: ${text}`);
  }

  if (!res.body) throw new Error('SSE response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames: lines starting with "data: " terminated by "\n\n"
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              onEvent(parsed);
            } catch { /* skip malformed JSON */ }
          }
          // Skip comment lines (": ping") and other SSE fields
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

// ─── SSE Reconnection Constants ───────────────────────────────────────

const SSE_INITIAL_DELAY_MS = 2_000;
const SSE_MAX_DELAY_MS = 30_000;
const SSE_BACKOFF_FACTOR = 2;

/**
 * Create the AgenticMail ChannelPlugin for OpenClaw.
 *
 * Registers email as a communication channel so that:
 * - Inbound emails trigger agent conversations via the gateway monitor
 * - Agent responses are sent back as email replies via the outbound adapter
 */
export function mailChannelPlugin(ctx: ToolContext): any {
  const channelId = 'mail';

  return {
    id: channelId,

    meta: {
      id: channelId,
      label: 'Email',
      selectionLabel: 'Email (AgenticMail)',
      docsPath: '/channels/mail',
      blurb: 'Send and receive email via AgenticMail',
    },

    capabilities: {
      chatTypes: ['direct'],
      media: true,
      reply: true,
      threads: true,
    },

    config: {
      listAccountIds(cfg: any): string[] {
        const mailCfg = cfg?.channels?.mail?.accounts;
        if (!mailCfg || typeof mailCfg !== 'object') return [];
        return Object.keys(mailCfg);
      },

      resolveAccount(cfg: any, accountId?: string | null): ResolvedMailAccount {
        return resolveAccount(ctx, cfg, accountId);
      },

      defaultAccountId(): string {
        return 'default';
      },

      isEnabled(account: ResolvedMailAccount): boolean {
        return account.enabled;
      },

      isConfigured(account: ResolvedMailAccount): boolean {
        return Boolean(account.apiKey);
      },

      describeAccount(account: ResolvedMailAccount): any {
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          configured: Boolean(account.apiKey),
        };
      },
    },

    outbound: {
      deliveryMode: 'direct' as const,

      async sendText(outCtx: any): Promise<any> {
        const { cfg, to, text, replyToId, threadId, accountId } = outCtx;
        const account = resolveAccount(ctx, cfg, accountId);

        const sendBody: Record<string, unknown> = {
          to,
          subject: threadId ? `Re: ${threadId}` : 'Message from your AI agent',
          text,
        };

        if (replyToId) {
          sendBody.inReplyTo = replyToId;
          sendBody.references = [replyToId];
        }

        const result = await mailApi(account, 'POST', '/mail/send', sendBody);
        return { ok: true, messageId: result?.messageId };
      },
    },

    messaging: {
      normalizeTarget(target: string): string {
        return target.trim().toLowerCase();
      },

      formatTarget(target: string): string {
        return target;
      },

      isValidTarget(target: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target);
      },
    },

    threading: {
      extractThreadId(msg: any): string | undefined {
        const subject = msg?.subject ?? msg?.Subject ?? '';
        return subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim() || undefined;
      },

      extractSessionKey(msg: any): string | undefined {
        const messageId = msg?.messageId ?? msg?.MessageId;
        const references = msg?.references ?? msg?.References;
        if (Array.isArray(references) && references.length > 0) {
          return references[0];
        }
        return messageId;
      },
    },

    gateway: {
      /**
       * Start monitoring the agent's inbox for new emails.
       *
       * Uses SSE push notifications (IMAP IDLE) for instant delivery.
       * Falls back to polling if the SSE connection fails, and reconnects
       * automatically with exponential backoff.
       */
      async startAccount(gatewayCtx: any): Promise<void> {
        const { accountId, cfg, runtime, abortSignal, log } = gatewayCtx;
        const account = resolveAccount(ctx, cfg, accountId);

        if (!account.apiKey) {
          log?.warn?.('[agenticmail] No API key — email monitor disabled');
          return;
        }

        gatewayCtx.setStatus?.({
          accountId,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });

        // Resolve our own name/address for rate limiter
        let myName = '';
        try {
          const me = await mailApi(account, 'GET', '/accounts/me');
          myName = me?.name ?? '';
        } catch { /* ignore */ }

        // Set of UIDs we've already dispatched (prevents re-processing)
        const processedUids = new Set<number>();

        // Dispatch function from OpenClaw runtime
        const dispatch = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
        if (!dispatch) {
          log?.error?.('[agenticmail] runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher not available — email notifications will not work');
          return;
        }

        // Process any unseen emails that arrived before we connected
        try {
          await pollAndDispatch(account, cfg, dispatch, log, processedUids, myName);
        } catch (err) {
          log?.warn?.(`[agenticmail] Initial poll error: ${(err as Error).message}`);
        }

        // Main loop: SSE with polling fallback
        let sseDelay = SSE_INITIAL_DELAY_MS;
        let useSSE = true;

        try {
          while (!abortSignal?.aborted) {
            if (useSSE) {
              try {
                log?.info?.('[agenticmail] Email monitor connected (SSE push notifications)');
                sseDelay = SSE_INITIAL_DELAY_MS; // reset backoff on connect attempt

                await streamSSE(account, async (event: any) => {
                  if (event.type !== 'new' || !event.uid) return;
                  if (processedUids.has(event.uid)) return;
                  processedUids.add(event.uid);

                  try {
                    // SSE provides parsed message, but fetch via API for consistent format
                    // (API response includes envelope data, messageId, references)
                    const email = await mailApi(account, 'GET', `/mail/messages/${event.uid}`);
                    if (!email) return;

                    await dispatchEmail(account, cfg, dispatch, log, email, event.uid, myName);
                  } catch (err) {
                    log?.warn?.(`[agenticmail] Failed to process SSE email UID ${event.uid}: ${(err as Error).message}`);
                  }
                }, abortSignal);

                // streamSSE returned normally (connection closed by server)
                log?.warn?.('[agenticmail] SSE connection closed by server, reconnecting...');
              } catch (err) {
                if (abortSignal?.aborted) break;
                const msg = (err as Error).message ?? '';
                log?.warn?.(`[agenticmail] SSE error: ${msg}`);

                // If SSE fails, fall back to polling temporarily
                useSSE = false;
                log?.info?.(`[agenticmail] Falling back to polling (${account.pollIntervalMs / 1000}s), will retry SSE in ${sseDelay / 1000}s`);
                gatewayCtx.setStatus?.({
                  accountId,
                  running: true,
                  lastError: `SSE failed: ${msg}`,
                  lastErrorAt: Date.now(),
                });

                // Schedule SSE reconnect after backoff
                const reconnectDelay = sseDelay;
                sseDelay = Math.min(sseDelay * SSE_BACKOFF_FACTOR, SSE_MAX_DELAY_MS);

                // Run polling while waiting for SSE reconnect
                const reconnectAt = Date.now() + reconnectDelay;
                while (!abortSignal?.aborted && Date.now() < reconnectAt) {
                  try {
                    await pollAndDispatch(account, cfg, dispatch, log, processedUids, myName);
                  } catch (pollErr) {
                    log?.warn?.(`[agenticmail] Poll error: ${(pollErr as Error).message}`);
                  }
                  const remaining = reconnectAt - Date.now();
                  if (remaining > 0) {
                    await sleep(Math.min(account.pollIntervalMs, remaining), abortSignal);
                  }
                }

                // Try SSE again
                useSSE = true;
              }
            }
          }
        } catch {
          // AbortError — normal shutdown
        }

        gatewayCtx.setStatus?.({
          accountId,
          running: false,
          lastStopAt: Date.now(),
        });
        log?.info?.('[agenticmail] Email monitor stopped');
      },

      async stopAccount(gatewayCtx: any): Promise<void> {
        const { accountId, log } = gatewayCtx;
        log?.info?.(`[agenticmail] Stopping email monitor for account ${accountId}`);
        gatewayCtx.setStatus?.({
          accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      },
    },
  };

  /**
   * Dispatch a single email through OpenClaw's pipeline.
   * Shared by both SSE and polling paths.
   */
  async function dispatchEmail(
    account: ResolvedMailAccount,
    cfg: any,
    dispatch: Function,
    log: any,
    email: any,
    uid: number,
    myName: string,
  ): Promise<void> {
    const senderAddr: string = email.from?.[0]?.address ?? '';
    const senderName: string = email.from?.[0]?.name ?? senderAddr;
    const subject: string = email.subject ?? '(no subject)';
    const body: string = email.text ?? email.html ?? '';
    const isInterAgent = senderAddr.endsWith('@localhost');

    log?.info?.(`[agenticmail] ${isInterAgent ? 'Inter-agent' : 'New'} email from ${senderAddr}: ${subject}`);

    // Reset rate limiter for agents who have messaged us
    if (isInterAgent && myName) {
      const senderLocal = senderAddr.split('@')[0] ?? '';
      if (senderLocal) recordInboundAgentMessage(senderLocal, myName);
    }

    // Build session key from thread (root message ID)
    let sessionKey = `mail:${senderAddr}`;
    const references = email.references;
    if (Array.isArray(references) && references.length > 0) {
      sessionKey = `mail:thread:${references[0]}`;
    } else if (email.messageId) {
      sessionKey = `mail:thread:${email.messageId}`;
    }

    // Build body with context
    let bodyForAgent = body;
    if (isInterAgent && subject !== '(no subject)') {
      bodyForAgent = `[Message from agent ${senderName}]\nSubject: ${subject}\n\n${body}`;
    } else if (subject !== '(no subject)') {
      bodyForAgent = `Subject: ${subject}\n\n${body}`;
    }

    // Build MsgContext matching OpenClaw's expected format
    const msgCtx: Record<string, unknown> = {
      Body: bodyForAgent,
      BodyForAgent: bodyForAgent,
      RawBody: body,
      CommandBody: body,
      From: senderAddr,
      To: email.to?.[0]?.address ?? '',
      SenderName: senderName,
      SessionKey: sessionKey,
      AccountId: account.accountId,
      MessageSid: email.messageId ?? `mail-${uid}`,
      ReplyToId: email.messageId,
      Provider: 'agenticmail',
      Surface: isInterAgent ? 'agent-mail' : 'email',
      OriginatingChannel: 'mail',
      OriginatingTo: senderAddr,
      ChatType: isInterAgent ? 'agent' : 'direct',
      Timestamp: email.date ? new Date(email.date).getTime() : Date.now(),
      CommandAuthorized: true,
    };

    // Store thread metadata for reply context
    const threadMeta = {
      originalMessageId: email.messageId,
      originalSubject: subject,
      originalFrom: senderAddr,
      references: Array.isArray(references) ? references : [],
    };

    // Dispatch through OpenClaw's pipeline
    await dispatch({
      ctx: msgCtx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          const replyText = payload?.text;
          if (!replyText) return;

          try {
            const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
            const sendBody: Record<string, unknown> = {
              to: senderAddr,
              subject: replySubject,
              text: replyText,
            };

            if (threadMeta.originalMessageId) {
              sendBody.inReplyTo = threadMeta.originalMessageId;
              const refs = [...threadMeta.references];
              if (!refs.includes(threadMeta.originalMessageId)) {
                refs.push(threadMeta.originalMessageId);
              }
              sendBody.references = refs;
            }

            await mailApi(account, 'POST', '/mail/send', sendBody);
            log?.info?.(`[agenticmail] Replied to ${senderAddr}: ${replySubject}`);
          } catch (err) {
            log?.error?.(`[agenticmail] Failed to send email reply: ${(err as Error).message}`);
          }
        },
        onError: (err: unknown, info: any) => {
          log?.error?.(`[agenticmail] Dispatch ${info?.kind ?? 'unknown'} error: ${String(err)}`);
        },
      },
    });

    // Mark as read after processing
    try {
      await mailApi(account, 'POST', `/mail/messages/${uid}/seen`);
    } catch { /* best effort */ }
  }

  /**
   * Poll for unseen emails and dispatch each through OpenClaw's pipeline.
   * Used as fallback when SSE is unavailable, and for initial catch-up.
   */
  async function pollAndDispatch(
    account: ResolvedMailAccount,
    cfg: any,
    dispatch: Function,
    log: any,
    processedUids: Set<number>,
    myName: string,
  ): Promise<void> {
    const searchResult = await mailApi(account, 'POST', '/mail/search', { seen: false });
    const uids: number[] = searchResult?.uids ?? [];
    if (uids.length === 0) return;

    for (const uid of uids) {
      if (processedUids.has(uid)) continue;
      processedUids.add(uid);

      try {
        const email = await mailApi(account, 'GET', `/mail/messages/${uid}`);
        if (!email) continue;

        await dispatchEmail(account, cfg, dispatch, log, email, uid, myName);
      } catch (err) {
        log?.warn?.(`[agenticmail] Failed to process email UID ${uid}: ${(err as Error).message}`);
      }
    }

    // Cap processedUids to prevent unbounded growth (keep last 1000)
    if (processedUids.size > 1000) {
      const arr = [...processedUids];
      const toRemove = arr.slice(0, arr.length - 500);
      for (const uid of toRemove) processedUids.delete(uid);
    }
  }
}
