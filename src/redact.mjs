// Adapted from keepitmovin's src/util/redact.ts
// (https://github.com/garrettsiegel/keepitmovin, MIT, Copyright (c) 2026 Garrett Siegel; see NOTICE).
//
// Best-effort secret redaction for everything this project persists or serves.
// Defense in depth, not a guarantee: novel or truncated secrets can slip
// through, so the store is still treated as sensitive.

// Ordered most-specific first so a token isn't partially matched by a broader rule.
const RULES = [
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-token", pattern: /\bxox[bpars]-[A-Za-z0-9-]{10,}/g },
  { kind: "google-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: "groq-key", pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
  { kind: "xai-key", pattern: /\bxai-[A-Za-z0-9]{20,}/g },
  { kind: "openrouter-key", pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}/g },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: "$1[REDACTED:url-credentials]@"
  },
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g
  },
  // Last resort: an assignment whose NAME says secret. Keeps the name, drops the value.
  {
    kind: "secret-assignment",
    pattern:
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)\s*[=:]\s*)(?!\[REDACTED)["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
    replace: "$1[REDACTED:secret-assignment]"
  }
];

/** Replaces recognizable secrets with `[REDACTED:<kind>]`. Pure and idempotent. */
export const redactSecrets = (text) =>
  RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replace ?? `[REDACTED:${rule.kind}]`), text);

/** Redacts, then truncates, every string; caps arrays and nesting. */
export const sanitize = (value, maxChars = 600, depth = 0) => {
  if (typeof value === "string") {
    const clean = redactSecrets(value);
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}…[truncated ${clean.length - maxChars} chars]` : clean;
  }
  if (depth > 6) return "[nested too deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, maxChars, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, sanitize(v, maxChars, depth + 1)]));
  }
  return value;
};
