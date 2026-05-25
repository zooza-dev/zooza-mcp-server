import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { config } from "../config.js";
import type { JwtClaims } from "./types.js";
import { parseScopes } from "./scopes.js";

export class JwtValidationError extends Error {
  constructor(
    public readonly code:
      | "invalid_token"
      | "expired_token"
      | "missing_token"
      | "auth_server_unavailable",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JwtValidationError";
  }
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks) return cachedJwks;
  if (!config.auth.authServerUrl) {
    throw new JwtValidationError(
      "auth_server_unavailable",
      "MCP_AUTH_SERVER_URL not configured — cannot validate JWTs.",
    );
  }
  const url = new URL(
    "/.well-known/jwks.json",
    config.auth.authServerUrl.endsWith("/")
      ? config.auth.authServerUrl
      : config.auth.authServerUrl + "/",
  );
  cachedJwks = createRemoteJWKSet(url, {
    cacheMaxAge: config.auth.jwksCacheTtlSeconds * 1000,
    // jose stale-while-revalidates on its own for the cooldown window.
    cooldownDuration: 30_000,
  });
  return cachedJwks;
}

export function extractBearer(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function validateJwt(token: string): Promise<JwtClaims> {
  const jwks = getJwks();
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.auth.authServerUrl,
      ...(config.auth.requireAud ? { audience: config.auth.resourceUrl } : {}),
    });
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      throw new JwtValidationError("invalid_token", "JWT missing `sub` claim.");
    }
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return {
      sub,
      scope,
      scopes: parseScopes(scope),
      client_id: typeof payload.client_id === "string" ? payload.client_id : "",
      iss: typeof payload.iss === "string" ? payload.iss : "",
      iat: typeof payload.iat === "number" ? payload.iat : 0,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
      jti: typeof payload.jti === "string" ? payload.jti : "",
    };
  } catch (err) {
    if (err instanceof JwtValidationError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new JwtValidationError("expired_token", "JWT expired.", err);
    }
    if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new JwtValidationError("invalid_token", "JWT signature does not verify.", err);
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      throw new JwtValidationError("invalid_token", `JWT claim invalid: ${err.message}`, err);
    }
    if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
      throw new JwtValidationError(
        "auth_server_unavailable",
        `JWKS fetch failed: ${err.message}`,
        err,
      );
    }
    throw new JwtValidationError(
      "invalid_token",
      `JWT validation failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
