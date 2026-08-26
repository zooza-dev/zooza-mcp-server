import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import {
  type CourseSettingsPlan,
  getPlan,
  markPlanUsed,
  type PlanLookup,
} from "./course-settings-plan-store.js";
import type { CourseSettingsRecord } from "./types.js";

export const commitCourseSettingsInputSchema = {
  token: z
    .string()
    .describe("Single-use token from classes_update_course_settings; expires after 15 minutes."),
};

const inputSchema = z.object(commitCourseSettingsInputSchema);

export async function runCommitCourseSettings(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const { token } = parsed.data;

  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(planInvalidMessage(lookup.reason));
  }
  const plan = lookup.plan;

  // The PUT carries exactly the stored put_body — changed fields plus the guard
  // echoes prepare baked in (feedback-wipe trap). Company is frozen in the plan;
  // commit args can never redirect the write.
  let upstream: CourseSettingsRecord | undefined;
  try {
    const raw = await zoozaFetch<{ data?: CourseSettingsRecord } | CourseSettingsRecord | undefined>(
      `/courses/${plan.course_id}`,
      { method: "PUT", body: plan.put_body },
      withCompany(auth, plan.company_id),
    );
    upstream = (raw as { data?: CourseSettingsRecord })?.data ?? (raw as CourseSettingsRecord | undefined);
  } catch (error) {
    // Token is NOT burned on any failure — the course row is unchanged, so one
    // retry with the same token is safe (comms precedent).
    return errorResult(commitFailureMessage(error));
  }

  // Upstream success — burn the token so the same plan can't be applied twice.
  markPlanUsed(token);

  const result = {
    updated: true,
    course_id: plan.course_id,
    section: plan.section,
    applied: buildApplied(plan, upstream),
    warnings: plan.warnings,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
}

/** Error-catalog row: token unknown / expired / used. */
export function planInvalidMessage(
  reason: Extract<PlanLookup, { ok: false }>["reason"],
): string {
  return `This settings plan is ${reason}. Run classes_update_course_settings again to build a fresh plan.`;
}

/**
 * Maps an upstream PUT failure to its error-catalog row. Every branch states
 * that the update was NOT applied; the 5xx/transport ones add the retry-once
 * guidance because the token survives the failure.
 */
export function commitFailureMessage(error: unknown): string {
  if (error instanceof ZoozaApiError) {
    if (error.status === 403) {
      return (
        "api-v1 rejected the update: this account lacks the edit_course permission " +
        "(only owner and assistant roles can change programme settings)."
      );
    }
    if (error.status >= 500) {
      return `Zooza API error (${error.status}) — the update was NOT applied. The token is still valid; retry classes_update_course_settings once.`;
    }
    // Other 4xx — prepare's validation should have caught it, so retrying the
    // same body would fail identically; teach a re-prepare instead.
    return (
      `api-v1 rejected the update (${error.status}: ${error.humanMessage}) — the update was NOT applied. ` +
      "Run classes_update_course_settings again to build a fresh plan."
    );
  }
  // Transport-level failure (fetch threw before any HTTP status existed).
  const detail = error instanceof Error ? error.message : String(error);
  return `Zooza API error (network: ${detail}) — the update was NOT applied. The token is still valid; retry classes_update_course_settings once.`;
}

/**
 * The `applied` echo: one entry per diffed field, valued from the reloaded
 * course api-v1 returns for the PUT — upstream-confirmed, so silent coercions
 * are visible. Falls back to the sent value when the response omits a field.
 * Guard echoes stay out: they were plumbing, not the user's change.
 */
export function buildApplied(
  plan: CourseSettingsPlan,
  upstream: CourseSettingsRecord | undefined,
): Record<string, unknown> {
  const applied: Record<string, unknown> = {};
  for (const { field } of plan.diff) {
    applied[field] =
      upstream && Object.hasOwn(upstream, field) ? upstream[field] : plan.put_body[field];
  }
  return applied;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
