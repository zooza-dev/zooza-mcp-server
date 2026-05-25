import { config } from "../config.js";
import type { CompanyRef, SessionState, ZoozaAuth } from "./types.js";

/**
 * In-memory session map keyed by `sub` (Zooza user id). Limitation: parallel
 * MCP clients for the same user share state, so switching company in one
 * client changes the active company for the other. Acceptable for v1; swap
 * to per-MCP-session-id when the SDK refactor lands.
 *
 * Single-replica only — when we scale horizontally, swap for Redis.
 */
const sessions = new Map<string, SessionState>();

export function getSession(sub: string): SessionState | undefined {
  return sessions.get(sub);
}

export function setSession(state: SessionState): void {
  sessions.set(state.sub, state);
}

export function clearSession(sub: string): void {
  sessions.delete(sub);
}

/**
 * Synthetic session for dev-fallback mode. The legacy .env credentials
 * authenticate as one (configured) user against one (configured) company,
 * so there's nothing to switch and no list to fetch.
 */
export const DEV_FALLBACK_SUB = "__legacy_env__";

export function buildDevFallbackSession(): SessionState {
  const companyId = Number.parseInt(config.zooza.legacyCompany, 10);
  return {
    sub: DEV_FALLBACK_SUB,
    companies: [
      {
        id: companyId,
        name: "(dev-fallback company)",
      },
    ],
  };
}

/**
 * Build a base ZoozaAuth carrying credentials but a placeholder `company`.
 * Every tool MUST override the company per-call via `withCompany(auth, id)`
 * before calling `zoozaFetch` — there is no active-company default.
 *
 * The placeholder is the first company in the session list (if any) or "0";
 * api-v1 will reject calls that ride the placeholder, which is intentional
 * (forces tools to be explicit).
 */
export function buildAuth(session: SessionState, bearer: string | null): ZoozaAuth {
  const placeholder = String(session.companies[0]?.id ?? 0);
  if (bearer === null) {
    return {
      mode: "legacy",
      apiKey: config.zooza.apiKey,
      company: placeholder,
      legacyToken: config.zooza.legacyToken,
    };
  }
  return {
    mode: "jwt",
    apiKey: config.zooza.apiKey,
    company: placeholder,
    bearer,
  };
}

/**
 * Per-call override of the company header. Tools call this with the user-
 * supplied `company_id` before forwarding to `zoozaFetch`.
 */
export function withCompany(auth: ZoozaAuth, companyId: number): ZoozaAuth {
  return { ...auth, company: String(companyId) };
}

/**
 * Bootstrap a new JWT session by fetching the user's company list from api-v1.
 * Tolerant of api-v1's still-being-defined JWT-aware /v1/user shape — if the
 * response doesn't carry a companies array we leave the list empty and let
 * the user pick blindly (api-v1 will reject the call if the company is invalid).
 */
export async function bootstrapJwtSession(
  sub: string,
  fetchUser: () => Promise<unknown>,
): Promise<SessionState> {
  let companies: CompanyRef[] = [];
  try {
    const user = await fetchUser();
    companies = extractCompanies(user);
  } catch (err) {
    // Soft-fail: log and continue with an empty list. The /v1/user call will
    // be retried by the user's first tool call, which will return the real
    // error to them with the correct status code.
    console.warn(
      `[session] /v1/user bootstrap failed for sub=${sub}:`,
      err instanceof Error ? err.message : err,
    );
  }
  const state: SessionState = { sub, companies };
  setSession(state);
  return state;
}

function extractCompanies(user: unknown): CompanyRef[] {
  if (!user || typeof user !== "object") return [];
  const obj = user as Record<string, unknown>;
  const candidates = [obj.companies, (obj.data as Record<string, unknown> | undefined)?.companies];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const out: CompanyRef[] = [];
      for (const entry of c) {
        if (typeof entry === "number") {
          out.push({ id: entry, name: `company ${entry}` });
          continue;
        }
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          const id = typeof e.id === "number" ? e.id : typeof e.id === "string" ? Number.parseInt(e.id, 10) : 0;
          const name = typeof e.name === "string" ? e.name : `company ${id}`;
          if (id > 0) out.push({ id, name });
        }
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}
