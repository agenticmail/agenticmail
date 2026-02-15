import { connect } from "cloudflare:sockets";

/**
 * AgenticMail Outbound Relay — Cloudflare Worker
 *
 * Relays outbound email through an SMTP server (e.g. Gmail) on port 465.
 * Cloudflare blocks port 25 (direct MX delivery) but allows 465/587.
 * We use Gmail SMTP as the relay — the email FROM is secretary@2sabi.net
 * and Gmail handles the actual delivery with its clean IP infrastructure.
 *
 * Required env vars:
 *   OUTBOUND_SECRET  - shared secret for authenticating HTTP requests
 *   SMTP_HOST        - relay SMTP host (default: smtp.gmail.com)
 *   SMTP_PORT        - relay SMTP port (default: 465)
 *   SMTP_USER        - SMTP username (Gmail address)
 *   SMTP_PASS        - SMTP password (Gmail app password)
 */

// --- Minimal SMTP Client over TCP (with TLS) ---

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = "";
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  async readLine() {
    while (!this.buffer.includes("\r\n")) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP connection closed unexpectedly");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const idx = this.buffer.indexOf("\r\n");
    const line = this.buffer.substring(0, idx);
    this.buffer = this.buffer.substring(idx + 2);
    return line;
  }

  async readResponse() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      // Last line of multi-line response has space after code (not dash)
      if (line.length >= 4 && line[3] !== "-") break;
    }
    const code = parseInt(lines[0].substring(0, 3), 10);
    return { code, lines, text: lines.join("\n") };
  }

  async write(data) {
    await this.writer.write(this.encoder.encode(data));
  }

  async command(cmd) {
    await this.write(cmd + "\r\n");
    return this.readResponse();
  }

  async sendData(emailContent) {
    // Dot-stuff lines starting with "." per RFC 5321
    const stuffed = emailContent.replace(/\r\n\./g, "\r\n..");
    await this.write(stuffed + "\r\n.\r\n");
    return this.readResponse();
  }

  async upgradeToTls(hostname) {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const tlsSocket = this.socket.startTls({ servername: hostname });
    this.reader = tlsSocket.readable.getReader();
    this.writer = tlsSocket.writable.getWriter();
    this.buffer = "";
    this.socket = tlsSocket;
  }

  async close() {
    try { this.writer.close(); } catch {}
    try { this.reader.cancel(); } catch {}
  }
}

// --- SMTP Auth ---

function encodeBase64(str) {
  // Workers have btoa
  return btoa(str);
}

async function smtpLogin(smtp, user, pass) {
  // Try AUTH LOGIN
  const authResp = await smtp.command("AUTH LOGIN");
  if (authResp.code !== 334) {
    throw new Error(`AUTH LOGIN failed: ${authResp.text}`);
  }
  const userResp = await smtp.command(encodeBase64(user));
  if (userResp.code !== 334) {
    throw new Error(`AUTH user failed: ${userResp.text}`);
  }
  const passResp = await smtp.command(encodeBase64(pass));
  if (passResp.code !== 235) {
    throw new Error(`AUTH password failed: ${passResp.text}`);
  }
}

// --- Email Builder ---

function buildRawEmail({ from, to, subject, text, html, replyTo, inReplyTo, references }) {
  const recipients = Array.isArray(to) ? to : [to];
  const domain = from.split("@")[1];
  const msgId = "<" + crypto.randomUUID() + "@" + domain + ">";
  const boundary = "----=_Part_" + Date.now().toString(36);

  const headerLines = [
    "MIME-Version: 1.0",
    "From: " + from,
    "To: " + recipients.join(", "),
    "Subject: " + subject,
    "Message-ID: " + msgId,
    "Date: " + new Date().toUTCString(),
  ];

  if (replyTo) headerLines.push("Reply-To: " + replyTo);
  if (inReplyTo) headerLines.push("In-Reply-To: " + inReplyTo);
  if (references) headerLines.push("References: " + references);

  let body;
  if (html && text) {
    headerLines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    body =
      "--" + boundary + "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + text +
      "\r\n--" + boundary + "\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + html +
      "\r\n--" + boundary + "--";
  } else if (html) {
    headerLines.push("Content-Type: text/html; charset=utf-8");
    body = html;
  } else {
    headerLines.push("Content-Type: text/plain; charset=utf-8");
    body = text || "";
  }

  const rawEmail = headerLines.join("\r\n") + "\r\n\r\n" + body;
  return { rawEmail, msgId, recipients };
}

