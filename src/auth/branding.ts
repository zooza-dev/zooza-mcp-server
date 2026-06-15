import { zoozaFetch } from "../zooza.js";
import type { SessionState, ZoozaAuth } from "./types.js";
import { withCompany } from "./session-store.js";

/**
 * Company branding for the client reports artifact (spec ZMCP-20260612-002).
 *
 * Source: GET /v1/companies/{id} — `logo` (public CDN URL), `sites_settings.primary_color`
 * (hex). The artifact sandbox loads no external images, so the MCP server downloads the
 * logo HERE (server-side, where network exists) and converts it to a data: URI. Cached on
 * the session per company; whoami warms the cache, the artifact resource read consumes it.
 */

export interface CompanyBranding {
  company_id: number;
  name: string | null;
  /** data:image/... URI, ready for the sandbox. Null when absent or fetch failed. */
  logo_data_uri: string | null;
  /** Validated #rrggbb hex. Null when absent or malformed. */
  primary_color: string | null;
  fetched_at: number;
}

const BRANDING_TTL_MS = 60 * 60 * 1000; // 1h — branding changes rarely
const LOGO_MAX_BYTES = 300 * 1024; // keep the injected artifact reasonable
const LOGO_FETCH_TIMEOUT_MS = 5000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** sites_settings arrives as a JSON string or an object depending on the endpoint path. */
function extractPrimaryColor(sitesSettings: unknown): string | null {
  let settings = sitesSettings;
  if (typeof settings === "string") {
    try {
      settings = JSON.parse(settings);
    } catch {
      return null;
    }
  }
  const color = pick(settings, "primary_color") ?? pick(settings, "primaryColor");
  if (typeof color !== "string") return null;
  const trimmed = color.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : null;
}

async function fetchLogoAsDataUri(url: string): Promise<string | null> {
  if (!/^https?:\/\//.test(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > LOGO_MAX_BYTES) return null;
    return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch branding from api-v1. Every part soft-fails to null — never throws. */
export async function fetchCompanyBranding(
  auth: ZoozaAuth,
  companyId: number,
): Promise<CompanyBranding> {
  let name: string | null = null;
  let logoUrl: string | null = null;
  let primaryColor: string | null = null;
  try {
    const company = await zoozaFetch<unknown>(
      `/companies/${companyId}`,
      {},
      withCompany(auth, companyId),
    );
    // Some api-v1 reads wrap the record; tolerate both shapes.
    const record = pick(company, "id") !== undefined ? company : (pick(company, "data") ?? company);
    const n = pick(record, "name");
    name = typeof n === "string" && n.length > 0 ? n : null;
    const l = pick(record, "logo");
    logoUrl = typeof l === "string" && l.length > 0 ? l : null;
    primaryColor = extractPrimaryColor(pick(record, "sites_settings"));
  } catch {
    // company read failed — return an empty (but cached) branding so we don't hammer api-v1
  }
  const logo_data_uri = logoUrl ? await fetchLogoAsDataUri(logoUrl) : null;
  return {
    company_id: companyId,
    name,
    logo_data_uri,
    primary_color: primaryColor,
    fetched_at: Date.now(),
  };
}

/** Cache-through read on the session. Never throws. */
export async function ensureBranding(
  session: SessionState,
  auth: ZoozaAuth,
  companyId: number,
): Promise<CompanyBranding> {
  const cached = session.branding?.get(companyId);
  if (cached && Date.now() - cached.fetched_at < BRANDING_TTL_MS) return cached;
  const fresh = await fetchCompanyBranding(auth, companyId);
  if (!session.branding) session.branding = new Map();
  session.branding.set(companyId, fresh);
  return fresh;
}

/**
 * Branding to inject into the artifact for this session: the company the session can
 * see (single-company case), else the most recently fetched one. Null when nothing
 * is cached — the artifact then renders its default Zooza styling.
 */
export function sessionBranding(session: SessionState): CompanyBranding | null {
  const map = session.branding;
  if (!map || map.size === 0) return null;
  if (session.companies.length === 1) {
    return map.get(session.companies[0].id) ?? null;
  }
  let latest: CompanyBranding | null = null;
  for (const b of map.values()) {
    if (!latest || b.fetched_at > latest.fetched_at) latest = b;
  }
  return latest;
}
