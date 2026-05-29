import type { RequestAuthContext } from "../auth/types.js";
import { config } from "../config.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";

export const whoamiTitle = "Who am I?";

export const whoamiDescription = `Returns the connected user's identity, the companies they can operate on, regional context, and the session's token state. Call ONCE at the start of every conversation.

How to interpret the response:

- 'status: "ok"' — authenticated, at least one company available. Pick a 'company_id' from 'companies' for follow-up calls (ask the user if more than one exists).
- 'status: "no_companies"' — authenticated but no companies linked. Surface 'status_message' verbatim. No other tool will work.
- 'status: "invalid_user"' — account rejected by api-v1. Surface 'status_message' verbatim.
- 'status: "api_error"' — api-v1 unreachable. Surface 'status_message' and suggest retry.

Identity fields (use these to scope follow-up calls to the calling user):
- 'identity.user_id' — the caller's Zooza user id. Pass this as 'trainer_id' to filter find_events / get_attendance_roster / etc. to the user's OWN data whenever the user says "my sessions," "my classes today," "what am I teaching tomorrow," etc. Without it, find_events returns ALL company events, not just the caller's.
- 'identity.email', 'identity.name' — for display only.

Regional context fields (use these to adapt behaviour):
- 'server_region' — which Zooza installation this MCP serves: "eu" (SK/CZ/DE/RO/HU/IT/PL), "uk", "us", "asia".
- 'company.region' — the company's market region code (e.g. "sk", "cz", "de", "en").
- 'company.locale' — BCP-47 locale for date/number/currency formatting (e.g. "sk-SK", "cs-CZ", "en-GB").
- 'company.language' — the company's primary language code.
- 'company.currency' — the company's currency (e.g. "EUR", "CZK", "GBP").

Use 'company.region' and 'company.language' to resolve terminology: a Slovak company saying "kurz" means Programme; a Czech company saying "lekce" means Session. When region context is available, skip asking the user to clarify language.

Feedback context (used by the 'feedback-nudge' skill):
- 'last_feedback_at' — ISO timestamp of the user's last MCP feedback submission, or null if never. Drives the skill's 7-day cool-off on proactive feedback nudges.
- 'feedback_count' — total submissions to date (0 if never).

Never surface 'sub' or 'scopes' to the user — diagnostic only.`;

export const whoamiInputSchema = {};

type WhoamiStatus = "ok" | "no_companies" | "invalid_user" | "api_error";

interface CompanyContext {
  region: string | null;
  language: string | null;
  locale: string | null;
  currency: string | null;
}

interface WhoamiCompany {
  id: number;
  name: string;
  region: string | null;
  language: string | null;
  locale: string | null;
  currency: string | null;
}

interface WhoamiResult {
  status: WhoamiStatus;
  status_message: string;
  server_region: string;
  identity: {
    user_id?: number;
    email?: string;
    name?: string;
  };
  companies: WhoamiCompany[];
  scopes: string[];
  token_state: "active";
  last_feedback_at: string | null;
  feedback_count: number;
}

export async function runWhoami(
  ctx: RequestAuthContext,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const scopes = ctx.claims
    ? Array.from(ctx.claims.scopes)
    : ["mcp:read", "mcp:write"];

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
      server_region: config.serverRegion,
      identity: {},
      companies: [],
      scopes,
      token_state: "active",
      last_feedback_at: null,
      feedback_count: 0,
    });
  }

  const { userValid, user_id: userIdFromBody, email, name } = extractIdentity(rawUser);
  const companies = extractCompanies(rawUser);
  const companyContext = extractCompanyContext(rawUser);
  const feedback = extractFeedbackStatus(rawUser);
  const serverRegion = config.serverRegion;
  // Fall back to the JWT `sub` claim when /v1/user doesn't surface user.id —
  // sub is the Zooza user id string-encoded. Legacy auth has no claims.
  const user_id =
    userIdFromBody ??
    (ctx.claims?.sub
      ? Number.parseInt(ctx.claims.sub, 10) || undefined
      : undefined);
  const identity = {
    ...(user_id !== undefined && Number.isFinite(user_id) && user_id > 0
      ? { user_id }
      : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };

  // Enrich the company entry that matches the current auth company with regional context.
  // Other companies in a multi-company list get null context (API only returns context
  // for the currently authenticated company).
  const currentCompanyId = parseInt(ctx.auth.company, 10);
  const enrichedCompanies: WhoamiCompany[] = companies.map((c) => {
    if (c.id === currentCompanyId && companyContext) {
      return { ...c, ...companyContext };
    }
    return { ...c, region: null, language: null, locale: null, currency: null };
  });

  if (userValid === false) {
    return ok({
      status: "invalid_user",
      status_message:
        "Your Zooza account is not active. Please contact your administrator to enable it.",
      server_region: serverRegion,
      identity,
      companies: [],
      scopes,
      token_state: "active",
      last_feedback_at: feedback.last_feedback_at,
      feedback_count: feedback.feedback_count,
    });
  }

  if (enrichedCompanies.length === 0) {
    return ok({
      status: "no_companies",
      status_message:
        "You are signed in but no Zooza companies are linked to your account. Please contact your administrator to be added to a company.",
      server_region: serverRegion,
      identity,
      companies: [],
      scopes,
      token_state: "active",
      last_feedback_at: feedback.last_feedback_at,
      feedback_count: feedback.feedback_count,
    });
  }

  return ok({
    status: "ok",
    status_message: "Authenticated. Pick a company_id from `companies` for follow-up tool calls.",
    server_region: serverRegion,
    identity,
    companies: enrichedCompanies,
    scopes,
    token_state: "active",
    last_feedback_at: feedback.last_feedback_at,
    feedback_count: feedback.feedback_count,
  });
}

