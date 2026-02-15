/**
 * AgenticMail Inbound Email Worker
 *
 * Receives email via Cloudflare Email Routing and forwards
 * to the AgenticMail API for delivery to the agent's mailbox.
 *
 * Required env vars:
 *   API_URL         - Full URL to the inbound endpoint
 *   INBOUND_SECRET  - Shared secret for authentication
 */
export default {
  async email(message, env, ctx) {
    const headers = {};
    for (const [key, value] of message.headers) {
      headers[key] = value;
    }

    // Read raw email and encode as base64 (chunk-safe, no stack overflow)
    const rawEmail = new Response(message.raw);
    const rawBody = await rawEmail.arrayBuffer();
    const bytes = new Uint8Array(rawBody);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64Body = btoa(binary);

    const apiUrl = env.API_URL || "https://2sabi.net/api/agenticmail/mail/inbound";

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Inbound-Secret": env.INBOUND_SECRET || "",
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: headers["subject"] || "",
          rawEmail: base64Body,
          headers: headers,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("API returned " + response.status + ": " + text);
        message.setReject("Temporary failure");
      }
    } catch (err) {
      console.error("Failed to forward: " + err.message);
      message.setReject("Temporary failure");
    }
  },
};
