// Every string the memory layer writes to disk passes through here first.
//
// Two jobs: mask credentials, and neutralise text that tries to act as an instruction or to
// forge the <retrieved-memory> wrapper when it is later injected into another engine's prompt.

const SECRET_PATTERNS = [
  // Anthropic / OpenAI style keys.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  // Telegram bot token: numeric bot id, colon, 35-char secret.
  [/\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g, '<telegram-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\baim_[A-Za-z0-9]{16,}/g, 'aim_***'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>'],
  // .env style assignments whose name says it holds a secret.
  [/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|AUTH|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"'#]{4,}\2/gim, '$1$2***$2'],
  // Credentials embedded in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@']
];

// Text that addresses the reading model instead of describing work. Matched spans are kept in the
// stored record (so a reviewer can see them) but replaced before injection.
const INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?|context)\b[^\n]*/gi,
  /^\s*(?:system|assistant|developer)\s*:[^\n]*/gim,
  /<\|(?:im_start|im_end|system|endoftext)\|>/gi,
  /<\/?\s*(?:system|instructions?|developer)\s*>/gi
];

const FORGED_WRAPPER = /<\s*(\/?)\s*retrieved-memory\b[^>]*>/gi;

export function maskSecrets(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// Cuts at a UTF-8 boundary so the result never ends in half a character.
export function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

// Masks secrets, drops control characters and bounds the size. Use for every persisted string.
export function sanitizeText(value, { maxBytes = 65536 } = {}) {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  text = maskSecrets(text);
  const cut = truncateBytes(text, maxBytes);
  return cut.truncated ? cut.text + '\n[truncated]' : cut.text;
}

export function findInstructionLike(text) {
  const hits = [];
  for (const pattern of INSTRUCTION_PATTERNS) {
    for (const match of String(text).matchAll(pattern)) hits.push(match[0].trim());
  }
  if (FORGED_WRAPPER.test(String(text))) hits.push('<retrieved-memory>');
  FORGED_WRAPPER.lastIndex = 0;
  return hits;
}

// Prepares stored text for injection: instruction-like spans are replaced and any attempt to
// open or close the memory wrapper is escaped so it cannot end the untrusted block early.
export function neutralizeForInjection(text) {
  let out = String(text);
  for (const pattern of INSTRUCTION_PATTERNS) out = out.replace(pattern, '[flagged instruction-like text removed]');
  out = out.replace(FORGED_WRAPPER, (_, slash) => `&lt;${slash}retrieved-memory&gt;`);
  return out;
}

// Recursively sanitises every string inside a JSON-able value.
export function sanitizeValue(value, options) {
  if (typeof value === 'string') return sanitizeText(value, options);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[sanitizeText(key, { maxBytes: 256 })] = sanitizeValue(item, options);
    return out;
  }
  return value;
}