// --- SMTP Relay Delivery ---

async function relayEmail(from, to, rawEmail, env) {
  const host = env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(env.SMTP_PORT || "465", 10);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error("SMTP_USER and SMTP_PASS must be configured");
  }

  // Port 465 = implicit TLS; Port 587 = STARTTLS
  const useImplicitTls = port === 465;

  let socket;
  if (useImplicitTls) {
    // Implicit TLS — connect directly with TLS
    socket = connect({ hostname: host, port }, { secureTransport: "on" });
  } else {
    // Plain connection (will upgrade via STARTTLS)
    socket = connect({ hostname: host, port });
  }

  const smtp = new SmtpClient(socket);

  try {
    // Read greeting
    const greeting = await smtp.readResponse();
    if (greeting.code !== 220) {
      throw new Error(`Bad greeting from ${host}: ${greeting.text}`);
    }

    // EHLO
    let ehlo = await smtp.command("EHLO agenticmail.worker");
    if (ehlo.code !== 250) {
      throw new Error(`EHLO rejected: ${ehlo.text}`);
    }

    // STARTTLS if needed (port 587)
    if (!useImplicitTls) {
      const supportsStartTls = ehlo.lines.some((l) => l.toUpperCase().includes("STARTTLS"));
      if (supportsStartTls) {
        const tlsResp = await smtp.command("STARTTLS");
        if (tlsResp.code === 220) {
          await smtp.upgradeToTls(host);
          ehlo = await smtp.command("EHLO agenticmail.worker");
        }
      }
    }

    // Authenticate
    await smtpLogin(smtp, user, pass);

    // MAIL FROM
    const mailFrom = await smtp.command(`MAIL FROM:<${from}>`);
    if (mailFrom.code !== 250) {
      throw new Error(`MAIL FROM rejected: ${mailFrom.text}`);
    }

    // RCPT TO
    const rcptTo = await smtp.command(`RCPT TO:<${to}>`);
    if (rcptTo.code !== 250) {
      throw new Error(`RCPT TO rejected: ${rcptTo.text}`);
    }

    // DATA
    const dataResp = await smtp.command("DATA");
    if (dataResp.code !== 354) {
      throw new Error(`DATA rejected: ${dataResp.text}`);
    }

    // Send email content
    const result = await smtp.sendData(rawEmail);
    if (result.code !== 250) {
      throw new Error(`Message rejected: ${result.text}`);
    }

    // QUIT
    try { await smtp.command("QUIT"); } catch {}
    await smtp.close();

    return { ok: true, relay: `${host}:${port}`, response: result.text };
  } catch (err) {
    await smtp.close();
    throw err;
  }
}

// --- Worker Entry ---

export default {
  async email(message, env) {
    // Inbound email handler (not used for outbound relay)
  },

  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Outbound-Secret");
    if (secret !== (env.OUTBOUND_SECRET || "outbound_2sabi_secret_key")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const payload = await request.json();
      const { from, to, subject } = payload;

      if (!from || !to || !subject) {
        return new Response(
          JSON.stringify({ error: "from, to, and subject are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const { rawEmail, msgId, recipients } = buildRawEmail(payload);

      // Relay each recipient through SMTP
      const results = [];
      for (const rcpt of recipients) {
        const result = await relayEmail(from, rcpt, rawEmail, env);
        results.push({ to: rcpt, ...result });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          messageId: msgId,
          envelope: { from, to: recipients },
          delivery: results,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
