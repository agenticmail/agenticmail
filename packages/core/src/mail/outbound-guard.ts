/**
 * Outbound Email Guard — scans outgoing emails for sensitive content.
 * Pure functions, zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type OutboundCategory = 'pii' | 'credential' | 'system_internal' | 'owner_privacy' | 'attachment_risk';
export type Severity = 'high' | 'medium';

export interface OutboundWarning {
  category: OutboundCategory;
  severity: Severity;
  ruleId: string;
  description: string;
  match: string;
}

export interface OutboundScanResult {
  warnings: OutboundWarning[];
  hasHighSeverity: boolean;
  hasMediumSeverity: boolean;
  blocked: boolean;
  summary: string;
}

export interface OutboundScanInput {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename?: string; contentType?: string; content?: string | Buffer; encoding?: string }>;
}

export interface AttachmentAdvisory {
  filename: string;
  risk: string;
  detail: string;
}

export interface LinkAdvisory {
  ruleId: string;
  detail: string;
}

export interface SecurityAdvisory {
  spamScore?: number;
  spamCategory?: string;
  isSpam?: boolean;
  isWarning?: boolean;
  attachmentWarnings: AttachmentAdvisory[];
  linkWarnings: LinkAdvisory[];
  summary: string;
}

// ─── Outbound rules ──────────────────────────────────────────────────

interface OutboundRule {
  id: string;
  category: OutboundCategory;
  severity: Severity;
  description: string;
  test: (text: string) => string | null; // returns matched snippet or null
}

const OUTBOUND_TEXT_RULES: OutboundRule[] = [
  // ─── PII ────────────────────────────────────────────────────────────
  {
    id: 'ob_ssn',
    category: 'pii',
    severity: 'high',
    description: 'Social Security Number detected',
    test: (t) => { const m = t.match(/\b\d{3}-\d{2}-\d{4}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_ssn_obfuscated',
    category: 'pii',
    severity: 'high',
    description: 'Social Security Number detected (obfuscated format)',
    test: (t) => {
      // SSN with dots: 123.45.6789
      const m1 = t.match(/\b\d{3}\.\d{2}\.\d{4}\b/);
      if (m1) return m1[0];
      // SSN with spaces: 123 45 6789
      const m2 = t.match(/\b\d{3}\s\d{2}\s\d{4}\b/);
      if (m2) return m2[0];
      // 9 consecutive digits with SSN keyword context
      const m3 = t.match(/\b(?:ssn|social\s*security|soc\s*sec)\s*(?:#|number|num|no)?[\s:]*\d{9}\b/i);
      if (m3) return m3[0];
      return null;
    },
  },
  {
    id: 'ob_credit_card',
    category: 'pii',
    severity: 'high',
    description: 'Credit card number detected',
    test: (t) => { const m = t.match(/\b(?:\d{4}[-\s]?){3}\d{4}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_phone',
    category: 'pii',
    severity: 'medium',
    description: 'US phone number detected',
    test: (t) => { const m = t.match(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_bank_routing',
    category: 'pii',
    severity: 'high',
    description: 'Bank routing or account number detected',
    test: (t) => { const m = t.match(/\b(?:routing|account|acct)\s*(?:#|number|num|no)?[\s:]*\d{6,17}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_drivers_license',
    category: 'pii',
    severity: 'high',
    description: "Driver's license number detected",
    test: (t) => { const m = t.match(/\b(?:driver'?s?\s*(?:license|licence|lic)|DL)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9][A-Z0-9-]{4,14}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_dob',
    category: 'pii',
    severity: 'medium',
    description: 'Date of birth detected',
    test: (t) => {
      const m = t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/i)
        ?? t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i);
      return m ? m[0] : null;
    },
  },
  {
    id: 'ob_passport',
    category: 'pii',
    severity: 'high',
    description: 'Passport number detected',
    test: (t) => { const m = t.match(/\b(?:passport)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9]{6,12}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_tax_id',
    category: 'pii',
    severity: 'high',
    description: 'Tax ID / EIN detected',
    test: (t) => { const m = t.match(/\b(?:EIN|TIN|tax\s*(?:id|identification)|employer\s*id)\s*(?:#|number|num|no)?[\s:]*\d{2}-?\d{7}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_itin',
    category: 'pii',
    severity: 'high',
    description: 'ITIN detected (Individual Taxpayer Identification Number)',
    test: (t) => { const m = t.match(/\bITIN\s*(?:#|number|num|no)?[\s:]*9\d{2}-?\d{2}-?\d{4}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_medicare',
    category: 'pii',
    severity: 'high',
    description: 'Medicare/Medicaid/health insurance ID detected',
    test: (t) => { const m = t.match(/\b(?:medicare|medicaid|health\s*(?:insurance|plan))\s*(?:#|id|number|num|no)?[\s:]*[A-Z0-9]{8,14}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_immigration',
    category: 'pii',
    severity: 'high',
    description: 'Immigration A-number detected',
    test: (t) => { const m = t.match(/\b(?:A-?number|alien\s*(?:#|number|num|no)?|USCIS)\s*[:=\s]*A?-?\d{8,9}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_pin',
    category: 'pii',
    severity: 'medium',
    description: 'PIN code detected',
    test: (t) => { const m = t.match(/\b(?:PIN|pin\s*code|pin\s*number)\s*[:=]\s*\d{4,8}\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_security_qa',
    category: 'pii',
    severity: 'medium',
    description: 'Security question and answer detected',
    test: (t) => {
      const m = t.match(/\b(?:security\s*question|secret\s*question|challenge\s*question)\s*[:=]?\s*.{5,80}(?:answer|response)\s*[:=]?\s*\S+/i)
        ?? t.match(/\b(?:security\s*(?:answer|response)|mother'?s?\s*maiden\s*name|first\s*pet'?s?\s*name)\s*[:=]?\s*\S{2,}/i);
      return m ? m[0].slice(0, 80) : null;
    },
  },

  // ─── Financial ─────────────────────────────────────────────────────
  {
    id: 'ob_iban',
    category: 'pii',
    severity: 'high',
    description: 'IBAN number detected',
    test: (t) => { const m = t.match(/\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_swift',
    category: 'pii',
    severity: 'medium',
    description: 'SWIFT/BIC code detected',
    test: (t) => { const m = t.match(/\b(?:SWIFT|BIC|swift\s*code|bic\s*code)\s*[:=]?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_crypto_wallet',
    category: 'pii',
    severity: 'high',
    description: 'Cryptocurrency wallet address detected',
    test: (t) => {
      const m = t.match(/\b(?:bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/);
      return m ? m[0] : null;
    },
  },
  {
    id: 'ob_wire_transfer',
    category: 'pii',
    severity: 'high',
    description: 'Wire transfer instructions detected',
    test: (t) => {
      if (/\bwire\s+(?:transfer|funds?|payment|to)\b/i.test(t) && /\b(?:routing|account|swift|iban|beneficiary)\b/i.test(t)) {
        return 'wire transfer instructions with account details';
      }
      return null;
    },
  },

  // ─── Credentials ───────────────────────────────────────────────────
  {
    id: 'ob_api_key',
    category: 'credential',
    severity: 'high',
    description: 'API key pattern detected',
    test: (t) => {
      const m = t.match(/\b(?:sk_|pk_|rk_|api_key_|apikey_)[a-zA-Z0-9_]{20,}\b/i)
        ?? t.match(/\b(?:sk-(?:proj|ant|live|test)-)[a-zA-Z0-9_-]{20,}/);
      return m ? m[0] : null;
    },
  },
  {
    id: 'ob_aws_key',
    category: 'credential',
    severity: 'high',
    description: 'AWS access key detected',
    test: (t) => { const m = t.match(/\bAKIA[A-Z0-9]{16}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_password_value',
    category: 'credential',
    severity: 'high',
    description: 'Password value in text',
    test: (t) => {
      // Match standard "password" and leet-speak variants (p@ssword, p4ssword, p@ss, etc.)
      const m = t.match(/\bp[a@4]ss(?:w[o0]rd)?\s*[:=]\s*\S+/i);
      return m ? m[0] : null;
    },
  },
  {
    id: 'ob_private_key',
    category: 'credential',
    severity: 'high',
    description: 'Private key block detected',
    test: (t) => { const m = t.match(/-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_bearer_token',
    category: 'credential',
    severity: 'high',
    description: 'Bearer token detected',
    test: (t) => { const m = t.match(/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_connection_string',
    category: 'credential',
    severity: 'high',
    description: 'Database connection string detected',
    test: (t) => { const m = t.match(/\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s]+/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_github_token',
    category: 'credential',
    severity: 'high',
    description: 'GitHub token detected',
    test: (t) => { const m = t.match(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[a-zA-Z0-9_]{20,}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_stripe_key',
    category: 'credential',
    severity: 'high',
    description: 'Stripe API key detected',
    test: (t) => { const m = t.match(/\b(?:sk_live_|pk_live_|rk_live_|sk_test_|pk_test_|rk_test_)[a-zA-Z0-9]{20,}\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_jwt',
    category: 'credential',
    severity: 'high',
    description: 'JWT token detected',
    test: (t) => { const m = t.match(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/); return m ? m[0].slice(0, 80) : null; },
  },
  {
    id: 'ob_webhook_url',
    category: 'credential',
    severity: 'high',
    description: 'Webhook URL with token detected',
    test: (t) => { const m = t.match(/\bhttps?:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|[\w.-]+\.webhook\.site)\/\S+/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_env_block',
    category: 'credential',
    severity: 'high',
    description: 'Multiple environment variable assignments detected (possible .env leak)',
    test: (t) => {
      const lines = t.split('\n');
      let consecutive = 0;
      let first = '';
      for (const line of lines) {
        if (/^[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(line.trim())) {
          if (++consecutive === 1) first = line.trim();
          if (consecutive >= 3) return first + '... (multiple env vars)';
        } else if (line.trim() !== '' && !line.trim().startsWith('#')) {
          consecutive = 0;
        }
      }
      return null;
    },
  },
  {
    id: 'ob_seed_phrase',
    category: 'credential',
    severity: 'high',
    description: 'Recovery/seed phrase detected',
    test: (t) => { const m = t.match(/\b(?:seed\s*phrase|recovery\s*phrase|mnemonic|backup\s*words)\s*[:=]?\s*.{10,}/i); return m ? m[0].slice(0, 80) : null; },
  },
  {
    id: 'ob_2fa_codes',
    category: 'credential',
    severity: 'high',
    description: '2FA backup/recovery codes detected',
    test: (t) => { const m = t.match(/\b(?:2fa|two.factor|backup|recovery)\s*(?:code|key)s?\s*[:=]?\s*(?:[A-Z0-9]{4,8}[\s,;-]+){2,}/i); return m ? m[0].slice(0, 80) : null; },
  },
  {
    id: 'ob_credential_pair',
    category: 'credential',
    severity: 'high',
    description: 'Username/email + password pair detected',
    test: (t) => { const m = t.match(/\b(?:user(?:name)?|email|login)\s*[:=]\s*\S+[\s,;]+(?:password|passwd|pass|pwd)\s*[:=]\s*\S+/i); return m ? m[0].slice(0, 80) : null; },
  },
  {
    id: 'ob_oauth_token',
    category: 'credential',
    severity: 'high',
    description: 'OAuth access/refresh token detected',
    test: (t) => { const m = t.match(/\b(?:access_token|refresh_token|oauth_token)\s*[:=]\s*[a-zA-Z0-9_\-.]{20,}/i); return m ? m[0].slice(0, 80) : null; },
  },
  {
    id: 'ob_vpn_creds',
    category: 'credential',
    severity: 'high',
    description: 'VPN credentials detected',
    test: (t) => { const m = t.match(/\b(?:vpn|openvpn|wireguard|ipsec)\b.*\b(?:password|key|secret|credential|pre.?shared)\b/i); return m ? m[0].slice(0, 80) : null; },
  },

  // ─── System internals ──────────────────────────────────────────────
  {
    id: 'ob_private_ip',
    category: 'system_internal',
    severity: 'medium',
    description: 'Private IP address detected',
    test: (t) => { const m = t.match(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/); return m ? m[0] : null; },
  },
  {
    id: 'ob_file_path',
    category: 'system_internal',
    severity: 'medium',
    description: 'Local file path detected',
    test: (t) => { const m = t.match(/(?:\/Users\/|\/home\/|\/etc\/|\/var\/|C:\\Users\\|C:\\Windows\\)\S+/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_env_variable',
    category: 'system_internal',
    severity: 'medium',
    description: 'Environment variable assignment detected',
    test: (t) => { const m = t.match(/\b[A-Z][A-Z0-9_]{2,}(?:_URL|_KEY|_SECRET|_TOKEN|_PASSWORD|_HOST|_PORT|_DSN)\s*=\s*\S+/); return m ? m[0] : null; },
  },

  // ─── Owner privacy ─────────────────────────────────────────────────
  {
    id: 'ob_owner_info',
    category: 'owner_privacy',
    severity: 'high',
    description: 'May be revealing owner personal information',
    test: (t) => { const m = t.match(/\b(?:my\s+)?owner'?s?\s+(?:name|address|phone|email|password|social|ssn|credit\s+card|bank|account)\b/i); return m ? m[0] : null; },
  },
  {
    id: 'ob_personal_reveal',
    category: 'owner_privacy',
    severity: 'high',
    description: 'Agent revealing personal details about its operator',
    test: (t) => { const m = t.match(/\b(?:the\s+person\s+who\s+(?:owns|runs|operates)\s+me|my\s+(?:human|creator|operator)\s+(?:is|lives|works|named))\b/i); return m ? m[0] : null; },
  },
];

// Sensitive attachment extensions
const HIGH_RISK_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.env', '.credentials', '.keystore', '.jks', '.p8']);
const MEDIUM_RISK_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3', '.sql', '.csv', '.tsv', '.json', '.yml', '.yaml', '.conf', '.config', '.ini']);

// ─── Helpers ────────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities so regex patterns work on actual content.
 *  Tags are removed (not replaced with spaces) to prevent tag-based pattern evasion
 *  like AKI<b>A</b>IOSFODNN7EXAMPLE or 123<span></span>-45-6789. */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    // Decode named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Decode ALL numeric entities (decimal &#NNN; and hex &#xHH;) so encoded
    // digits, hyphens, etc. don't bypass regex-based detection rules
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

