import type { Request } from "express";
import { config } from "../config.js";
import { zoozaFetch } from "../zooza.js";
import { extractBearer, JwtValidationError, validateJwt } from "./jwt.js";
import { resolveBaseUrl } from "./region.js";
import {
  bootstrapJwtSession,
  buildAuth,
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

  // The api-v1 region is resolved from the JWT `region` claim only — there is no
  // server-configured default. A request without a Bearer therefore has no region
  // to route to and is rejected, even when hardcoded-auth dev mode is enabled.
  // Local dev must present a real JWT carrying a `region` claim.
  if (bearer === null) {
    throw unauthorizedChallenge(
      "missing_token",
      "Authorization header with a JWT (carrying a `region` claim) is required.",
    );
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

  // Resolve the region's api-v1 base URL from the token before any outbound
  // call. Missing/malformed/unconfigured region is rejected — routing a request
  // to the wrong installation is worse than failing.
  const baseUrl = resolveBaseUrl(claims.region);
  if (baseUrl === null) {
    throw unauthorizedChallenge(
      "invalid_token",
      claims.region
        ? `No api-v1 base URL configured for region "${claims.region}".`
        : "JWT missing `region` claim.",
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
        baseUrl,
      };
      return zoozaFetch("/user", { query: { widget_type: "unknown" } }, bootstrapAuth);
    });
  }

  const auth = buildAuth(session, bearer, baseUrl);
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
