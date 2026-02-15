import type { ParsedEmail } from './types.js';

// --- Types ---

export type SpamCategory =
  | 'prompt_injection'
  | 'social_engineering'
  | 'data_exfiltration'
  | 'phishing'
  | 'header_anomaly'
  | 'content_spam'
  | 'link_analysis'
  | 'authentication'
  | 'attachment_risk';

export interface SpamRuleMatch {
  ruleId: string;
  category: SpamCategory;
  score: number;
  description: string;
}

export interface SpamResult {
  score: number;
  isSpam: boolean;
  isWarning: boolean;
  matches: SpamRuleMatch[];
  topCategory: SpamCategory | null;
}

interface SpamRule {
  id: string;
  category: SpamCategory;
  score: number;
  description: string;
  test: (email: ParsedEmail, bodyText: string, bodyHtml: string) => boolean;
}

export const SPAM_THRESHOLD = 40;
export const WARNING_THRESHOLD = 20;

// --- Internal email detection ---

export function isInternalEmail(email: ParsedEmail, localDomains?: string[]): boolean {
  const fromDomain = email.from[0]?.address?.split('@')[1]?.toLowerCase();
  if (!fromDomain) return false;
  const internals = new Set(['localhost', ...(localDomains ?? []).map(d => d.toLowerCase())]);

  // If from is @localhost but replyTo has an external domain, it's a relay email — NOT internal
  if (internals.has(fromDomain) && email.replyTo?.length) {
    const replyDomain = email.replyTo[0]?.address?.split('@')[1]?.toLowerCase();
    if (replyDomain && !internals.has(replyDomain)) return false;
  }

  return internals.has(fromDomain);
}

// --- Compiled regex patterns ---

