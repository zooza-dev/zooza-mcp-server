import type { RequestAuthContext } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";

export const whoamiTitle = "Who am I?";

export const whoamiDescription = `Returns the connected user's identity, the companies they can operate on, and the session's token state. Call ONCE at the start of every conversation — this is the authoritative source for the user's accessible companies, and every other tool requires a 'company_id' picked from the 'companies' list returned here.

How to interpret the response:

- 'status: "ok"' — user is authenticated and has at least one company. Pick a 'company_id' from 'companies' for follow-up calls (ask the user which one if more than one exists).
- 'status: "no_companies"' — user is authenticated but has no accessible companies. Surface 'status_message' to the user verbatim. Do NOT invent a 'company_id' or guess from other context — no other Zooza tool will work until the user is granted company access.
- 'status: "invalid_user"' — api-v1 rejects this account. Surface 'status_message' verbatim; do not attempt other tools.
- 'status: "api_error"' — api-v1 was unreachable. Surface 'status_message' verbatim and suggest a retry.

Never surface internal fields like 'sub', 'scopes', or 'token_expires_in_seconds' to the user — those are diagnostic-only. Render only what's useful to a human: their name/email and the company list.`;

export const whoamiInputSchema = {};

type WhoamiStatus = "ok" | "no_companies" | "invalid_user" | "api_error";

interface WhoamiResult {
  status: WhoamiStatus;
  status_message: string;
  identity: {
    email?: string;
    name?: string;
  };
  companies: Array<{ id: number; name: string }>;
  scopes: string[];
  token_expires_in_seconds: number | null;
}

export async function runWhoami(
  ctx: RequestAuthContext,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const scopes = ctx.claims
    ? Array.from(ctx.claims.scopes)
    : ["mcp:read", "mcp:write"];
  const tokenExp = ctx.claims
    ? Math.max(0, ctx.claims.exp - Math.floor(Date.now() / 1000))
    : null;

  let rawUser: unknown;
  try {
    rawUser = await zoozaFetch<unknown>(
      "/user",
      { query: { widget_type: "unknown" } },
      ctx.auth,
    );
  } catch (error) {
    const message =
      error instanceof ZoozaApiError
        ? error.humanMessage
        : error instanceof Error
          ? error.message
          : String(error);
    return ok({
      status: "api_error",
      status_message: `Zooza is temporarily unreachable. Tell the user to try again in a moment. (Underlying: ${message})`,
      identity: {},
      companies: [],
      scopes,
      token_expires_in_seconds: tokenExp,
    });
  }

  const { userValid, email, name } = extractIdentity(rawUser);
  const companies = extractCompanies(rawUser);
  const identity = {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };

  if (userValid === false) {
    return ok({
      status: "invalid_user",
      status_message:
        "Your Zooza account is not active. Please contact your administrator to enable it.",
      identity,
      companies: [],
      scopes,
      token_expires_in_seconds: tokenExp,
    });
  }

  if (companies.length === 0) {
    return ok({
      status: "no_companies",
      status_message:
        "You are signed in but no Zooza companies are linked to your account. Please contact your administrator to be added to a company.",
      identity,
      companies: [],
      scopes,
      token_expires_in_seconds: tokenExp,
    });
  }

  return ok({
    status: "ok",
    status_message: "Authenticated. Pick a company_id from `companies` for follow-up tool calls.",
    identity,
    companies,
    scopes,
    token_expires_in_seconds: tokenExp,
  });
}

function extractIdentity(raw: unknown): {
  userValid: boolean | undefined;
  email?: string;
  name?: string;
} {
  if (!raw || typeof raw !== "object") return { userValid: undefined };
  const obj = raw as Record<string, unknown>;
  const userValid =
    typeof obj.user_valid === "boolean" ? obj.user_valid : undefined;
  const user = (obj.user as Record<string, unknown> | undefined) ?? {};
  const email = pickStr(user.email) ?? pickStr(obj.email);
  const firstName = pickStr(user.first_name);
  const lastName = pickStr(user.last_name);
  const composed = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = composed.length > 0 ? composed : pickStr(user.name) ?? pickStr(user.display_name);
  return {
    userValid,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

function extractCompanies(raw: unknown): Array<{ id: number; name: string }> {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const user = (obj.user as Record<string, unknown> | undefined) ?? {};
  const data = (obj.data as Record<string, unknown> | undefined) ?? {};
  // Probe known + plausible locations in api-v1's JWT-aware /v1/user response.
  // Order: most-specific to least-specific.
  const candidates: unknown[] = [
    obj.companies,
    user.companies,
    user.user_companies,
    data.companies,
  ];
  for (const c of candidates) {
    const list = normaliseCompanyList(c);
    if (list.length > 0) return list;
  }
  return [];
}

function normaliseCompanyList(c: unknown): Array<{ id: number; name: string }> {
  if (!Array.isArray(c)) return [];
  const out: Array<{ id: number; name: string }> = [];
  for (const entry of c) {
    if (typeof entry === "number") {
      out.push({ id: entry, name: `company ${entry}` });
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const idRaw = e.id ?? e.company_id;
      const id =
        typeof idRaw === "number"
          ? idRaw
          : typeof idRaw === "string"
            ? Number.parseInt(idRaw, 10)
            : 0;
      const name = pickStr(e.name) ?? pickStr(e.company_name) ?? `company ${id}`;
      if (id > 0) out.push({ id, name });
    }
  }
  return out;
}

function pickStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function ok(payload: WhoamiResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
