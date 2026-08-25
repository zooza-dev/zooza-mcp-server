import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import type { ApiListResponse } from "./types.js";
import {
  getUpdatePlan,
  markUpdatePlanUsed,
  saveUpdatePlan,
  type SessionsUpdatePlan,
} from "./update-plan-store.js";

const rescheduleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("set"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    time: z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM").optional(),
  }),
  z.object({
    mode: z.literal("unify_time"),
    time: z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM"),
  }),
  z.object({
    mode: z.literal("shift"),
    days: z.number().int().optional(),
    minutes: z.number().int().optional(),
  }),
]);

const changesSchema = z
  .object({
    reschedule: rescheduleSchema.optional(),
    trainer_id: z.number().int().positive().optional(),
    trainer_rate_type_id: z.number().int().nonnegative().optional(),
    place_id: z.number().int().positive().optional(),
    room_id: z.number().int().nonnegative().optional(),
    segment: z
      .union([z.number().int().nonnegative(), z.string()])
      .optional()
      .describe("Block: existing segment id (int), a new block name (string, auto-created), or 0 to clear."),
    duration: z.number().int().positive().optional(),
  })
  .strict();

export const sessionsPrepareUpdateInputSchema = {
  company_id: companyIdSchema,
  event_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .describe("One or many event (session) ids. Resolve with sessions_find_events."),
  changes: changesSchema,
  notify: z
    .boolean()
    .optional()
    .describe("Default false. true emails enrolled clients about the change — confirm intent with the operator first."),
};

export const sessionsCommitUpdateInputSchema = {
  token: z
    .string()
    .describe("Single-use token from sessions_update; expires after 15 minutes."),
};

const prepareInput = z.object(sessionsPrepareUpdateInputSchema);
const commitInput = z.object(sessionsCommitUpdateInputSchema);

interface EventRecord {
  id?: number;
  date?: string;
  duration?: number | string;
  trainer_id?: number;
  place_id?: number;
  room_id?: number;
  [k: string]: unknown;
}

export async function runSessionsPrepareUpdate(
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
  const { changes } = input;

  const attrFields = ["trainer_id", "trainer_rate_type_id", "place_id", "room_id", "segment", "duration"] as const;
  const hasAttr = attrFields.some((f) => changes[f] !== undefined);
  if (changes.reschedule === undefined && !hasAttr) {
    return errorResult("`changes` is empty — provide `reschedule` and/or at least one attribute to change.");
  }
  if ((changes.place_id === undefined) !== (changes.room_id === undefined)) {
    return errorResult("Venue changes need both place_id and room_id together.");
  }
  if (changes.reschedule?.mode === "shift") {
    const { days, minutes } = changes.reschedule;
    if ((days ?? 0) === 0 && (minutes ?? 0) === 0) {
      return errorResult("Reschedule mode 'shift' needs a non-zero days and/or minutes.");
    }
  }

  const callAuth = withCompany(auth, input.company_id!);

  // Resolve the events (validate + read current date for reschedule + diff).
  let records: EventRecord[];
  try {
    records = await fetchEventsByIds(input.event_ids, callAuth);
  } catch (error) {
    return zoozaError(error, "Could not load the sessions");
  }
  const byId = new Map<number, EventRecord>();
  for (const r of records) if (typeof r.id === "number") byId.set(r.id, r);
  const missing = input.event_ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return errorResult(
      `Session(s) ${missing.join(", ")} not found in company ${input.company_id ?? "(default)"}. ` +
        "Re-resolve with sessions_find_events.",
    );
  }

  // Shared attribute changes (same for every event).
  const attrPayload: Record<string, unknown> = {};
  for (const f of attrFields) if (changes[f] !== undefined) attrPayload[f] = changes[f];

  const event_payloads: Array<Record<string, unknown> & { id: number }> = [];
  const sessions: Array<{ event_id: number; changes: unknown[] }> = [];

  for (const id of input.event_ids) {
    const rec = byId.get(id)!;
    const body: Record<string, unknown> & { id: number } = { id, ...attrPayload };
    const diff: Array<{ field: string; from: unknown; to: unknown }> = [];

    if (changes.reschedule) {
      let newDate: string;
      try {
        newDate = computeDate(changes.reschedule, rec.date);
      } catch (e) {
        return errorResult(
          `Could not compute the new date for session ${id}: ${e instanceof Error ? e.message : String(e)}. ` +
            "Use date 'YYYY-MM-DD' and time 'HH:MM'.",
        );
      }
      body.date = newDate;
      diff.push({ field: "date", from: rec.date ?? null, to: newDate });
    }
    for (const f of attrFields) {
      if (changes[f] !== undefined) diff.push({ field: f, from: rec[f] ?? null, to: changes[f] });
    }
    if (input.notify) body.notify = true;

    event_payloads.push(body);
    sessions.push({ event_id: id, changes: diff });
  }

  const warnings: string[] = [];
  if (changes.reschedule) {
    warnings.push(
      "Reschedule does not re-check holiday/school-break skips — verify the new dates are not on a closure.",
    );
  }
  if (input.notify) {
    warnings.push(`notify: true — committing will email enrolled clients of ${input.event_ids.length} session(s).`);
  }

  const summary = { notify: input.notify === true, sessions, warnings };
  const plan: SessionsUpdatePlan = {
    kind: "sessions",
    company_id: input.company_id!,
    event_payloads,
    summary,
  };
  const { token, expires_in_seconds } = saveUpdatePlan(plan);

  return {
    content: [
      { type: "text", text: JSON.stringify({ token, expires_in_seconds, ...summary }, null, 2) },
    ],
  };
}

