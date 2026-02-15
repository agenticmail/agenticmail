/**
 * Cloudflare Email Worker template for AgenticMail.
 * Receives inbound emails via Cloudflare Email Routing and forwards
 * the raw RFC822 message to the AgenticMail inbound webhook.
 */
export const EMAIL_WORKER_SCRIPT = `
export default {
  async email(message, env, ctx) {
    // Read the raw RFC822 stream into an ArrayBuffer, then base64-encode
    // because the inbound endpoint expects base64 in the rawEmail field.
    const arrayBuf = await new Response(message.raw).arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const rawEmail = btoa(binary);

    const response = await fetch(env.INBOUND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inbound-Secret': env.INBOUND_SECRET,
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        rawEmail,
      }),
    });

    if (!response.ok) {
      // Log but don't reject — rejecting causes bounce-back to sender
      console.error('AgenticMail inbound webhook failed:', response.status, await response.text());
    }
  },
};
`;
