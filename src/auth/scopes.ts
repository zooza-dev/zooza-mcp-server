import type { JwtClaims } from "./types.js";

export const SCOPE_READ = "mcp:read";
export const SCOPE_WRITE = "mcp:write";

export type Scope = typeof SCOPE_READ | typeof SCOPE_WRITE;

/** A read scope is implied whenever write is granted. */
export function hasScope(claims: JwtClaims | null, required: Scope): boolean {
  if (claims === null) return true; // legacy mode bypasses scope checks
  if (required === SCOPE_READ) {
    return claims.scopes.has(SCOPE_READ) || claims.scopes.has(SCOPE_WRITE);
  }
  return claims.scopes.has(required);
}

export function parseScopes(scope: string | undefined): Set<string> {
  if (!scope) return new Set();
  return new Set(scope.split(/\s+/).filter((s) => s.length > 0));
}
