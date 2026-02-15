import type { ParsedEmail } from './types.js';

// --- Types ---

export interface SanitizeDetection {
  type: string;
  description: string;
  count: number;
}

export interface SanitizeResult {
  text: string;
  html: string;
  detections: SanitizeDetection[];
  wasModified: boolean;
}

// --- Invisible Unicode ranges ---

// U+E0001-E007F (Tags block - used for hidden text injection)
const RE_TAG_BLOCK = /[\u{E0001}-\u{E007F}]/gu;
// Zero-width characters
const RE_ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
// Bidi control characters
const RE_BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// Soft hyphen
const RE_SOFT_HYPHEN = /\u00AD/g;
// Word joiner
const RE_WORD_JOINER = /\u2060/g;

// --- Hidden HTML patterns ---

// Elements with display:none, visibility:hidden, font-size:0, opacity:0
const RE_HIDDEN_STYLE = /<[^>]+style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|%)?|opacity\s*:\s*0)(?:\s*;|\s*["'])[^>]*>[\s\S]*?<\/[^>]+>/gi;
// White-on-white text (color:white/fff on background:white/fff, or same color patterns)
const RE_WHITE_ON_WHITE = /<[^>]+style\s*=\s*["'][^"']*color\s*:\s*(?:white|#fff(?:fff)?|rgb\(255\s*,\s*255\s*,\s*255\))[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
// Off-screen positioned elements
const RE_OFFSCREEN = /<[^>]+style\s*=\s*["'][^"']*(?:position\s*:\s*(?:absolute|fixed)[^"']*(?:left|top)\s*:\s*-\d{4,}|clip\s*:\s*rect\(0)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
// Script tags
const RE_SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
// Data URIs in attributes
const RE_DATA_URI_ATTR = /\b(?:src|href|action)\s*=\s*["'](?:data:text\/html|javascript:)[^"']*["']/gi;
// HTML comments with suspicious content
const RE_SUSPICIOUS_COMMENT = /<!--[\s\S]*?(?:ignore|system|instruction|prompt|inject)[\s\S]*?-->/gi;
// Zero-size iframes
const RE_HIDDEN_IFRAME = /<iframe\b[^>]*(?:width\s*=\s*["']?0|height\s*=\s*["']?0|style\s*=\s*["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/iframe>/gi;

// --- Normalize patterns ---

const RE_EXCESSIVE_NEWLINES = /\n{3,}/g;

// --- Main sanitizer function ---

export function sanitizeEmail(email: ParsedEmail): SanitizeResult {
  const detections: SanitizeDetection[] = [];
  let textModified = false;
  let htmlModified = false;

  let text = email.text ?? '';
  let html = email.html ?? '';

  // --- Strip invisible Unicode from text ---
  text = stripInvisibleUnicode(text, detections, 'text');
  // --- Strip invisible Unicode from HTML ---
  html = stripInvisibleUnicode(html, detections, 'html');

  // --- Strip hidden HTML elements ---
  html = stripHiddenHtml(html, detections);

  // --- Normalize text ---
  const normalizedText = text.replace(RE_EXCESSIVE_NEWLINES, '\n\n').trim();
  if (normalizedText !== text) {
    text = normalizedText;
  }

  const normalizedHtml = html.trim();
  if (normalizedHtml !== html) {
    html = normalizedHtml;
  }

  textModified = text !== (email.text ?? '');
  htmlModified = html !== (email.html ?? '');

  return {
    text,
    html,
    detections,
    wasModified: textModified || htmlModified,
  };
}

function stripInvisibleUnicode(
  input: string,
  detections: SanitizeDetection[],
  source: string,
): string {
  let result = input;

  const patterns: Array<{ re: RegExp; type: string; desc: string }> = [
    { re: RE_TAG_BLOCK, type: `invisible_tags_${source}`, desc: `Unicode tag characters (U+E0001-E007F) in ${source}` },
    { re: RE_ZERO_WIDTH, type: `zero_width_${source}`, desc: `Zero-width characters in ${source}` },
    { re: RE_BIDI, type: `bidi_control_${source}`, desc: `Bidi control characters in ${source}` },
    { re: RE_SOFT_HYPHEN, type: `soft_hyphen_${source}`, desc: `Soft hyphens in ${source}` },
    { re: RE_WORD_JOINER, type: `word_joiner_${source}`, desc: `Word joiners in ${source}` },
  ];

  for (const { re, type, desc } of patterns) {
    const matches = result.match(re);
    if (matches && matches.length > 0) {
      detections.push({ type, description: desc, count: matches.length });
      result = result.replace(re, '');
    }
  }

  return result;
}

function stripHiddenHtml(
  input: string,
  detections: SanitizeDetection[],
): string {
  let result = input;

  const patterns: Array<{ re: RegExp; type: string; desc: string }> = [
    { re: RE_HIDDEN_STYLE, type: 'hidden_css', desc: 'Elements with display:none, visibility:hidden, font-size:0, or opacity:0' },
    { re: RE_WHITE_ON_WHITE, type: 'white_on_white', desc: 'White-on-white or same-color hidden text' },
    { re: RE_OFFSCREEN, type: 'offscreen', desc: 'Off-screen positioned elements' },
    { re: RE_SCRIPT, type: 'script_tags', desc: 'Script tags' },
    { re: RE_DATA_URI_ATTR, type: 'data_uri', desc: 'Suspicious data: or javascript: URIs in attributes' },
    { re: RE_SUSPICIOUS_COMMENT, type: 'suspicious_comment', desc: 'HTML comments containing injection-related keywords' },
    { re: RE_HIDDEN_IFRAME, type: 'hidden_iframe', desc: 'Zero-size or hidden iframes' },
  ];

  for (const { re, type, desc } of patterns) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    const matches = result.match(re);
    if (matches && matches.length > 0) {
      detections.push({ type, description: desc, count: matches.length });
      re.lastIndex = 0;
      result = result.replace(re, '');
    }
  }

  return result;
}
