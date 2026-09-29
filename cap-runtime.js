/**
 * Peerkith cap-runtime v0 — pure ALLOW/DENY against a published cap string.
 * Shared by Worker (/cap-check) and Node (MCP, smoke). Zero deps.
 * Canonical path: functions/_lib/cap-runtime.js (symlinked into mcp/ + site/).
 *
 * Vocabulary (machine-checkable subset of free-text `cap`):
 *   deny_spend — refuse spend (also: "no spend", "don't spend", "do not spend")
 *   deny_send  — refuse send  (also: "no send", "don't send", "do not send", "no outbound")
 *   read_only  — only allow read (also: "read-only", "read only")
 *   allow      — explicit allow token (still loses to a matching deny / read_only)
 *
 * Missing / empty / whitespace-only cap → DENY all actions (matched:"missing")
 *
 * Unknown free-text (no vocabulary match):
 *   spend|send|write → DENY (honest default for dangerous)
 *   read|other → ALLOW matched:"unknown"
 *
 * Match rules (case-insensitive; word-ish boundaries):
 *   deny_spend ← /\bdeny[_-\s]?spend\b|\bno\s+spend\b|\bdon'?t\s+spend\b|\bdo\s+not\s+spend\b/
 *   deny_send  ← /\bdeny[_-\s]?send\b|\bno\s+send\b|\bno\s+outbound\b|\bdon'?t\s+send\b|\bdo\s+not\s+send\b/
 *   read_only  ← /\bread[_-\s]?only\b/
 *   allow      ← /\ballow\b/
 * Example: "read-only cite; no spend" → [read_only, deny_spend]
 */

export const ACTIONS = ["spend", "send", "read", "write", "other"];
export const VOCAB = ["deny_spend", "deny_send", "read_only", "allow"];

/** Unknown-cap actions that must DENY. */
const UNKNOWN_DENY = new Set(["spend", "send", "write"]);

const PATTERNS = [
  { token: "deny_spend", re: /\bdeny[_-\s]?spend\b|\bno\s+spend\b|\bdon'?t\s+spend\b|\bdo\s+not\s+spend\b/i },
  { token: "deny_send", re: /\bdeny[_-\s]?send\b|\bno\s+send\b|\bno\s+outbound\b|\bdon'?t\s+send\b|\bdo\s+not\s+send\b/i },
  { token: "read_only", re: /\bread[_-\s]?only\b/i },
  { token: "allow", re: /\ballow\b/i },
];

/**
 * Parse free-text cap into matched vocabulary tokens (deduped, stable order).
 * @param {string} cap
 * @returns {string[]}
 */
export function parseCap(cap) {
  if (typeof cap !== "string" || !cap.trim()) return [];
  const found = [];
  for (const { token, re } of PATTERNS) {
    if (re.test(cap) && !found.includes(token)) found.push(token);
  }
  return found;
}

/**
 * Check one action against a cap string.
 * @param {string} cap
 * @param {string} action  one of ACTIONS
 * @returns {{ allow: boolean, reason: string, matched: string }}
 */
export function checkCap(cap, action) {
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    return {
      allow: false,
      reason: `action must be one of: ${ACTIONS.join("|")}`,
      matched: "",
    };
  }

  if (typeof cap !== "string" || !cap.trim()) {
    return {
      allow: false,
      reason: "missing cap; deny all",
      matched: "missing",
    };
  }

  const tokens = parseCap(cap);
  const matched = tokens.length ? tokens.join(",") : "unknown";

  if (tokens.length === 0) {
    if (UNKNOWN_DENY.has(action)) {
      return {
        allow: false,
        reason: "unknown cap; deny dangerous by default",
        matched: "unknown",
      };
    }
    return {
      allow: true,
      reason: "unknown cap; allow read/other",
      matched: "unknown",
    };
  }

  if (tokens.includes("deny_spend") && action === "spend") {
    return { allow: false, reason: "cap denies spend", matched: "deny_spend" };
  }
  if (tokens.includes("deny_send") && action === "send") {
    return { allow: false, reason: "cap denies send", matched: "deny_send" };
  }
  if (tokens.includes("read_only") && action !== "read") {
    return { allow: false, reason: "cap is read_only", matched: "read_only" };
  }

  const primary = tokens.includes("allow")
    ? "allow"
    : tokens.includes("read_only")
      ? "read_only"
      : tokens[0];

  return {
    allow: true,
    reason: tokens.includes("read_only")
      ? "cap read_only allows read"
      : "cap allows action",
    matched: primary,
  };
}

export default checkCap;