export async function runSessionsCommitUpdate(
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
        `${lookup.reason}). Call sessions_update again and re-confirm with the operator.`,
    );
  }
  if (lookup.plan.kind !== "sessions") {
    return errorResult("This token is not a session-edit plan. Use the tool that produced it.");
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);
  const requestedIds = plan.event_payloads.map((p) => p.id);

  try {
    const raw = await zoozaFetch<unknown>(
      "/events",
      { method: "PUT", body: { events: plan.event_payloads } },
      callAuth,
    );
    markUpdatePlanUsed(token);
    const updatedIds = extractUpdatedIds(raw, requestedIds);
    const skipped = requestedIds.filter((id) => !updatedIds.includes(id));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              updated_event_ids: updatedIds,
              skipped_event_ids: skipped,
              notified: plan.summary.notify === true,
              ...(skipped.length > 0
                ? { note: "api-v1 skipped some sessions (not found/locked). Re-resolve the skipped ids." }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    return zoozaError(
      error,
      `Could not apply the session edits (${requestedIds.join(", ")}). You may retry sessions_update once ` +
        "with the same token",
    );
  }
}

// ── date helpers ──────────────────────────────────────────────────────────────
// api-v1 writes events.date verbatim as `Y-m-d H:i:s` (Utils::DATE_FORMAT_FULL,
// events.php:1674). We treat naive datetimes as UTC purely for arithmetic — no
// timezone conversion happens, so day/minute shifts round-trip exactly.

function computeDate(
  r: z.infer<typeof rescheduleSchema>,
  current: string | undefined,
): string {
  if (r.mode === "set") {
    const time = r.time ?? (current ? current.slice(11, 16) : "00:00");
    return `${r.date} ${time}:00`;
  }
  if (!current || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(current)) {
    throw new Error("current session date is missing or malformed");
  }
  if (r.mode === "unify_time") {
    return `${current.slice(0, 10)} ${r.time}:00`;
  }
  // shift
  const base = new Date(`${current.slice(0, 10)}T${current.slice(11, 19) || "00:00:00"}Z`);
  base.setUTCDate(base.getUTCDate() + (r.days ?? 0));
  base.setUTCMinutes(base.getUTCMinutes() + (r.minutes ?? 0));
  return fmtFull(base);
}

function fmtFull(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

async function fetchEventsByIds(ids: number[], auth: ZoozaAuth): Promise<EventRecord[]> {
  const raw = await zoozaFetch<ApiListResponse<EventRecord> | EventRecord[]>(
    "/events",
    { query: { ids: ids.join("|"), status: "any", page_size: ids.length } },
    auth,
  );
  if (Array.isArray(raw)) return raw;
  return raw?.data ?? [];
}

/** Extract updated event ids from the batch response, defensively. api-v1 returns
 *  an array of {id, updated, message}; unknown shapes fall back to "all requested". */
function extractUpdatedIds(raw: unknown, requested: number[]): number[] {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : null;
  if (!rows) return requested;
  const ids: number[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      const r = row as { id?: unknown; updated?: unknown };
      const id = typeof r.id === "number" ? r.id : Number.parseInt(String(r.id), 10);
      if (Number.isFinite(id) && r.updated !== false) ids.push(id);
    }
  }
  return ids.length > 0 ? ids : requested;
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

// ─── Dual-phase surface (ZMCP-20260824-001) ──────────────────────────────────
//
// Replaces the former `sessions_prepare_update` / `sessions_commit_update` PAIR with
// one registration dispatching on `token` presence. Phase logic is unchanged — the
// two run functions keep their own zod parsing, so every preview rule and error
// message survives verbatim. Preview fields are optional here because they are
// absent on the apply call; runSessionsPrepareUpdate still validates them.

export const sessionsUpdateTitle = "Edit specific sessions (preview, then apply)";

export const sessionsUpdateDescription =
  "Edit specific individual sessions (events) of a class — reschedule a session's date/time, or change a " +
  "hand-picked session's instructor, venue/room, block, or duration. Works on one session or a chosen set.\n\n" +
  "TWO CALLS. First WITHOUT `token`: returns a per-session before→after preview plus a single-use token. Show it " +
  "to the operator and get explicit approval (and, if `notify` is set, confirm that clients will be emailed). " +
  "Then call again with `token` + `confirmed: true` to apply — send nothing else, the edits are frozen in the " +
  "plan.\n\n" +
  "Use this when the user points at particular sessions (\"move next Tuesday's class to Wednesday 5pm\", \"change " +
  "the room for the July sessions\", \"give Friday's session to Jana\"). To change an attribute across ALL or all " +
  "upcoming sessions of a class in one go, use classes_update with session_scope instead. To cancel sessions, use " +
  "the cancellation tools — this tool does not cancel.";

export const sessionsUpdateInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  event_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .optional()
    .describe("Required on the FIRST call. One or many event (session) ids. Resolve with sessions_find_events."),
  changes: changesSchema.optional().describe("Required on the FIRST call."),
  notify: z
    .boolean()
    .optional()
    .describe(
      "Default false. true emails enrolled clients about the change — confirm intent with the operator first. " +
        "Set it on the FIRST call; it is frozen into the plan.",
    ),
};

export async function runSessionsUpdate(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") {
    return errorResult(decision.message);
  }
  if (decision.kind === "preview") {
    return runSessionsPrepareUpdate(rawInput, auth);
  }
  return runSessionsCommitUpdate({ token: decision.token }, auth);
}
