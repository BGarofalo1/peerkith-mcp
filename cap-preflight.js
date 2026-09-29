/**
 * Cap bind preflight — fail-closed hire-and-cap wrapper around checkCap.
 * SoT: functions/_lib/cap-preflight.js (symlinked / copied into mcp + site).
 *
 * Input:  { cap, action, card?, secret?, ttlSec? }
 * Output: { allow, reason, matched, bound: true, cap_token?, cap_token_exp? }
 *
 * Rules:
 *   - checkCap throws OR returns non-allow → deny (allow:false)
 *   - empty/missing cap already fail-closed in runtime
 *   - always sets bound:true so callers can tell this is the bind door
 *   - on allow + secret: mint cap_token (for MCP local / smoke)
 *   - spend/send MUST present token to POST /cap-token-check (or local
 *     verifyCapToken) before hop — wall text alone is not the token
 *
 * Async (Web Crypto). Same decision logic bots should use before spend/send.
 */
import { checkCap } from "./cap-runtime.js";
import { issueCapToken } from "./cap-token.js";

/**
 * @param {{ cap?: string, action?: string, card?: string, secret?: string, ttlSec?: number }} input
 * @returns {Promise<{ allow: boolean, reason: string, matched: string, bound: true, cap_token?: string, cap_token_exp?: number }>}
 */
export async function capPreflight(input = {}) {
  const cap = typeof input?.cap === "string" ? input.cap : "";
  const action = typeof input?.action === "string" ? input.action : "";
  const card =
    typeof input?.card === "string" && input.card.trim()
      ? input.card.trim()
      : undefined;
  const secret = typeof input?.secret === "string" ? input.secret : "";

  try {
    const result = checkCap(cap, action);
    if (!result || result.allow !== true) {
      return {
        allow: false,
        reason: (result && result.reason) || "cap denied",
        matched: (result && result.matched) != null ? result.matched : "",
        bound: true,
      };
    }
    const out = {
      allow: true,
      reason: result.reason,
      matched: result.matched,
      bound: true,
    };
    if (secret) {
      const issued = await issueCapToken({
        secret,
        action,
        card,
        ttlSec: input.ttlSec,
      });
      if (issued) {
        out.cap_token = issued.token;
        out.cap_token_exp = issued.exp;
      }
    }
    return out;
  } catch (err) {
    return {
      allow: false,
      reason: `preflight error: ${err && err.message ? err.message : String(err)}`,
      matched: "",
      bound: true,
    };
  }
}

export default capPreflight;
