import { z } from "zod";

import type { ApiListResponse } from "./types.js";

/**
 * Shared zod schema fragment used as the `company_id` input on every
 * operational tool. Optional — when omitted, the server-side wrapper
 * (`resolveCompanyId` in index.ts) fills it in from the session if the
 * user has exactly one company. With multiple companies, the wrapper
 * returns a directive error listing the options so the LLM can pick.
 *
 * The description surfaces in the JSON schema served to MCP clients and
 * is the primary discovery hint for the LLM.
 *
 * Coerced: a client calling a dispatch-only tool directly by name never saw its
 * schema and tends to send "1" — evals 2026-10-12 caught classes_preview_schedule
 * rejecting exactly that. The JSON schema still advertises an integer.
 */
export const companyIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Zooza company id to operate against. Optional: if the user has exactly one company, the server defaults to it — you can omit this field. With multiple companies, you MUST specify which; get the id list from `whoami.available_companies[].id`. If the user hasn't indicated which company they mean, ask them before guessing.",
  );

/**
 * Registration statuses that mean "still in trial". Single source of truth for
 * the attendance tools: `sessions_get_attendance` derives `is_trial` from it, and
 * `sessions_mark_attendance` uses it to gate the trial-followup todo lookup. Keep in sync
 * with api-v1's trial status enum.
 */
export const TRIAL_STATUSES = new Set(["trial_started", "trial_not_started"]);

/**
 * Trim a value to a non-empty string, or `undefined`. Shared across tools so
 * the "blank strings are absent" rule lives in exactly one place (it was
 * copy-pasted verbatim into four tool files).
 */
/** A schedule's `time` as HH:MM. api-v1 stores and serialises it as an int of
 *  MINUTES since midnight (Resource/Schedule.php:31 casts 'time' to int; Schedule.php:869
 *  renders it via time_to_timestring) — 1170 is 19:30. A "HH:MM[:SS]" string is
 *  accepted too. Undefined when absent or unparseable. */
export function scheduleTimeHHMM(v: unknown): string | undefined {
  const minutes = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (Number.isInteger(minutes) && minutes >= 0 && minutes < 24 * 60) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const m = typeof v === "string" ? v.match(/^(\d{1,2}):(\d{2})/) : null;
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

export function pickStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Normalise api-v1's two list shapes — a bare `T[]` or an
 * `{ data, total, settings }` envelope — into one predictable result.
 *
 * Every `find_*` tool (and the attendance reads) was repeating
 * `const isBare = Array.isArray(raw); const records = isBare ? raw : raw.data ?? []`
 * plus the matching `total` / `settings` fallbacks. Centralising it means a
 * future change to api-v1's wrapper key (e.g. `data` → `results`) is a one-line
 * fix here instead of a hunt across eight files — the same drift hazard that
 * caused the company-list bug.
 */
export function unwrapList<T>(
  raw: ApiListResponse<T> | T[] | null | undefined,
): { records: T[]; total: number; settings: Record<string, unknown> } {
  if (Array.isArray(raw)) {
    return { records: raw, total: raw.length, settings: {} };
  }
  const records = raw?.data ?? [];
  return {
    records,
    total: raw?.total ?? records.length,
    settings: raw?.settings ?? {},
  };
}
