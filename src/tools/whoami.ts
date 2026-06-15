import { ensureBranding } from "../auth/branding.js";
import { extractCompanies } from "../auth/companies.js";
import type { RequestAuthContext } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { pickStr } from "./common.js";

/** Warm branding for at most this many companies per whoami (logo downloads cost time). */
const BRANDING_WARM_LIMIT = 3;

export const whoamiTitle = "Who am I?";

export const whoamiDescription = `Returns the connected user's identity, the companies they can operate on, regional context, and the session's token state. Call ONCE at the start of every conversation.

How to interpret the response:

- 'status: "ok"' — authenticated, at least one company available. Pick a 'company_id' from 'companies' for follow-up calls (ask the user if more than one exists).
- 'status: "no_companies"' — authenticated but no companies linked. Surface 'status_message' verbatim. No other tool will work.
- 'status: "invalid_user"' — account rejected by api-v1. Surface 'status_message' verbatim.
- 'status: "api_error"' — api-v1 unreachable. Surface 'status_message' and suggest retry.

Identity fields (use these to scope follow-up calls to the calling user):
- 'identity.user_id' — the caller's Zooza user id. Pass this as 'trainer_id' to filter sessions_find_events / sessions_get_attendance / etc. to the user's OWN data whenever the user says "my sessions," "my classes today," "what am I teaching tomorrow," etc. Without it, sessions_find_events returns ALL company events, not just the caller's.
- 'identity.email', 'identity.name' — for display only.

Regional context fields (use these to adapt behaviour):
- 'server_region' — which Zooza installation this token routes to, taken from the JWT 'region' claim: "eu" (SK/CZ/DE/RO/HU/IT/PL), "uk", "us", "asia". This is the API-instance region, NOT the company's market region. Null in dev-fallback (no JWT).
- 'company.region' — the company's MARKET region code (e.g. "sk", "cz", "de", "en"). Different axis from 'server_region': one EU instance ('server_region: "eu"') serves Slovak, Czech, German, … companies.
- 'company.locale' — BCP-47 locale for date/number/currency formatting (e.g. "sk-SK", "cs-CZ", "en-GB").
- 'company.language' — the company's primary language code.
- 'company.currency' — the company's currency (e.g. "EUR", "CZK", "GBP").

Use 'company.region' and 'company.language' to resolve terminology: a Slovak company saying "kurz" means Programme; a Czech company saying "lekce" means Session. When region context is available, skip asking the user to clarify language.

Branding (per company in 'companies[].branding'):
- 'branding.logo' (boolean) and 'branding.primary_color' (#hex or null) report what brand assets were cached for this company. The actual logo is held server-side and is injected automatically into the client reports artifact (reports_show_report) — you never handle the image yourself. Null branding = fetch failed or nothing configured; the artifact falls back to default Zooza styling.

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
  /** Brand summary — the full assets (logo data URI) stay in the server-side cache
   *  and are injected into the reports artifact; only presence is surfaced here. */
  branding?: { logo: boolean; primary_color: string | null } | null;
}

interface WhoamiResult {
  status: WhoamiStatus;
  status_message: string;
  /** API-instance region from the JWT `region` claim; null when no JWT (dev-fallback). */
  server_region: string | null;
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
      server_region: ctx.claims?.region ?? null,
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
  // API-instance region comes from the JWT only (null in dev-fallback / no-JWT).
  const serverRegion = ctx.claims?.region ?? null;
  const companyContext = extractCompanyContext(rawUser, serverRegion);
  const feedback = extractFeedbackStatus(rawUser);
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

  // Warm the per-company branding cache (logo as data URI + primary color) so the
  // reports artifact opens already styled with the client's brand. Soft, parallel,
  // capped — a missing logo must never slow whoami down or fail it.
  const brandedCompanies = await Promise.all(
    enrichedCompanies.map(async (c, idx) => {
      if (idx >= BRANDING_WARM_LIMIT) return { ...c, branding: null };
      const b = await ensureBranding(ctx.session, ctx.auth, c.id);
      return {
        ...c,
        branding: {
          logo: b.logo_data_uri !== null,
          primary_color: b.primary_color,
        },
      };
    }),
  );

  return ok({
    status: "ok",
    status_message: "Authenticated. Pick a company_id from `companies` for follow-up tool calls.",
    server_region: serverRegion,
    identity,
    companies: brandedCompanies,
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

function deriveLocale(language: string | null, serverRegion: string | null): string {
  if (language && LOCALE_MAP[language]) return LOCALE_MAP[language];
  // English variants depend on which Zooza installation (from the JWT region).
  if (serverRegion === "uk") return "en-GB";
  if (serverRegion === "us") return "en-US";
  return "en-IE"; // EU default (same as Company::get_locale() fallback)
}

// ─── Company context extraction ───────────────────────────────────────────────
// The /user endpoint response contains a top-level 'company' object with
// region, language, currency — already available from the existing API call.

function extractCompanyContext(
  raw: unknown,
  instanceRegion: string | null,
): CompanyContext | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const company = obj.company as Record<string, unknown> | undefined;
  if (!company || typeof company !== "object") return null;

  const region = pickStr(company.region) ?? null;
  const language = pickStr(company.language) ?? null;
  const currency = pickStr(company.currency) ?? null;
  const locale =
    region !== null || language !== null
      ? deriveLocale(language ?? region, instanceRegion)
      : null;

  return { region, language, locale, currency };
}

function ok(payload: WhoamiResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
