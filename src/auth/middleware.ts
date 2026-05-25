import type { Request } from "express";
import { config } from "../config.js";
import { zoozaFetch } from "../zooza.js";
import { extractBearer, JwtValidationError, validateJwt } from "./jwt.js";
import {
  bootstrapJwtSession,
  buildAuth,
  buildDevFallbackSession,
  getSession,
} from "./session-store.js";
import type { RequestAuthContext, ZoozaAuth } from "./types.js";

export class AuthChallengeError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly wwwAuthenticate: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthChallengeError";
  }
}

const RESOURCE_METADATA_URL = () =>
  new URL("/.well-known/oauth-protected-resource", config.auth.resourceUrl).toString();

function unauthorizedChallenge(error: "invalid_token" | "missing_token", description: string): AuthChallengeError {
  const parts = [`Bearer resource_metadata="${RESOURCE_METADATA_URL()}"`];
  if (error === "invalid_token") {
    parts.push(`error="invalid_token"`, `error_description="${description.replace(/"/g, "'")}"`);
  }
  return new AuthChallengeError(401, parts.join(", "), description);
}

/**
 * Resolve the auth context for an incoming /mcp request. Either returns a
 * fully populated context or throws AuthChallengeError (which the caller
 * translates to a 401/403 with the appropriate WWW-Authenticate header).
 */
export async function resolveAuthContext(req: Request): Promise<RequestAuthContext> {
  const bearer = extractBearer(req.header("authorization"));

  // No Bearer + hardcoded allowed → dev fallback (current local-dev behaviour).
  if (bearer === null) {
    if (config.auth.allowHardcoded) {
      const session = buildDevFallbackSession();
      const auth: ZoozaAuth = buildAuth(session, null);
      return { mode: "legacy", auth, session, claims: null };
    }
    throw unauthorizedChallenge("missing_token", "Authorization header required.");
  }

  // Bearer present — always validate (no silent fallback on JWT failure).
  let claims;
  try {
    claims = await validateJwt(bearer);
  } catch (err) {
    if (err instanceof JwtValidationError) {
      throw unauthorizedChallenge("invalid_token", err.message);
    }
    throw unauthorizedChallenge(
      "invalid_token",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Look up or bootstrap session for this user.
  let session = getSession(claims.sub);
  if (!session) {
    session = await bootstrapJwtSession(claims.sub, async () => {
      // Build a temporary auth with no active company (header gets "0")
      // — api-v1's /v1/user shouldn't need a company to resolve the JWT's sub.
      const bootstrapAuth: ZoozaAuth = {
        mode: "jwt",
        apiKey: config.zooza.apiKey,
        company: "0",
        bearer,
      };
      return zoozaFetch("/user", { query: { widget_type: "unknown" } }, bootstrapAuth);
    });
  }

  const auth = buildAuth(session, bearer);
  return { mode: "jwt", auth, session, claims };
}

/**
 * Resource-metadata document per the MCP authorization spec.
 */
export function buildResourceMetadata(): Record<string, unknown> {
  return {
    resource: config.auth.resourceUrl,
    authorization_servers: config.auth.authServerUrl
      ? [config.auth.authServerUrl]
      : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
}
