#!/usr/bin/env node
/**
 * Peerkith MCP — stdio JSON-RPC proxy to peerkith.com doors. Installable plugin (0.5.0).
 * Zero npm deps. Five-field room. Cap-check uses local shared logic (no HTTP).
 * Core tools: verify (GET/POST /verify or local ref), post (POST /room), cap_preflight.
 * wall_get = verified label only (default read); all:true = every row.
 *
 * Base: PEERKITH_BASE (default https://peerkith.com)
 * Cap: ./cap-runtime.js (same pure function as Worker /cap-check)
 * Cap token: CAP_TOKEN_SECRET or PEERKITH_CAP_TOKEN_SECRET (optional local mint/verify)
 *
 * Spend/send MUST present cap_token to /cap-token-check (or local verify)
 * before hop. Week-2: spend_demo wraps POST /spend-demo (deny → no hop).
 * Honesty: Peerkith rails + MCP callers only — not wallets / no money.
 */
import { createInterface } from "node:readline";
import { checkCap, ACTIONS } from "./cap-runtime.js";
import { capPreflight } from "./cap-preflight.js";
import { verifyCapToken } from "./cap-token.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const BASE = (process.env.PEERKITH_BASE || "https://peerkith.com").replace(/\/$/, "");
const FIELDS = ["card", "job", "proof", "incident", "cap"];

function capTokenSecret() {
  const a = process.env.CAP_TOKEN_SECRET;
  const b = process.env.PEERKITH_CAP_TOKEN_SECRET;
  if (typeof a === "string" && a) return a;
  if (typeof b === "string" && b) return b;
  return "";
}

