/**
 * Auth mode for a single request:
 * - "jwt"    — Bearer header present + validated. JWT forwarded verbatim to api-v1.
 * - "legacy" — dev-fallback (ZOOZA_ALLOW_HARDCODED_AUTH=true + no Bearer).
 *              Legacy X-ZOOZA-TOKEN header sent to api-v1.
 */
export type AuthMode = "jwt" | "legacy";

export interface JwtClaims {
  /** Subject — Zooza user id, string-encoded. */
  sub: string;
  /** Space-separated scope string from zooza-auth. */
  scope: string;
  /** Parsed scope set. */
  scopes: Set<string>;
  client_id: string;
  iss: string;
  iat: number;
  exp: number;
  jti: string;
  /** Regional installation this token belongs to, e.g. "eu" / "uk" / "asia".
   *  Selects the api-v1 base URL per request. Null when the claim is absent. */
  region: string | null;
}

export interface CompanyRef {
  id: number;
  name: string;
}

/**
 * Per-session state held in memory across requests. Keyed by `sub` (Zooza user id)
 * for v1 — parallel MCP clients for the same user share state. Swap to per-MCP-
 * session id when the SDK refactor lands.
 *
 * No active-company concept — every tool call carries its own `company_id`.
 * The session only tracks identity (sub) and the list of companies this user
 * may operate on.
 */
export interface SessionState {
  sub: string;
  companies: CompanyRef[];
  /** Per-company branding cache (logo data URI, primary color) — warmed by whoami,
   *  consumed when serving the reports artifact resource. See auth/branding.ts. */
  branding?: Map<number, import("./branding.js").CompanyBranding>;
}

/**
 * What `zoozaFetch` needs to assemble headers for a single api-v1 call.
 * The two modes differ only in which auth header gets set; `apiKey` and
 * `company` always come through.
 */
export type ZoozaAuth =
  | {
      mode: "jwt";
      apiKey: string;
      company: string;
      bearer: string;
      /** Resolved api-v1 base URL for this request's region. */
      baseUrl: string;
    }
  | {
      mode: "legacy";
      apiKey: string;
      company: string;
      legacyToken: string;
      /** Resolved api-v1 base URL for this request's region. */
      baseUrl: string;
    };

/**
 * Assembled per-request context — what the middleware hands to tool handlers.
 */
export interface RequestAuthContext {
  mode: AuthMode;
  auth: ZoozaAuth;
  session: SessionState;
  /** Populated when mode === "jwt"; null in legacy mode. */
  claims: JwtClaims | null;
}
