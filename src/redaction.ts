// Pattern-based secret redaction for room message content.
//
// This runs on every write path before content is persisted, replayed over
// SSE, or returned via catch_up. See docs/design-principles.md §3a:
// redaction is an allowlist/pattern-based filter that must apply before the
// transcript ever sees the raw content.
//
// Current pattern set is conservative — we'd rather miss an exotic secret
// than corrupt benign text (commit hashes, UUIDs, base64 payloads that
// happen to look secret-ish). New patterns should be added with tests.

export interface RedactionHit {
  type: string;
  start: number;
  end: number;
  matched: string;
}

export interface RedactionResult {
  content: string;
  hits: RedactionHit[];
}

interface PatternDef {
  type: string;
  re: RegExp;
}

// Order matters: PEM blocks first because they can contain content that
// would otherwise match narrower patterns line-by-line.
const PATTERNS: PatternDef[] = [
  {
    type: "pem-block",
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  },
  {
    type: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    type: "anthropic-key",
    re: /\bsk-ant-(?:api\d\d|admin\d\d)-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "openai-key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "github-token",
    re: /\b(?:ghp|ghs|gho|ghr|ghu)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    type: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    type: "google-api-key",
    re: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    type: "slack-token",
    re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    type: "bearer-token",
    re: /\b[Bb]earer\s+[A-Za-z0-9_.\-+/=]{16,}\b/g,
  },
  {
    // An "Authorization: ..." header line. Captures the whole line so the
    // credential (whatever scheme) is replaced together with the header name.
    type: "auth-header",
    re: /^[ \t]*Authorization[ \t]*:[ \t]*[^\n\r]+$/gmi,
  },
];

export function redactSecrets(raw: string): RedactionResult {
  if (!raw || raw.length < 16) {
    // Shortest credential pattern we catch is ~16 chars; skip tiny messages.
    return { content: raw, hits: [] };
  }

  const hits: RedactionHit[] = [];
  for (const pattern of PATTERNS) {
    for (const match of raw.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      hits.push({
        type: pattern.type,
        start: match.index,
        end: match.index + match[0].length,
        matched: match[0],
      });
    }
  }

  if (hits.length === 0) return { content: raw, hits: [] };

  // Sort by start ascending; resolve overlaps by keeping the earliest/longest
  // so PEM blocks swallow nested hits and nothing double-redacts.
  hits.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const merged: RedactionHit[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.start < last.end) {
      // overlapping — skip; the earlier/longer wins.
      continue;
    }
    merged.push(hit);
  }

  // Rebuild content with replacements, walking hits in order.
  const out: string[] = [];
  let cursor = 0;
  for (const hit of merged) {
    if (hit.start > cursor) out.push(raw.slice(cursor, hit.start));
    out.push(`[REDACTED:${hit.type}]`);
    cursor = hit.end;
  }
  if (cursor < raw.length) out.push(raw.slice(cursor));

  return { content: out.join(""), hits: merged };
}
