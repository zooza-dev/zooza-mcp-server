import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type { ApiListResponse } from "./types.js";
import {
  type ClassesUpdatePlan,
  getUpdatePlan,
  markUpdatePlanUsed,
  saveUpdatePlan,
} from "./update-plan-store.js";

// ── Cascade field → canonical api-v1 update_mode_* key (confirmed authoritative
//    by handoff zooza-mcp-to-api-v1-20260702-001; class/Schedule.php:2799-2893). ──
const CASCADE_KEYS = {
  trainer_id: "update_mode_trainer",
  trainer_rate_type_id: "update_mode_trainer_rate_type",
  duration: "update_mode_duration",
  place_id: "update_mode_place",
} as const;
type CascadeField = keyof typeof CASCADE_KEYS;
const CASCADE_FIELDS = Object.keys(CASCADE_KEYS) as CascadeField[];

export const classesPrepareUpdateTitle = "Preview a class (schedule) edit";
export const classesCommitUpdateTitle = "Apply a previewed class edit";

export const classesPrepareUpdateDescription =
  "Preview an edit to one or more existing classes (a \"class\"/\"timetable\" is the recurring group within a " +
  "programme). Use this to change a class's settings — name, price, registration fee, capacity, billing period, " +
  "online-registration, status — and/or its instructor, venue, or session duration. Changing instructor/venue/duration " +
  "forces a `session_scope` choice about existing sessions: \"upcoming\" (this class + its future " +
  "sessions — usually what people mean), \"all\" (every session incl. past), or \"class_only\" (re-advertise the " +
  "class but leave existing sessions on their old value — the #1 cause of \"I changed it but the sessions still " +
  "show the old value\", so only pick it deliberately). This scope is the OPERATOR's call, not yours: when they " +
  "haven't stated one, PRESENT the three options and their consequences and let them choose — do NOT silently pick a " +
  "scope and prepare, and do NOT stall. If the operator asks what a cascade edit will do before committing, explain " +
  "this same taxonomy (in particular that class_only re-advertises the class but leaves existing sessions unchanged). " +
  "Returns a preview of exactly what changes and how many " +
  "sessions are affected — nothing is written until you call classes_commit_update with the returned `token`. " +
  "Handles one class or many at once. To edit specific individual sessions (move one date, change one session's " +
  "room), use sessions_update instead. To cancel sessions, use the cancellation tools.";

export const classesCommitUpdateDescription =
  "Applies a class edit previously previewed by classes_prepare_update. Only call this after the operator has " +
  "seen the preview (field changes + how many sessions the cascade touches) and EXPLICITLY confirmed. Takes the " +
  "`token` from classes_prepare_update — the changes are frozen in the plan and cannot be altered here; to change " +
  "anything, call classes_prepare_update again. Returns which classes were updated and how many sessions the " +
  "cascade rewrote.";

const changesSchema = z
  .object({
    name: z.string().optional(),
    note: z.string().optional(),
    description: z.string().optional(),
    capacity: z.number().int().positive().optional(),
    registrations_cap: z.number().int().nonnegative().optional(),
    price: z.number().nonnegative().optional(),
    unit_price: z.number().nonnegative().optional(),
    registration_fee: z.number().nonnegative().optional(),
    billing_period_id: z.number().int().positive().optional(),
    online_registration: z.boolean().optional(),
    status: z.enum(["active", "inactive", "archive"]).optional(),
    // cascade fields (require session_scope)
    trainer_id: z.number().int().positive().optional(),
    trainer_rate_type_id: z.number().int().nonnegative().optional(),
    duration: z.number().int().positive().optional(),
    place_id: z.number().int().positive().optional(),
    room_id: z.number().int().nonnegative().optional(),
    // guarded
    course_id: z.number().int().positive().optional(),
  })
  .strict();

export const classesPrepareUpdateInputSchema = {
  company_id: companyIdSchema,
  schedule_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .describe("One or many class (schedule) ids. Resolve by name with classes_find_classes."),
  changes: changesSchema.describe("The fields to change. At least one required."),
  session_scope: z
    .enum(["class_only", "upcoming", "all"])
    .optional()
    .describe(
      "REQUIRED when changing instructor/venue/duration. 'upcoming' = the class + its future sessions " +
        "(usual); 'all' = every session; 'class_only' = re-advertise the class only, existing sessions keep " +
        "their old value (warn the operator — usually NOT what they want).",
    ),
  confirm_course_change: z
    .boolean()
    .optional()
    .describe(
      "REQUIRED true to change changes.course_id — reprogramming a class rewrites ALL its sessions AND all " +
        "registrations (irreversible). Only set after the operator explicitly asked to move the class to a " +
        "different programme.",
    ),
};

