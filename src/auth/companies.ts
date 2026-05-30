import type { CompanyRef } from "./types.js";

/**
 * Single source of truth for pulling the user's company list out of api-v1's
 * (still-evolving) JWT-aware `/v1/user` response.
 *
 * This used to be duplicated in `whoami.ts` and `session-store.ts`, and the two
 * copies drifted: whoami probed `user.companies` / `user.user_companies` while
 * session-store did not. The result was a session whose company list was empty
 * even though `whoami` reported several companies — so omitting `company_id`
 * yielded a misleading "No companies available" instead of defaulting/prompting.
 * Keep this the ONLY place that knows where companies live in the response.
 */
export function extractCompanies(raw: unknown): CompanyRef[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const user = (obj.user as Record<string, unknown> | undefined) ?? {};
  const data = (obj.data as Record<string, unknown> | undefined) ?? {};
  // Probe known + plausible locations, most-specific to least-specific.
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

function normaliseCompanyList(c: unknown): CompanyRef[] {
  if (!Array.isArray(c)) return [];
  const out: CompanyRef[] = [];
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
