import type { ZoozaAuth } from "../auth/types.js";
import { zoozaFetch } from "../zooza.js";

/**
 * What we extract from the api-v1 /v1/user response for downstream
 * permission/scoping decisions in attendance-shaped tools. Optional fields
 * may be absent on older api-v1 deployments; downstream code should treat
 * null as "unknown" and avoid claims it can't substantiate.
 */
export interface CallerContext {
  user_id: number | null;
  /**
   * One of api-v1's role strings: `owner`, `assistant`, `main_member`,
   * `member`, `external_member`, `receptionist`, `customer`, or null if
   * the upstream didn't surface it.
   *
   * Note: api-v1's `is_member()` returns true ONLY for `member` and
   * `external_member`. `main_member` is treated as admin (not member).
   */
  role: string | null;
  /**
   * api-v1's `company.trainer_attendance_management` setting. `"limited"`
   * blocks member/receptionist callers from `going` and `canceled`. Other
   * known values: `"default"`, `"king_of_schedule"`. Null if absent.
   */
  trainer_attendance_management: string | null;
}

/**
 * True only for roles where api-v1's `is_member()` auto-scopes reads to
 * the caller's own assignments. Mirrors common.php:5344-5358.
 */
export function isAutoScopedRole(role: string | null): boolean {
  return role === "member" || role === "external_member";
}

/**
 * Fetch /v1/user once and project the fields downstream attendance tools
 * need. Throws ZoozaApiError on upstream failure — callers should let the
 * error propagate so the standard error envelope surfaces.
 *
 * No caching for V1; if call rates spike, add a per-session memo keyed
 * by (sub, company) here.
 */
export async function getCallerContext(auth: ZoozaAuth): Promise<CallerContext> {
  const raw = await zoozaFetch<unknown>(
    "/user",
    { query: { widget_type: "unknown" } },
    auth,
  );
  return projectCallerContext(raw);
}

function projectCallerContext(raw: unknown): CallerContext {
  if (!raw || typeof raw !== "object") {
    return { user_id: null, role: null, trainer_attendance_management: null };
  }
  const obj = raw as Record<string, unknown>;
  const user = (obj.user as Record<string, unknown> | undefined) ?? {};
  const company = (obj.company as Record<string, unknown> | undefined) ?? {};

  const user_id =
    typeof user.id === "number"
      ? user.id
      : typeof user.id === "string"
        ? Number.parseInt(user.id, 10) || null
        : null;

  // api-v1 confirmed (handoff 2026-05-28-attendance-field-shapes): on /v1/user,
  // `user.role` is always a bare string here — no nested `{role:...}` probe needed.
  const role: string | null =
    typeof user.role === "string" && user.role.length > 0 ? user.role : null;

  // Likewise `company.trainer_attendance_management` is a bare string. NOTE: it's
  // an additive field api-v1 is adding to /v1/user; until that ships it is absent,
  // so `tam` stays null and the `limited` gate in computeAllowedStatuses simply
  // doesn't apply yet (allowed_statuses returns the full set).
  const tam: string | null =
    typeof company.trainer_attendance_management === "string"
      ? company.trainer_attendance_management
      : null;

  return {
    user_id,
    role,
    trainer_attendance_management: tam,
  };
}
