// Prompts are pasted by people and often carry whatever was on their screen,
// so anything stored from them is checked for credentials first. A match is
// rejected instead of masked: a silently edited prompt would no longer be the
// quote the study claims it is.

export interface SecretFinding {
  rule: string;
}

const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { rule: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "Telegram bot token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { rule: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "provider secret key", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/ },
  { rule: "bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  // A git SHA-1 is 40 hex characters and has to stay quotable in `refs`.
  { rule: "long hexadecimal secret", pattern: /\b[0-9a-f]{48,}\b/i },
  {
    rule: "high-entropy token",
    pattern: /\b(?=[A-Za-z0-9_-]{32,}\b)(?=\S*[a-z])(?=\S*[A-Z])(?=\S*\d)[A-Za-z0-9_-]{32,}\b/,
  },
];

const ASSIGNMENT =
  /\b(?:secret|token|password|passwd|api[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"',;]{12,})/gi;

/** `${VAR}`, `$VAR`, `VAR_NAME` and masked values name a secret without revealing it. */
function namesAVariable(value: string): boolean {
  return /^\$?\{?[A-Z][A-Z0-9_]*\}?$/.test(value) || /^[*•x]+$/i.test(value);
}

export function findSecrets(text: string): SecretFinding[] {
  const found = RULES.filter(({ pattern }) => pattern.test(text)).map(({ rule }) => ({ rule }));
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (!namesAVariable(match[1] ?? "")) {
      found.push({ rule: "credential assignment" });
      break;
    }
  }
  return found;
}