/** Content types whose content should be scanned through outbound rules. */
const TEXT_SCANNABLE_TYPES = new Set([
  'text/plain', 'text/html', 'text/csv', 'text/xml', 'text/markdown',
  'application/json', 'application/xml', 'application/yaml',
  'application/x-yaml', 'application/javascript', 'application/x-sh',
]);

/** File extensions whose content should be scanned through outbound rules. */
const TEXT_SCANNABLE_EXTENSIONS = new Set([
  '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.md', '.log',
  '.env', '.conf', '.config', '.ini', '.sql', '.js', '.ts', '.py',
  '.sh', '.html', '.htm', '.css', '.toml',
]);

/** Check if an attachment's content should be scanned based on type or extension. */
function isTextScannable(filename?: string, contentType?: string): boolean {
  if (contentType) {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (TEXT_SCANNABLE_TYPES.has(base) || base.startsWith('text/')) return true;
  }
  if (filename) {
    const lower = filename.toLowerCase();
    const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
    if (TEXT_SCANNABLE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/** Extract text content from an attachment for scanning. Decodes base64 if needed. */
function getAttachmentText(content: string | Buffer | undefined, encoding?: string): string {
  if (!content) return '';
  if (Buffer.isBuffer(content)) return content.toString('utf-8');
  if (typeof content === 'string') {
    if (encoding === 'base64') {
      try { return Buffer.from(content, 'base64').toString('utf-8'); } catch { return content; }
    }
    return content;
  }
  return '';
}

// ─── scanOutboundEmail ───────────────────────────────────────────────

/**
 * Scans outgoing email content for sensitive data (PII, credentials, system info, owner privacy).
 * Skips scanning entirely if ALL recipients are @localhost (internal agent-to-agent communication).
 */
export function scanOutboundEmail(input: OutboundScanInput): OutboundScanResult {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const allInternal = recipients.every(r => r.endsWith('@localhost'));

  if (allInternal) {
    return { warnings: [], hasHighSeverity: false, hasMediumSeverity: false, blocked: false, summary: '' };
  }

  const warnings: OutboundWarning[] = [];

  // Strip HTML tags so regex patterns work on actual content (e.g. AKI<b>A</b>... → AKIA...)
  const strippedHtml = input.html ? stripHtmlTags(input.html) : '';

  // Combine subject + text + stripped html for scanning
  const combined = [input.subject ?? '', input.text ?? '', strippedHtml].join('\n');

  if (combined.trim()) {
    for (const rule of OUTBOUND_TEXT_RULES) {
      const match = rule.test(combined);
      if (match) {
        warnings.push({
          category: rule.category,
          severity: rule.severity,
          ruleId: rule.id,
          description: rule.description,
          match: match.length > 80 ? match.slice(0, 80) + '...' : match,
        });
      }
    }
  }

  // Check attachment filenames and content
  if (input.attachments?.length) {
    for (const att of input.attachments) {
      const name = att.filename ?? '';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';

      if (HIGH_RISK_EXTENSIONS.has(ext)) {
        warnings.push({
          category: 'attachment_risk',
          severity: 'high',
          ruleId: 'ob_sensitive_file',
          description: `Sensitive file type: ${ext}`,
          match: name,
        });
      } else if (MEDIUM_RISK_EXTENSIONS.has(ext)) {
        warnings.push({
          category: 'attachment_risk',
          severity: 'medium',
          ruleId: 'ob_data_file',
          description: `Data file type: ${ext}`,
          match: name,
        });
      }

      // Scan text-like attachment content through all outbound rules
      if (isTextScannable(att.filename, att.contentType)) {
        const attText = getAttachmentText(att.content, att.encoding);
        if (attText.trim()) {
          for (const rule of OUTBOUND_TEXT_RULES) {
            const match = rule.test(attText);
            if (match) {
              warnings.push({
                category: rule.category,
                severity: rule.severity,
                ruleId: rule.id,
                description: `${rule.description} (in attachment: ${name || 'unnamed'})`,
                match: match.length > 80 ? match.slice(0, 80) + '...' : match,
              });
            }
          }
        }
      }
    }
  }

  const hasHigh = warnings.some(w => w.severity === 'high');
  const hasMedium = warnings.some(w => w.severity === 'medium');

  let summary = '';
  if (warnings.length > 0) {
    const parts: string[] = [];
    if (hasHigh) parts.push(`${warnings.filter(w => w.severity === 'high').length} HIGH severity`);
    if (hasMedium) parts.push(`${warnings.filter(w => w.severity === 'medium').length} MEDIUM severity`);
    summary = hasHigh
      ? `OUTBOUND GUARD BLOCKED: ${warnings.length} warning(s) — ${parts.join(', ')}. Email NOT sent. Remove sensitive content and retry.`
      : `OUTBOUND GUARD: ${warnings.length} warning(s) — ${parts.join(', ')}. Review before sending to external recipients.`;
  }

  return { warnings, hasHighSeverity: hasHigh, hasMediumSeverity: hasMedium, blocked: hasHigh, summary };
}

// ─── Inbound Security Advisory ───────────────────────────────────────

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.scr', '.com', '.vbs',
  '.js', '.wsf', '.hta', '.cpl', '.jar', '.app', '.dmg', '.run',
]);

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.cab', '.iso']);

/**
 * Builds a structured security advisory from email metadata (spam score, attachments, link warnings).
 * Used by tool handlers to present per-attachment and per-link warnings to the agent.
 */
export function buildInboundSecurityAdvisory(
  security: { score?: number; category?: string; isSpam?: boolean; isWarning?: boolean; matches?: Array<{ ruleId: string }> } | undefined,
  attachments: Array<{ filename?: string; contentType?: string; size?: number }> | undefined,
): SecurityAdvisory {
  const attachmentWarnings: AttachmentAdvisory[] = [];
  const linkWarnings: LinkAdvisory[] = [];

  // Attachment analysis
  if (attachments?.length) {
    for (const att of attachments) {
      const name = att.filename ?? 'unknown';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';

      // Double extension check (e.g., invoice.pdf.exe)
      const parts = lower.split('.');
      if (parts.length > 2) {
        const lastExt = '.' + parts[parts.length - 1];
        if (EXECUTABLE_EXTENSIONS.has(lastExt)) {
          attachmentWarnings.push({
            filename: name,
            risk: 'CRITICAL',
            detail: `DOUBLE EXTENSION — Disguised executable (appears as .${parts[parts.length - 2]} but is ${lastExt})`,
          });
          continue;
        }
      }

      if (EXECUTABLE_EXTENSIONS.has(ext)) {
        attachmentWarnings.push({
          filename: name,
          risk: 'HIGH',
          detail: `EXECUTABLE file (${ext}) — DO NOT open or trust`,
        });
      } else if (ARCHIVE_EXTENSIONS.has(ext)) {
        attachmentWarnings.push({
          filename: name,
          risk: 'MEDIUM',
          detail: `ARCHIVE file (${ext}) — May contain malware. Do not extract or execute contents.`,
        });
      } else if (ext === '.html' || ext === '.htm') {
        attachmentWarnings.push({
          filename: name,
          risk: 'HIGH',
          detail: 'HTML file attachment — May contain phishing content or scripts',
        });
      }
    }
  }

  // Link / spam rule analysis
  const matches = security?.matches ?? [];
  for (const m of matches) {
    switch (m.ruleId) {
      case 'ph_mismatched_display_url':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Mismatched display URL — link text shows different domain than actual destination (PHISHING)' });
        break;
      case 'ph_data_uri':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'data: URI in link — may execute embedded code' });
        break;
      case 'ph_homograph':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Homograph/punycode domain — international characters used to mimic legitimate domain' });
        break;
      case 'ph_spoofed_sender':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Sender claims to be a known brand but uses suspicious domain' });
        break;
      case 'ph_credential_harvest':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Email requests credentials with suspicious links' });
        break;
      case 'de_webhook_exfil':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Contains suspicious webhook/tunneling URL — potential data exfiltration' });
        break;
      case 'pi_invisible_unicode':
        linkWarnings.push({ ruleId: m.ruleId, detail: 'Contains invisible unicode characters — may hide injected instructions' });
        break;
    }
  }

  // Build summary
  const lines: string[] = [];
  if (security?.isSpam) {
    lines.push(`[SPAM] Score: ${security.score}, Category: ${security.category} — Email was moved to Spam`);
  } else if (security?.isWarning) {
    lines.push(`[WARNING] Score: ${security.score}, Category: ${security.category} — Treat with caution`);
  }

  if (attachmentWarnings.length > 0) {
    lines.push(`${attachmentWarnings.length} attachment warning(s):`);
    for (const w of attachmentWarnings) {
      lines.push(`  [${w.risk}] "${w.filename}": ${w.detail}`);
    }
  }

  if (linkWarnings.length > 0) {
    lines.push(`${linkWarnings.length} link/content warning(s):`);
    for (const w of linkWarnings) {
      lines.push(`  [!] ${w.detail}`);
    }
  }

  return {
    spamScore: security?.score,
    spamCategory: security?.category,
    isSpam: security?.isSpam,
    isWarning: security?.isWarning,
    attachmentWarnings,
    linkWarnings,
    summary: lines.join('\n'),
  };
}