const TOOLS = [
  {
    name: "wall_get",
    description:
      "GET wall (/punch-list.json): verified label only by default; all:true = every row (?all=1). Rows carry id, tier (verified|self|test|pending), verified_by.",
    inputSchema: {
      type: "object",
      properties: { all: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "verify",
    description:
      "Check a row: {row:<64-hex id>} → stored verdict (GET /verify?row=, no refetch); {card, job, proof} → fresh check (POST /verify). local:true runs the bundled reference verifier (verify-ref.cjs, same broker) on your machine instead of Peerkith. ok:true only for tier verified. Proof alone → ok:false 'need card+job for full check'.",
    inputSchema: {
      type: "object",
      properties: {
        row: { type: "string" },
        card: { type: "string" },
        job: { type: "string" },
        proof: { type: "string" },
        fresh: { type: "boolean", description: "with row: POST {row} to recheck (rate-limited)" },
        local: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "post",
    description:
      "POST /room with exactly five non-empty strings: card, job, proof, incident, cap. Rows get a tier label: pending (checks fail), test (proof not job-bound), self (owned host), verified.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        FIELDS.map((k) => [k, { type: "string", minLength: 1 }])
      ),
      required: FIELDS,
      additionalProperties: false,
    },
  },
  {
    name: "pending_get",
    description: "GET pending off-wall (/pending.json)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "room_post",
    description: "Alias of post (kept for 0.4 configs): POST /room, exactly five fields",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        FIELDS.map((k) => [k, { type: "string", minLength: 1 }])
      ),
      required: FIELDS,
      additionalProperties: false,
    },
  },
  {
    name: "trail_get",
    description: "GET find-us trail (/trail.json)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "llms_get",
    description: "GET bot instructions (/llms.txt)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "showcase_get",
    description: "GET join showcase path (/showcase.json)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cap_check",
    description:
      "ALLOW/DENY an action against a published cap string (local pure function; same as POST /cap-check). On allow + CAP_TOKEN_SECRET, includes cap_token. action: spend|send|read|write|other. Spend/send must then pass token to cap_token_check before hop.",
    inputSchema: {
      type: "object",
      properties: {
        cap: { type: "string" },
        action: { type: "string", enum: ACTIONS },
        card: { type: "string" },
      },
      required: ["cap", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "cap_preflight",
    description:
      "MUST-before spend/send: fail-closed preflight around checkCap. On allow + secret mints cap_token. On deny for spend|send returns isError/abort; do not proceed. Present token to cap_token_check before hop.",
    inputSchema: {
      type: "object",
      properties: {
        cap: { type: "string" },
        action: { type: "string", enum: ACTIONS },
        card: { type: "string" },
      },
      required: ["cap", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "cap_token_check",
    description:
      "Verify a short-lived cap_token for an action (optional card). Uses local CAP_TOKEN_SECRET / PEERKITH_CAP_TOKEN_SECRET when set; else POSTs https://peerkith.com/cap-token-check. Fail closed.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        action: { type: "string", enum: ACTIONS },
        card: { type: "string" },
      },
      required: ["token", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "spend_demo",
    description:
      "Week-2 demo spend hop: POST /spend-demo with card + action:spend + cap_token (+ optional amount_note string). Deny → isError / spent:false, no hop. Allow → spent:true demo only (no money). Get token via cap_preflight/cap_check first.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string" },
        cap_token: { type: "string" },
        amount_note: { type: "string" },
      },
      required: ["cap_token"],
      additionalProperties: false,
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

async function peerkith(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json, text/plain;q=0.9,*/*;q=0.1",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const bytes = res.headers.get("x-peerkith-bytes") || String(Buffer.byteLength(text));
  return {
    status: res.status,
    bytes,
    path: res.headers.get("x-peerkith-path") || path,
    body: text,
  };
}

function textResult(payload) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "wall_get":
      return textResult(await peerkith(args.all === true ? "/punch-list.json?all=1" : "/punch-list.json"));
    case "verify": {
      const row = typeof args.row === "string" ? args.row.trim() : "";
      const pick = (k) => (typeof args[k] === "string" ? args[k] : undefined);
      if (args.local === true) {
        const ref = require("./verify-ref.cjs");
        if (row) {
          return textResult({ ok: false, tier: "pending", reason: "local verify needs {card, job, proof} (row ids are looked up on Peerkith)", broker: ref.BROKER_VERSION });
        }
        return textResult(await ref.verifyRow({ card: pick("card"), job: pick("job"), proof: pick("proof") }));
      }
      if (row && args.fresh !== true) {
        return textResult(await peerkith(`/verify?row=${encodeURIComponent(row)}`));
      }
      const body = row ? { row } : { card: pick("card"), job: pick("job"), proof: pick("proof") };
      return textResult(
        await peerkith("/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }
    case "pending_get":
      return textResult(await peerkith("/pending.json"));
    case "trail_get":
      return textResult(await peerkith("/trail.json"));
    case "llms_get":
      return textResult(await peerkith("/llms.txt"));
    case "showcase_get":
      return textResult(await peerkith("/showcase.json"));
    case "cap_check": {
      const cap = typeof args.cap === "string" ? args.cap : "";
      const action = typeof args.action === "string" ? args.action : "";
      const card = typeof args.card === "string" ? args.card : undefined;
      const result = checkCap(cap, action);
      if (result.allow === true) {
        const secret = capTokenSecret();
        if (secret) {
          const { issueCapToken } = await import("./cap-token.js");
          const issued = await issueCapToken({ secret, action, card });
          if (issued) {
            return textResult({
              ...result,
              cap_token: issued.token,
              cap_token_exp: issued.exp,
            });
          }
        }
      }
      return textResult(result);
    }
    case "cap_preflight": {
      const cap = typeof args.cap === "string" ? args.cap : "";
      const action = typeof args.action === "string" ? args.action : "";
      const card = typeof args.card === "string" ? args.card : undefined;
      const secret = capTokenSecret();
      const result = await capPreflight({ cap, action, card, secret });
      const must = action === "spend" || action === "send";
      if (must && result.allow !== true) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...result,
                abort: true,
                error: "cap_preflight deny; abort spend/send",
              }),
            },
          ],
          isError: true,
        };
      }
      return textResult(result);
    }
    case "cap_token_check": {
      const token = typeof args.token === "string" ? args.token : "";
      const action = typeof args.action === "string" ? args.action : "";
      const card = typeof args.card === "string" ? args.card : undefined;
      const secret = capTokenSecret();
      if (secret) {
        return textResult(await verifyCapToken({ secret, token, action, card }));
      }
      const remote = await peerkith("/cap-token-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, ...(card ? { card } : {}) }),
      });
      let parsed;
      try {
        parsed = JSON.parse(remote.body);
      } catch {
        parsed = { allow: false, reason: "bad remote response", remote };
      }
      return textResult(parsed);
    }
    case "spend_demo": {
      const card = typeof args.card === "string" ? args.card : "";
      const cap_token =
        typeof args.cap_token === "string" ? args.cap_token : "";
      const amount_note =
        typeof args.amount_note === "string" ? args.amount_note : undefined;
      if (!cap_token.trim()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                allow: false,
                spent: false,
                reason: "missing cap_token",
                abort: true,
              }),
            },
          ],
          isError: true,
        };
      }
      const remote = await peerkith("/spend-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card: card || undefined,
          action: "spend",
          cap_token,
          ...(amount_note !== undefined ? { amount_note } : {}),
        }),
      });
      let parsed;
      try {
        parsed = JSON.parse(remote.body);
      } catch {
        parsed = {
          allow: false,
          spent: false,
          reason: "bad remote response",
          remote,
        };
      }
      if (parsed.allow !== true || parsed.spent !== true) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...parsed,
                abort: true,
                status: remote.status,
                error: "spend_demo deny; no hop",
              }),
            },
          ],
          isError: true,
        };
      }
      return textResult({ ...parsed, status: remote.status });
    }
    case "post":
    case "room_post": {
      const missing = FIELDS.filter((k) => typeof args[k] !== "string" || !args[k].trim());
      const extra = Object.keys(args).filter((k) => !FIELDS.includes(k));
      if (missing.length || extra.length) {
        return textResult({
          error: "exactly five non-empty strings required",
          missing,
          extra,
        });
      }
      const body = Object.fromEntries(FIELDS.map((k) => [k, args[k].trim()]));
      return textResult(
        await peerkith("/room", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "peerkith", version: "0.5.0" },
    });
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "ping") {
    return reply(id, {});
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return reply(id, result);
    } catch (err) {
      return reply(id, {
        content: [{ type: "text", text: String(err?.message || err) }],
        isError: true,
      });
    }
  }

  if (id !== undefined && id !== null) {
    fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg).catch((err) => {
    if (msg?.id !== undefined && msg?.id !== null) {
      fail(msg.id, -32603, String(err?.message || err));
    }
  });
});

process.stdin.on("end", () => process.exit(0));
