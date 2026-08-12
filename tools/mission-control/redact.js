/**
 * Redaction utilities shared by incident evidence storage and the exported
 * Markdown/JSON evidence packs.
 *
 * These patterns are defense-in-depth: kubectl/az CLI output should not
 * normally contain live secrets, but ConfigMaps, connection strings, and
 * ad-hoc debug output sometimes do. Anything that looks like a credential is
 * replaced before it is ever written to disk or exported.
 */

const SECRET_PATTERNS = [
  // Authorization: Bearer <token>
  { name: 'bearer-token', regex: /\b(Bearer\s+)[A-Za-z0-9\-_.~+/=]{8,}/gi, replace: '$1[REDACTED]' },
  // key=value style secrets (connection strings, config pairs)
  { name: 'key-value-secret', regex: /\b((?:Account|Shared\s?Access|Primary|Secondary)?\s?(?:Key|Secret|Password|Pwd|Token|ApiKey|Api-Key)s?)\s*[:=]\s*['"]?[^\s'";,]{4,}['"]?/gi, replace: '$1=[REDACTED]' },
  // JWTs
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replace: '[REDACTED-JWT]' },
  // userinfo embedded in URLs (https://user:pass@host/...)
  { name: 'url-userinfo', regex: /(https?:\/\/)[^/\s:@]+:[^/\s:@]+@/gi, replace: '$1[REDACTED]@' },
  // Azure Storage connection strings
  { name: 'azure-storage-conn-string', regex: /(DefaultEndpointsProtocol=https?;[^\n'"]*?AccountKey=)[^;\n'"]+/gi, replace: '$1[REDACTED]' },
  // Generic long base64/hex blobs that look like keys (32+ chars, no spaces) following a "key"/"secret" label
  { name: 'labeled-hex-blob', regex: /\b((?:client[-_]?secret|subscription[-_]?key|access[-_]?token))\s*[:=]\s*[A-Za-z0-9+/=_-]{16,}/gi, replace: '$1=[REDACTED]' },
];

/** Redact a single string value using all known secret patterns. */
function redactText(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.regex, pattern.replace);
  }
  return out;
}

/** Recursively redact strings inside arbitrary JSON-shaped values. */
function redactDeep(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactDeep(val, seen);
    }
    return out;
  }
  return value;
}

module.exports = {
  SECRET_PATTERNS,
  redactText,
  redactDeep,
};