// ─── Feedback status extraction ───────────────────────────────────────────────
// Per agreed handoff zooza-mcp-to-api-v1-20260527-001, api-v1 surfaces flat
// fields on the /v1/user response. We degrade to null/0 if missing (older
// api-v1 deployments without the migration).

function extractFeedbackStatus(raw: unknown): {
  last_feedback_at: string | null;
  feedback_count: number;
} {
  if (!raw || typeof raw !== "object") {
    return { last_feedback_at: null, feedback_count: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const user = (obj.user as Record<string, unknown> | undefined) ?? {};
  const lastRaw = user.mcp_last_feedback_at ?? obj.mcp_last_feedback_at;
  const countRaw = user.mcp_feedback_count ?? obj.mcp_feedback_count;
  const lastIso = pickStr(lastRaw) ?? null;
  const count =
    typeof countRaw === "number"
      ? countRaw
      : typeof countRaw === "string"
        ? Number.parseInt(countRaw, 10) || 0
        : 0;
  return { last_feedback_at: lastIso, feedback_count: count };
}

function extractIdentity(raw: unknown): {
  userValid: boolean | undefined;
  user_id?: number;
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
  // user.id is what the API surfaces; tolerate string-encoded ids.
  const idRaw = user.id ?? obj.user_id;
  const user_id =
    typeof idRaw === "number" && Number.isFinite(idRaw)
      ? idRaw
      : typeof idRaw === "string" && idRaw.length > 0
        ? Number.parseInt(idRaw, 10)
        : undefined;
  return {
    userValid,
    ...(user_id !== undefined && Number.isFinite(user_id) && user_id > 0
      ? { user_id }
      : {}),
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

// ─── Locale derivation ────────────────────────────────────────────────────────
// Mirrors Company::get_locale() in api-v1/class/Company.php.
// Update here if the PHP mapping changes.

const LOCALE_MAP: Record<string, string> = {
  cz: "cs-CZ",
  cs: "cs-CZ",
  sk: "sk-SK",
  de: "de-AT",
  ro: "ro-RO",
  hu: "hu-HU",
  it: "it-IT",
  pl: "pl-PL",
};

function deriveLocale(language: string | null, serverRegion: string): string {
  if (language && LOCALE_MAP[language]) return LOCALE_MAP[language];
  // English variants depend on which Zooza installation
  if (serverRegion === "uk") return "en-GB";
  if (serverRegion === "us") return "en-US";
  return "en-IE"; // EU default (same as Company::get_locale() fallback)
}

// ─── Company context extraction ───────────────────────────────────────────────
// The /user endpoint response contains a top-level 'company' object with
// region, language, currency — already available from the existing API call.

function extractCompanyContext(raw: unknown): CompanyContext | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const company = obj.company as Record<string, unknown> | undefined;
  if (!company || typeof company !== "object") return null;

  const region = pickStr(company.region) ?? null;
  const language = pickStr(company.language) ?? null;
  const currency = pickStr(company.currency) ?? null;
  const locale =
    region !== null || language !== null
      ? deriveLocale(language ?? region, config.serverRegion)
      : null;

  return { region, language, locale, currency };
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