export const classesCommitUpdateInputSchema = {
  token: z
    .string()
    .describe("Single-use token from classes_prepare_update; expires after 15 minutes."),
};

const prepareInput = z.object(classesPrepareUpdateInputSchema);
const commitInput = z.object(classesCommitUpdateInputSchema);

/** Loose view of a /v1/schedules/{id} record — only fields we diff against. */
interface ScheduleRecord {
  id?: number | string;
  [k: string]: unknown;
}

export async function runClassesPrepareUpdate(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = prepareInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const changes = input.changes;
  const changedFields = Object.keys(changes).filter(
    (k) => (changes as Record<string, unknown>)[k] !== undefined,
  );
  if (changedFields.length === 0) {
    return errorResult("`changes` is empty — provide at least one field to change.");
  }

  // Guard: course_id (programme change) — high blast radius.
  if (changes.course_id !== undefined && input.confirm_course_change !== true) {
    return errorResult(
      `Changing the programme (course_id) rewrites ALL sessions AND all registrations for ${input.schedule_ids.length} ` +
        "class(es) — irreversible. Re-call with confirm_course_change: true only if the operator explicitly wants " +
        "to move the class to a different programme.",
    );
  }

  // place_id and room_id move together.
  if ((changes.place_id === undefined) !== (changes.room_id === undefined)) {
    return errorResult("Venue changes need both place_id and room_id together.");
  }

  // Cascade fields require an explicit session_scope.
  const cascadePresent = CASCADE_FIELDS.filter((f) => changes[f] !== undefined);
  if (cascadePresent.length > 0 && input.session_scope === undefined) {
    return errorResult(
      `You're changing ${cascadePresent.join(", ")}, which can also affect existing sessions. Set session_scope: ` +
        "'upcoming' (usual), 'all', or 'class_only' (re-advertise the class only — existing sessions keep the old " +
        "value). Most operators want 'upcoming' or 'all'.",
    );
  }

  const callAuth = withCompany(auth, input.company_id!);

  // Build the update-mode keys once (same for every schedule).
  const modeKeys: Record<string, string> = {};
  if (input.session_scope === "upcoming" || input.session_scope === "all") {
    for (const f of cascadePresent) modeKeys[CASCADE_KEYS[f]] = input.session_scope;
  }

  // Fetch each schedule to validate existence + read current values for the diff.
  const schedulePayloads: Array<Record<string, unknown> & { id: number }> = [];
  const perScheduleDiffs: Array<{
    schedule_id: number;
    name: string | null;
    field_changes: unknown[];
  }> = [];
  for (const id of input.schedule_ids) {
    let current: ScheduleRecord;
    try {
      current = await fetchSchedule(id, callAuth);
    } catch (error) {
      if (error instanceof ZoozaApiError && error.status === 404) {
        return errorResult(
          `Class ${id} not found in company ${input.company_id ?? "(default)"}. Use classes_find_classes to look it up.`,
        );
      }
      return zoozaError(error, `Could not load class ${id}`);
    }

    const name = typeof current.name === "string" ? current.name : null;
    const field_changes = changedFields.map((f) => ({
      field: f,
      from: current[f] ?? null,
      to: (changes as Record<string, unknown>)[f],
      cascades: CASCADE_FIELDS.includes(f as CascadeField) && input.session_scope !== "class_only",
    }));
    perScheduleDiffs.push({ schedule_id: id, name, field_changes });

    // Body: changed fields + cascade mode keys. (room_id rides along with place_id.)
    const body: Record<string, unknown> & { id: number } = { id };
    for (const f of changedFields) body[f] = (changes as Record<string, unknown>)[f];
    Object.assign(body, modeKeys);
    schedulePayloads.push(body);
  }

  // Best-effort count of sessions the cascade will rewrite.
  let sessions_affected: number | null = 0;
  if (Object.keys(modeKeys).length > 0) {
    sessions_affected = await countAffectedSessions(
      input.schedule_ids,
      input.session_scope as "upcoming" | "all",
      callAuth,
    );
  }

  const warnings: string[] = [];
  if (input.session_scope === "class_only" && cascadePresent.length > 0) {
    warnings.push(
      "class_only: the class is re-advertised with the new value but EXISTING sessions keep the old one. " +
        "This is the most common reason a setting appears unchanged on individual sessions.",
    );
  }
  if (changes.course_id !== undefined) {
    warnings.push(
      "Programme change (course_id) rewrites every session AND every registration of the affected class(es) — high impact.",
    );
  }

  const summary = {
    // The object being edited is the CLASS (schedule), never an individual session/event.
    // Carry an explicit label so the caller describes it correctly and does not borrow a
    // session id (e.g. "event #64") from an earlier lookup.
    object: "class",
    classes: perScheduleDiffs.map((d) => ({ schedule_id: d.schedule_id, name: d.name })),
    schedule_ids: input.schedule_ids,
    session_scope: input.session_scope ?? null,
    sessions_affected,
    diffs: perScheduleDiffs,
    warnings,
  };

  const plan: ClassesUpdatePlan = {
    kind: "classes",
    company_id: input.company_id!,
    schedule_payloads: schedulePayloads,
    summary,
  };
  const { token, expires_in_seconds } = saveUpdatePlan(plan);

  return {
    content: [
      { type: "text", text: JSON.stringify({ token, expires_in_seconds, summary }, null, 2) },
    ],
  };
}

