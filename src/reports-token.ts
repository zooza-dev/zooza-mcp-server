import { randomBytes } from "node:crypto";
import type { ZoozaAuth } from "./auth/types.js";

/**
 * Short-lived report-access tokens (spec ZMCP-20260612-002, live-data phase).
 *
 * The /reports page runs in the user's BROWSER with no JWT. reports_show_report mints
 * one of these tokens during an authenticated tool call, snapshotting the caller's
 * api-v1 auth + company; the browser page then hits GET /reports/data?token=… and the
 * MCP server replays that auth server-side. Credentials never reach the browser — the
 * token is an opaque random handle to in-memory state.
 *
 * Properties: 32-byte random, 30 min TTL, single company scope, read-only use,
 * in-memory only (a restart revokes everything — acceptable; the user just asks for
 * the report again). Single-replica only, same caveat as the session store.
 */

export interface ReportToken {
  sub: string;
  companyId: number;
  auth: ZoozaAuth;
  expiresAt: number;
}

const TOKEN_TTL_MS = 30 * 60 * 1000;
const tokens = new Map<string, ReportToken>();

export function mintReportToken(sub: string, companyId: number, auth: ZoozaAuth): string {
  // Opportunistic sweep so the map can't grow unbounded.
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (v.expiresAt < now) tokens.delete(k);
  }
  const token = randomBytes(32).toString("base64url");
  tokens.set(token, { sub, companyId, auth, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

export function resolveReportToken(token: string | undefined): ReportToken | null {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}
