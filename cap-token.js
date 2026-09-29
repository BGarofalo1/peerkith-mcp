/**
 * Peerkith Cap Token Day-1 — short-lived HMAC capability token.
 *
 * Honesty: personal protocol experiment for Peerkith-hosted rails + MCP callers
 * that present this token. Not wallets, not third-party runtimes, not
 * infrastructure-grade (no attenuation / revocation list Day-1).
 *
 * Token format (compact string):
 *   v1.<base64url(payload)>.<base64url(mac)>
 * where payload UTF-8 is:
 *   {card}|{action}|{exp}|{nonce}
 *   - card empty/missing → "-"
 *   - exp = unix seconds (TTL default ≤ 900)
 *   - nonce = 16 random bytes hex
 * and mac = HMAC-SHA256(secret, "v1|" + payload)
 * i.e. signed material is: v1|{card}|{action}|{exp}|{nonce}
 *
 * SoT: functions/_lib/cap-token.js (Worker + Node; Web Crypto subtle).
 */
const DEFAULT_TTL_SEC = 900;
const MAX_TTL_SEC = 900;
const VERSION = "v1";

function b64urlEncode(bytes) {
  let bin = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(u8).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s) {
  if (typeof s !== "string" || !s) return null;
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

function utf8(s) {
  return new TextEncoder().encode(s);
}

function cardSlot(card) {
  if (typeof card !== "string" || !card.trim()) return "-";
  return card.trim();
}

function normalizeTtl(ttlSec) {
  const n = Number(ttlSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SEC;
  return Math.min(Math.floor(n), MAX_TTL_SEC);
}

function randomNonceHex() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function hmacSign(secret, message) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(message));
  return new Uint8Array(sig);
}

function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Issue a short-lived cap token.
 * @param {{ secret?: string, action: string, card?: string, ttlSec?: number }} opts
 * @returns {Promise<{ token: string, exp: number } | null>}
 *   null if secret missing/empty (fail closed — caller must not invent allow).
 */
export async function issueCapToken({ secret, action, card, ttlSec } = {}) {
  if (typeof secret !== "string" || !secret) return null;
  if (typeof action !== "string" || !action.trim()) return null;

  const exp = Math.floor(Date.now() / 1000) + normalizeTtl(ttlSec);
  const nonce = randomNonceHex();
  const payload = `${cardSlot(card)}|${action.trim()}|${exp}|${nonce}`;
  const macInput = `${VERSION}|${payload}`;
  const mac = await hmacSign(secret, macInput);
  const token = `${VERSION}.${b64urlEncode(utf8(payload))}.${b64urlEncode(mac)}`;
  return { token, exp };
}

/**
 * Verify a cap token for a requested action (and optional card bind).
 * @param {{ secret?: string, token?: string, action?: string, card?: string }} opts
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function verifyCapToken({ secret, token, action, card } = {}) {
  if (typeof secret !== "string" || !secret) {
    return { allow: false, reason: "missing secret" };
  }
  if (typeof token !== "string" || !token.trim()) {
    return { allow: false, reason: "missing token" };
  }
  if (typeof action !== "string" || !action.trim()) {
    return { allow: false, reason: "missing action" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { allow: false, reason: "malformed token" };
  }

  const payloadBytes = b64urlDecode(parts[1]);
  const macBytes = b64urlDecode(parts[2]);
  if (!payloadBytes || !macBytes || macBytes.length !== 32) {
    return { allow: false, reason: "malformed token" };
  }

  const payload = new TextDecoder().decode(payloadBytes);
  const fields = payload.split("|");
  if (fields.length !== 4) {
    return { allow: false, reason: "malformed payload" };
  }

  const [tokCard, tokAction, expStr, nonce] = fields;
  if (!nonce || !/^[0-9a-f]+$/i.test(nonce)) {
    return { allow: false, reason: "malformed nonce" };
  }

  const macInput = `${VERSION}|${payload}`;
  let expected;
  try {
    expected = await hmacSign(secret, macInput);
  } catch {
    return { allow: false, reason: "hmac error" };
  }
  if (!timingSafeEqual(macBytes, expected)) {
    return { allow: false, reason: "bad mac" };
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { allow: false, reason: "bad exp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now >= exp) {
    return { allow: false, reason: "expired" };
  }

  if (tokAction !== action.trim()) {
    return { allow: false, reason: "action mismatch" };
  }

  // Card match only if embedded in token (non-"-"): caller must present same card.
  if (tokCard !== "-") {
    if (cardSlot(card) !== tokCard) {
      return { allow: false, reason: "card mismatch" };
    }
  }

  return { allow: true, reason: "ok" };
}

export const CAP_TOKEN_TTL_SEC = DEFAULT_TTL_SEC;
export const CAP_TOKEN_FORMAT = "v1.<base64url(payload)>.<base64url(mac)>";

export default { issueCapToken, verifyCapToken };