export async function runClassesCommitUpdate(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = commitInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const { token } = parsed.data;

  const lookup = getUpdatePlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This edit plan is no longer valid (tokens are single-use and expire after 15 minutes — this one is ` +
        `${lookup.reason}). Call classes_prepare_update again and re-confirm with the operator.`,
    );
  }
  if (lookup.plan.kind !== "classes") {
    return errorResult("This token is not a class-edit plan. Use the tool that produced it.");
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);
  const payloads = plan.schedule_payloads;

  try {
    if (payloads.length === 1) {
      const { id, ...body } = payloads[0];
      await zoozaFetch<unknown>(`/schedules/${id}`, { method: "PUT", body }, callAuth);
    } else {
      // Bulk: bare array of {id, …fields, update_mode_*} (schedules.php bulk_update).
      await zoozaFetch<unknown>("/schedules/bulk", { method: "PUT", body: payloads }, callAuth);
    }
    markUpdatePlanUsed(token);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              // What changed is the CLASS (schedule) itself — report it by class id + name,
              // never as an "event"/session id. `classes` is the label the caller should echo.
              object: "class",
              classes: plan.summary.classes ?? payloads.map((p) => ({ schedule_id: p.id })),
              schedule_ids: payloads.map((p) => p.id),
              updated: true,
              session_scope: plan.summary.session_scope ?? null,
              sessions_affected: plan.summary.sessions_affected ?? null,
              note: "Applied to the CLASS (schedule) itself — describe it as the class, by name/schedule id, not as a session or event. The cascade (if any) rewrote existing sessions per the scope shown in the preview.",
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    // Token NOT burned — safe to retry once (the write either fully applied or not).
    return zoozaError(
      error,
      `Could not apply the class edit (schedules ${payloads.map((p) => p.id).join(", ")}). No confirmation of ` +
        "changes; you may retry classes_commit_update once with the same token",
    );
  }
}

async function fetchSchedule(id: number, auth: ZoozaAuth): Promise<ScheduleRecord> {
  const raw = await zoozaFetch<{ data?: ScheduleRecord } | ScheduleRecord>(
    `/schedules/${id}`,
    {},
    auth,
  );
  const rec = (raw as { data?: ScheduleRecord })?.data ?? (raw as ScheduleRecord);
  if (!rec || rec.id === undefined) {
    throw new ZoozaApiError(404, `/schedules/${id}`, "Schedule not found");
  }
  return rec;
}

/** Sum, across schedules, the sessions the cascade will rewrite. Best-effort:
 *  returns null if the count query fails (the edit can still proceed). */
async function countAffectedSessions(
  scheduleIds: number[],
  scope: "upcoming" | "all",
  auth: ZoozaAuth,
): Promise<number | null> {
  try {
    let total = 0;
    for (const id of scheduleIds) {
      const query: Record<string, string | number> = { schedule_id: id, page_size: 1 };
      if (scope === "upcoming") query.upcoming_events = "true";
      else query.status = "any";
      const raw = await zoozaFetch<ApiListResponse<unknown>>("/events", { query }, auth);
      total += typeof raw?.total === "number" ? raw.total : 0;
    }
    return total;
  } catch {
    return null;
  }
}

function zoozaError(error: unknown, prefix: string) {
  if (error instanceof ZoozaApiError) {
    return errorResult(`${prefix} (api-v1 ${error.status}: ${error.humanMessage}).`);
  }
  return errorResult(error instanceof Error ? error.message : String(error));
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