const RE_IGNORE_INSTRUCTIONS = /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i;
const RE_YOU_ARE_NOW = /you\s+are\s+now\s+(a|an|the|my)\b/i;
const RE_SYSTEM_DELIMITER = /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>/i;
const RE_NEW_INSTRUCTIONS = /new\s+instructions?:|override\s+instructions?:/i;
const RE_ACT_AS = /act\s+as\s+(a|an|if)|pretend\s+(to be|you\s+are)/i;
const RE_DO_NOT_MENTION = /do\s+not\s+(mention|tell|reveal|disclose)\s+(that|this)/i;
const RE_TAG_CHARS = /[\u{E0001}-\u{E007F}]/u;
const RE_DENSE_ZWC = /[\u200B\u200C\u200D\uFEFF]{3,}/;
const RE_JAILBREAK = /\b(DAN|jailbreak|bypass\s+(safety|filter|restriction)|unlimited\s+mode)\b/i;
const RE_BASE64_BLOCK = /[A-Za-z0-9+/]{100,}={0,2}/;
const RE_MARKDOWN_INJECTION = /```(?:system|python\s+exec|bash\s+exec)/i;

const RE_OWNER_IMPERSONATION = /your\s+(owner|creator|admin|boss|master|human)\s+(asked|told|wants|said|instructed|needs)/i;
const RE_SECRET_REQUEST = /share\s+(your|the)\s+(api.?key|password|secret|credential|token)/i;
const RE_IMPERSONATE_SYSTEM = /this\s+is\s+(a|an)\s+(system|security|admin|automated)\s+(message|alert|notification)/i;
const RE_URGENCY = /\b(urgent|immediately|right now|asap|deadline|expires?|last chance|act now|time.?sensitive)\b/i;
const RE_AUTHORITY = /\b(suspend|terminate|deactivat|unauthori[zs]|locked|compromised|breach|violation|legal action)\b/i;
const RE_MONEY_REQUEST = /send\s+(me|us)\s+\$?\d|wire\s+transfer|western\s+union|money\s*gram/i;
const RE_GIFT_CARD = /buy\s+(me\s+)?gift\s*cards?|itunes\s+cards?|google\s+play\s+cards?/i;
const RE_CEO_FRAUD = /\b(CEO|CFO|CTO|director|executive)\b.*\b(wire|transfer|payment|urgent)\b/i;

const RE_FORWARD_ALL = /forward\s+(all|every)\s+(email|message)/i;
const RE_SEARCH_CREDS = /search\s+(inbox|email|mailbox).*password|find.*credential/i;
const RE_SEND_TO_EXTERNAL = /send\s+(the|all|every).*to\s+\S+@\S+/i;
const RE_DUMP_INSTRUCTIONS = /reveal.*system\s+prompt|dump.*instructions|show.*system\s+prompt|print.*instructions/i;
const RE_WEBHOOK_EXFIL = /https?:\/\/[^/]*(webhook|ngrok|pipedream|requestbin|hookbin)/i;

const RE_CREDENTIAL_HARVEST = /verify\s+your\s+(account|identity|password|credentials?)/i;
const RE_LINK_TAG = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi;
const RE_LINK_TAG_WITH_TEXT = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
const RE_URL_IN_TEXT = /https?:\/\/[^\s<>"]+/gi;
const RE_IP_URL = /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i;
const RE_URL_SHORTENER = /https?:\/\/(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|shorturl\.at)\//i;
const RE_DATA_URI = /(?:data:text\/html|javascript:)/i;
const RE_LOGIN_URGENCY = /(click\s+here|sign\s+in|log\s*in).*\b(urgent|immediately|expire|suspend|locked)/i;
const RE_PHARMACY_SPAM = /\b(viagra|cialis|pharmacy|prescription|cheap\s+meds|online\s+pharmacy)\b/i;
const RE_WEIGHT_LOSS = /\b(weight\s+loss|diet\s+pill|lose\s+\d+\s+(lbs?|pounds|kg)|fat\s+burn)\b/i;

const RE_LOTTERY_SCAM = /you\s+(have\s+)?(won|been\s+selected)|lottery|million\s+dollars|nigerian?\s+prince/i;
const RE_CRYPTO_SCAM = /(bitcoin|crypto|ethereum).*invest(ment)?|guaranteed\s+returns|double\s+your\s+(money|bitcoin|crypto)/i;

const RE_EXECUTABLE_EXT = /\.(exe|bat|cmd|ps1|sh|dll|scr|vbs|js|msi|com)$/i;
const RE_DOUBLE_EXT = /\.\w{2,5}\.(exe|bat|cmd|ps1|sh|dll|scr|vbs|js|msi|com)$/i;
const RE_ARCHIVE_EXT = /\.(zip|rar|7z|tar\.gz|tgz)$/i;
const RE_HTML_ATTACHMENT_EXT = /\.(html?|svg)$/i;

const BRAND_DOMAINS: Record<string, string[]> = {
  google: ['google.com', 'gmail.com', 'googlemail.com'],
  microsoft: ['microsoft.com', 'outlook.com', 'hotmail.com', 'live.com'],
  apple: ['apple.com', 'icloud.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de'],
  paypal: ['paypal.com'],
  meta: ['facebook.com', 'meta.com', 'instagram.com'],
  netflix: ['netflix.com'],
  bank: ['chase.com', 'wellsfargo.com', 'bankofamerica.com', 'citibank.com'],
};

// --- Spam word density ---

const SPAM_WORDS = [
  'congratulations', 'winner', 'prize', 'claim', 'free', 'offer',
  'limited time', 'act now', 'click here', 'no obligation', 'risk free',
  'guaranteed', 'million', 'billion', 'inheritance', 'beneficiary',
  'wire transfer', 'western union', 'dear friend', 'dear sir',
  'kindly', 'revert back', 'do the needful', 'humbly', 'esteemed',
  'investment opportunity', 'double your', 'earn money', 'work from home',
  'make money', 'cash bonus', 'discount', 'lowest price',
];

function countSpamWords(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const word of SPAM_WORDS) {
    if (lower.includes(word)) count++;
  }
  return count;
}

// --- Homograph / punycode detection ---

function hasHomographChars(domain: string): boolean {
  if (domain.startsWith('xn--')) return true;
  // Check for mixed scripts (Cyrillic characters in ASCII-looking domains)
  const hasCyrillic = /[\u0400-\u04FF]/.test(domain);
  const hasLatin = /[a-zA-Z]/.test(domain);
  return hasCyrillic && hasLatin;
}

// --- Rule definitions ---

const RULES: SpamRule[] = [
  // === Prompt injection ===
  {
    id: 'pi_ignore_instructions',
    category: 'prompt_injection',
    score: 25,
    description: 'Contains "ignore previous instructions" pattern',
    test: (_e, text) => RE_IGNORE_INSTRUCTIONS.test(text),
  },
  {
    id: 'pi_you_are_now',
    category: 'prompt_injection',
    score: 25,
    description: 'Contains "you are now a..." roleplay injection',
    test: (_e, text) => RE_YOU_ARE_NOW.test(text),
  },
  {
    id: 'pi_system_delimiter',
    category: 'prompt_injection',
    score: 20,
    description: 'Contains LLM system delimiters ([SYSTEM], [INST], etc.)',
    test: (_e, text, html) => RE_SYSTEM_DELIMITER.test(text) || RE_SYSTEM_DELIMITER.test(html),
  },
  {
    id: 'pi_new_instructions',
    category: 'prompt_injection',
    score: 20,
    description: 'Contains "new instructions:" or "override instructions:"',
    test: (_e, text) => RE_NEW_INSTRUCTIONS.test(text),
  },
  {
    id: 'pi_act_as',
    category: 'prompt_injection',
    score: 15,
    description: 'Contains "act as" or "pretend to be" injection',
    test: (_e, text) => RE_ACT_AS.test(text),
  },
  {
    id: 'pi_do_not_mention',
    category: 'prompt_injection',
    score: 15,
    description: 'Contains "do not mention/tell/reveal" suppression',
    test: (_e, text) => RE_DO_NOT_MENTION.test(text),
  },
  {
    id: 'pi_invisible_unicode',
    category: 'prompt_injection',
    score: 20,
    description: 'Contains invisible Unicode tag characters or dense zero-width chars',
    test: (_e, text, html) =>
      RE_TAG_CHARS.test(text) || RE_TAG_CHARS.test(html) ||
      RE_DENSE_ZWC.test(text) || RE_DENSE_ZWC.test(html),
  },
  {
    id: 'pi_jailbreak',
    category: 'prompt_injection',
    score: 20,
    description: 'Contains jailbreak/DAN/bypass safety language',
    test: (_e, text) => RE_JAILBREAK.test(text),
  },
  {
    id: 'pi_base64_injection',
    category: 'prompt_injection',
    score: 15,
    description: 'Contains long base64-encoded blocks (potential hidden instructions)',
    test: (_e, text) => RE_BASE64_BLOCK.test(text),
  },
  {
    id: 'pi_markdown_injection',
    category: 'prompt_injection',
    score: 10,
    description: 'Contains code block injection attempts (```system, ```python exec)',
    test: (_e, text) => RE_MARKDOWN_INJECTION.test(text),
  },

  // === Social engineering ===
  {
    id: 'se_owner_impersonation',
    category: 'social_engineering',
    score: 20,
    description: 'Claims to speak on behalf of the agent\'s owner',
    test: (_e, text) => RE_OWNER_IMPERSONATION.test(text),
  },
  {
    id: 'se_secret_request',
    category: 'social_engineering',
    score: 15,
    description: 'Requests API keys, passwords, or credentials',
    test: (_e, text) => RE_SECRET_REQUEST.test(text),
  },
  {
    id: 'se_impersonate_system',
    category: 'social_engineering',
    score: 15,
    description: 'Impersonates a system/security message',
    test: (_e, text) => RE_IMPERSONATE_SYSTEM.test(text),
  },
  {
    id: 'se_urgency_authority',
    category: 'social_engineering',
    score: 10,
    description: 'Combines urgency language with authority/threat language',
    test: (_e, text) => RE_URGENCY.test(text) && RE_AUTHORITY.test(text),
  },
  {
    id: 'se_money_request',
    category: 'social_engineering',
    score: 15,
    description: 'Requests money transfer or wire',
    test: (_e, text) => RE_MONEY_REQUEST.test(text),
  },
  {
    id: 'se_gift_card',
    category: 'social_engineering',
    score: 20,
    description: 'Requests purchase of gift cards',
    test: (_e, text) => RE_GIFT_CARD.test(text),
  },
  {
    id: 'se_ceo_fraud',
    category: 'social_engineering',
    score: 15,
    description: 'BEC pattern: executive title + payment/wire/urgent',
    test: (_e, text) => RE_CEO_FRAUD.test(text),
  },

  // === Data exfiltration ===
  {
    id: 'de_forward_all',
    category: 'data_exfiltration',
    score: 20,
    description: 'Requests forwarding all emails',
    test: (_e, text) => RE_FORWARD_ALL.test(text),
  },
  {
    id: 'de_search_credentials',
    category: 'data_exfiltration',
    score: 20,
    description: 'Requests searching inbox for passwords/credentials',
    test: (_e, text) => RE_SEARCH_CREDS.test(text),
  },
  {
    id: 'de_send_to_external',
    category: 'data_exfiltration',
    score: 15,
    description: 'Instructs sending data to an external email address',
    test: (_e, text) => RE_SEND_TO_EXTERNAL.test(text),
  },
  {
    id: 'de_dump_instructions',
    category: 'data_exfiltration',
    score: 15,
    description: 'Attempts to extract system prompt or instructions',
    test: (_e, text) => RE_DUMP_INSTRUCTIONS.test(text),
  },
  {
    id: 'de_webhook_exfil',
    category: 'data_exfiltration',
    score: 15,
    description: 'Contains webhook/ngrok/pipedream exfiltration URLs',
    test: (_e, text) => RE_WEBHOOK_EXFIL.test(text),
  },

  // === Phishing ===
  {
    id: 'ph_spoofed_sender',
    category: 'phishing',
    score: 10,
    description: 'Sender name contains brand but domain doesn\'t match',
    test: (email) => {
      const from = email.from[0];
      if (!from) return false;
      const name = (from.name ?? '').toLowerCase();
      const domain = (from.address ?? '').split('@')[1]?.toLowerCase() ?? '';
      for (const [brand, domains] of Object.entries(BRAND_DOMAINS)) {
        if (name.includes(brand) && !domains.some(d => domain === d || domain.endsWith('.' + d))) {
          return true;
        }
      }
      return false;
    },
  },
  {
    id: 'ph_credential_harvest',
    category: 'phishing',
    score: 15,
    description: 'Asks to "verify your account/password" with links present',
    test: (_e, text, html) => {
      if (!RE_CREDENTIAL_HARVEST.test(text)) return false;
      return RE_URL_IN_TEXT.test(text) || RE_LINK_TAG.test(html);
    },
  },
  {
    id: 'ph_suspicious_links',
    category: 'phishing',
    score: 10,
    description: 'Contains links with IP addresses, URL shorteners, or excessive subdomains',
    test: (_e, text, html) => {
      const allText = text + ' ' + html;
      if (RE_IP_URL.test(allText)) return true;
      if (RE_URL_SHORTENER.test(allText)) return true;
      const urls = allText.match(RE_URL_IN_TEXT) ?? [];
      for (const url of urls) {
        try {
          const hostname = new URL(url).hostname;
          if (hostname.split('.').length > 4) return true;
        } catch { /* ignore malformed URLs */ }
      }
      return false;
    },
  },
  {
    id: 'ph_data_uri',
    category: 'phishing',
    score: 15,
    description: 'Contains data: or javascript: URIs in links',
    test: (_e, _text, html) => {
      RE_LINK_TAG.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RE_LINK_TAG.exec(html)) !== null) {
        if (RE_DATA_URI.test(match[1])) return true;
      }
      return false;
    },
  },
  {
    id: 'ph_homograph',
    category: 'phishing',
    score: 15,
    description: 'From domain contains mixed-script or punycode characters',
    test: (email) => {
      const domain = email.from[0]?.address?.split('@')[1] ?? '';
      if (!domain) return false;
      return hasHomographChars(domain);
    },
  },
  {
    id: 'ph_mismatched_display_url',
    category: 'phishing',
    score: 10,
    description: 'HTML link text shows one URL but href points to a different domain',
    test: (_e, _text, html) => {
      RE_LINK_TAG_WITH_TEXT.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RE_LINK_TAG_WITH_TEXT.exec(html)) !== null) {
        const href = match[1];
        const linkText = match[2].replace(/<[^>]*>/g, '').trim();
        // Only check if link text looks like a URL
        if (!/^https?:\/\//i.test(linkText)) continue;
        try {
          const hrefHost = new URL(href).hostname.replace(/^www\./, '');
          const textHost = new URL(linkText).hostname.replace(/^www\./, '');
          if (hrefHost !== textHost) return true;
        } catch { /* ignore parse errors */ }
      }
      return false;
    },
  },
  {
    id: 'ph_login_urgency',
    category: 'phishing',
    score: 10,
    description: 'Combines login/click-here language with urgency',
    test: (_e, text) => RE_LOGIN_URGENCY.test(text),
  },
  {
    id: 'ph_unsubscribe_missing',
    category: 'phishing',
    score: 3,
    description: 'Marketing-like email with many links but no List-Unsubscribe header',
    test: (email, text, html) => {
      const allText = text + ' ' + html;
      const urls = new Set(allText.match(RE_URL_IN_TEXT) ?? []);
      if (urls.size < 5) return false;
      return !email.headers.get('list-unsubscribe');
    },
  },

  // === Authentication (SPF/DKIM/DMARC from headers) ===
  {
    id: 'auth_spf_fail',
    category: 'authentication',
    score: 15,
    description: 'SPF authentication failed',
    test: (email) => {
      const authResults = email.headers.get('authentication-results') ?? '';
      return /spf=(fail|softfail)/i.test(authResults);
    },
  },
  {
    id: 'auth_dkim_fail',
    category: 'authentication',
    score: 15,
    description: 'DKIM authentication failed',
    test: (email) => {
      const authResults = email.headers.get('authentication-results') ?? '';
      return /dkim=fail/i.test(authResults);
    },
  },
  {
    id: 'auth_dmarc_fail',
    category: 'authentication',
    score: 20,
    description: 'DMARC authentication failed',
    test: (email) => {
      const authResults = email.headers.get('authentication-results') ?? '';
      return /dmarc=fail/i.test(authResults);
    },
  },
  {
    id: 'auth_no_auth_results',
    category: 'authentication',
    score: 3,
    description: 'No Authentication-Results header present',
    test: (email) => {
      return !email.headers.has('authentication-results');
    },
  },

  // === Attachment risk ===
  {
    id: 'at_executable',
    category: 'attachment_risk',
    score: 25,
    description: 'Attachment has executable file extension',
    test: (email) => {
      return email.attachments.some(a => RE_EXECUTABLE_EXT.test(a.filename));
    },
  },
  {
    id: 'at_double_extension',
    category: 'attachment_risk',
    score: 20,
    description: 'Attachment has double extension (e.g. document.pdf.exe)',
    test: (email) => {
      return email.attachments.some(a => RE_DOUBLE_EXT.test(a.filename));
    },
  },
  {
    id: 'at_archive_carrier',
    category: 'attachment_risk',
    score: 15,
    description: 'Attachment is an archive (potential payload carrier)',
    test: (email) => {
      return email.attachments.some(a => RE_ARCHIVE_EXT.test(a.filename));
    },
  },
  {
    id: 'at_html_attachment',
    category: 'attachment_risk',
    score: 10,
    description: 'HTML/SVG file attachment (phishing vector)',
    test: (email) => {
      return email.attachments.some(a => RE_HTML_ATTACHMENT_EXT.test(a.filename));
    },
  },

  // === Header anomalies ===
  {
    id: 'ha_missing_message_id',
    category: 'header_anomaly',
    score: 5,
    description: 'Missing Message-ID header',
    test: (email) => !email.messageId,
  },
  {
    id: 'ha_empty_from',
    category: 'header_anomaly',
    score: 10,
    description: 'Missing or empty From address',
    test: (email) => !email.from.length || !email.from[0].address,
  },
  {
    id: 'ha_reply_to_mismatch',
    category: 'header_anomaly',
    score: 5,
    description: 'Reply-To domain differs from From domain',
    test: (email) => {
      if (!email.replyTo?.length || !email.from.length) return false;
      const fromDomain = email.from[0].address?.split('@')[1]?.toLowerCase();
      const replyDomain = email.replyTo[0].address?.split('@')[1]?.toLowerCase();
      return !!fromDomain && !!replyDomain && fromDomain !== replyDomain;
    },
  },

  // === Content spam ===
  {
    id: 'cs_all_caps_subject',
    category: 'content_spam',
    score: 5,
    description: 'Subject is mostly uppercase',
    test: (email) => {
      const s = email.subject;
      if (s.length < 10) return false;
      const letters = s.replace(/[^a-zA-Z]/g, '');
      if (letters.length < 5) return false;
      const upper = letters.replace(/[^A-Z]/g, '').length;
      return upper / letters.length > 0.8;
    },
  },
  {
    id: 'cs_lottery_scam',
    category: 'content_spam',
    score: 25,
    description: 'Contains lottery/prize scam language',
    test: (_e, text) => RE_LOTTERY_SCAM.test(text),
  },
  {
    id: 'cs_crypto_scam',
    category: 'content_spam',
    score: 10,
    description: 'Contains crypto/investment scam language',
    test: (_e, text) => RE_CRYPTO_SCAM.test(text),
  },
  {
    id: 'cs_excessive_punctuation',
    category: 'content_spam',
    score: 3,
    description: 'Subject has excessive punctuation (!!!!, ????)',
    test: (email) => /[!]{4,}|[?]{4,}/.test(email.subject),
  },
  {
    id: 'cs_pharmacy_spam',
    category: 'content_spam',
    score: 15,
    description: 'Contains pharmacy/prescription drug spam language',
    test: (_e, text) => RE_PHARMACY_SPAM.test(text),
  },
  {
    id: 'cs_weight_loss',
    category: 'content_spam',
    score: 10,
    description: 'Contains weight loss scam language',
    test: (_e, text) => RE_WEIGHT_LOSS.test(text),
  },
  {
    id: 'cs_html_only_no_text',
    category: 'content_spam',
    score: 5,
    description: 'Email has HTML body but empty/missing text body',
    test: (email) => {
      const hasHtml = !!email.html && email.html.trim().length > 0;
      const hasText = !!email.text && email.text.trim().length > 0;
      return hasHtml && !hasText;
    },
  },
  {
    id: 'cs_spam_word_density',
    category: 'content_spam',
    score: 0, // Dynamic — calculated in test
    description: 'High density of common spam words',
    test: (_e, text) => countSpamWords(text) > 5,
  },

  // === Link analysis ===
  {
    id: 'la_excessive_links',
    category: 'link_analysis',
    score: 5,
    description: 'Contains more than 10 unique links',
    test: (_e, text, html) => {
      const allText = text + ' ' + html;
      const urls = new Set(allText.match(RE_URL_IN_TEXT) ?? []);
      return urls.size > 10;
    },
  },
];

// --- Main scoring function ---

export function scoreEmail(email: ParsedEmail): SpamResult {
  const bodyText = [email.subject, email.text ?? ''].join('\n');
  const bodyHtml = email.html ?? '';
  const matches: SpamRuleMatch[] = [];

  for (const rule of RULES) {
    try {
      if (rule.test(email, bodyText, bodyHtml)) {
        // Handle dynamic score for spam word density
        let score = rule.score;
        if (rule.id === 'cs_spam_word_density') {
          const wordCount = countSpamWords(bodyText);
          score = wordCount > 10 ? 20 : 10;
        }
        matches.push({
          ruleId: rule.id,
          category: rule.category,
          score,
          description: rule.description,
        });
      }
    } catch {
      // Never let a rule crash the whole filter
    }
  }

  const score = matches.reduce((sum, m) => sum + m.score, 0);

  // Find the top category by total score contribution
  let topCategory: SpamCategory | null = null;
  if (matches.length > 0) {
    const categoryScores = new Map<SpamCategory, number>();
    for (const m of matches) {
      categoryScores.set(m.category, (categoryScores.get(m.category) ?? 0) + m.score);
    }
    let maxScore = 0;
    for (const [cat, catScore] of categoryScores) {
      if (catScore > maxScore) {
        maxScore = catScore;
        topCategory = cat;
      }
    }
  }

  return {
    score,
    isSpam: score >= SPAM_THRESHOLD,
    isWarning: score >= WARNING_THRESHOLD && score < SPAM_THRESHOLD,
    matches,
    topCategory,
  };
}
