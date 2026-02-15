import { simpleParser } from 'mailparser';
import type { ParsedEmail } from './types.js';

export async function parseEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);

  // Use X-Original-From header if present (inbound relay emails store the real sender there)
  const xOriginalFrom = parsed.headers?.get('x-original-from');
  const originalFromAddr = typeof xOriginalFrom === 'string' ? xOriginalFrom.trim() : undefined;

  let fromAddrs = parsed.from?.value ?? [];
  if (originalFromAddr && fromAddrs.length > 0 && fromAddrs[0].address?.endsWith('@localhost')) {
    // Replace the @localhost address with the original external sender
    fromAddrs = [{ name: fromAddrs[0].name || '', address: originalFromAddr }];
  }

  const toAddrs = parsed.to
    ? Array.isArray(parsed.to) ? parsed.to.flatMap((t) => t.value) : parsed.to.value
    : [];
  const ccAddrs = parsed.cc
    ? Array.isArray(parsed.cc) ? parsed.cc.flatMap((c) => c.value) : parsed.cc.value
    : undefined;
  const replyToAddrs = parsed.replyTo
    ? Array.isArray(parsed.replyTo) ? parsed.replyTo.flatMap((r) => r.value) : parsed.replyTo.value
    : undefined;

  return {
    messageId: parsed.messageId ?? '',
    subject: parsed.subject ?? '',
    from: fromAddrs.map((a: { name: string; address?: string }) => ({ name: a.name, address: a.address ?? '' })),
    to: toAddrs.map((a: { name: string; address?: string }) => ({ name: a.name, address: a.address ?? '' })),
    cc: ccAddrs?.map((a: { name: string; address?: string }) => ({ name: a.name, address: a.address ?? '' })),
    replyTo: replyToAddrs?.map((a: { name: string; address?: string }) => ({ name: a.name, address: a.address ?? '' })),
    date: parsed.date ?? new Date(),
    text: parsed.text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
      ? Array.isArray(parsed.references) ? parsed.references : [parsed.references]
      : undefined,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? 'unnamed',
      contentType: a.contentType,
      size: a.size,
      content: a.content,
    })),
    headers: parsed.headers as unknown as Map<string, string>,
  };
}
