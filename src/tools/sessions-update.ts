import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import type { ApiListResponse } from "./types.js";
import {
  getUpdatePlan,
  markUpdatePlanUsed,
  saveUpdatePlan,
  type SessionsAddPlan,
  type SessionsUpdatePlan,
} from "./update-plan-store.js";

const rescheduleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z
      .literal("set")
      .describe("Reschedule mode: move the session(s) to an explicit date (and optional time)."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
      .describe("New session date, YYYY-MM-DD."),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "time must be HH:MM")
      .optional()
      .describe("New start time, HH:MM. Omit to keep each session's existing time."),
  }),
  z.object({
    mode: z
      .literal("unify_time")
      .describe("Reschedule mode: set every selected session to the same time on its existing date."),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "time must be HH:MM")
      .describe("Start time, HH:MM, applied to every selected session."),
  }),
  z.object({
    mode: z
      .literal("shift")
      .describe("Reschedule mode: move each session by a relative offset (days and/or minutes)."),
    days: z
      .number()
      .int()
      .optional()
      .describe("Days to shift each session by; negative moves it earlier."),
    minutes: z
      .number()
      .int()
      .optional()
      .describe("Minutes to shift each session's time by; negative moves it earlier."),
  }),
]);

const changesSchema = z
  .object({
    reschedule: rescheduleSchema
      .optional()
      .describe(
        "Move the selected session(s) to a new date/time. Pick a mode: set (explicit date), unify_time (same time on existing dates), or shift (relative offset).",
      ),
    trainer_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Reassign the session(s) to a different instructor. Resolve with trainers_find."),
    trainer_rate_type_id: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Set the instructor pay-rate type for the session(s). Resolve with trainers_find_rate_types.",
      ),
    place_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Move the session(s) to a different venue (place); must be sent together with room_id. Resolve with classes_find_places.",
      ),
    room_id: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Room within the venue for the session(s); must be sent together with place_id."),
    segment: z
      .union([z.number().int().nonnegative(), z.string()])
      .optional()
      .describe("Block: existing segment id (int), a new block name (string, auto-created), or 0 to clear."),
    duration: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("New session length in minutes."),
  })
  .strict();

// ADD-MODE: one new session to create on an existing schedule (ZMCP-20260827-004).
const sessionAddSpecSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .describe("New session date, YYYY-MM-DD."),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "time must be HH:MM")
    .optional()
    .describe("Start time HH:MM. Omit → class default."),
  duration: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Length in minutes. Omit → class default."),
});

export const sessionsPrepareUpdateInputSchema = {
  company_id: companyIdSchema,
  event_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .describe("One or many event (session) ids. Resolve with sessions_find_events."),
  changes: changesSchema.describe(
    "The edits to apply to the selected session(s) — any combination of reschedule, instructor, pay-rate, venue/room, block, and duration. Provide at least one.",
  ),
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
      { type: "text", text: JSON.stringify({ token, expires_in_seconds, ...summary }) },
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
  if (lookup.plan.kind === "sessions_add") {
    return commitSessionsAdd(lookup.plan, token, auth);
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

// ── add-mode (ZMCP-20260827-004): create new sessions on an existing schedule ───

const addInput = z.object({
  company_id: companyIdSchema,
  schedule_id: z.number().int().positive(),
  sessions: z.array(sessionAddSpecSchema).nonempty(),
  notify: z.boolean().optional(),
});

/** Loose view of GET /v1/schedules/{id} — only the fields the new events inherit. */
interface ScheduleForAdd {
  id?: number | string;
  course_id?: number | string;
  trainer_id?: number | string;
  trainer_rate_type_id?: number | string;
  place_id?: number | string;
  room_id?: number | string;
  /** Default start time as minutes-of-day (e.g. 895 = 14:55). */
  time?: number | string;
  duration?: number | string;
  name?: string;
  schedule_type?: string;
  [k: string]: unknown;
}

async function runSessionsPrepareAdd(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = addInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  let sched: ScheduleForAdd;
  try {
    sched = await fetchScheduleForAdd(input.schedule_id, callAuth);
  } catch (error) {
    return zoozaError(error, `Could not load class ${input.schedule_id}`);
  }
  if (pickStr(sched.schedule_type) === "lead_collection") {
    return errorResult(
      `Class ${input.schedule_id} is a lead-collection pipeline, not a real class with sessions — ` +
        "cannot add sessions to it.",
    );
  }

  const warnings: string[] = [];
  const defTimeMinutes = toNum(sched.time);
  const defDuration = toNum(sched.duration);
  if (defDuration <= 0) {
    warnings.push(
      "The class has no default duration; new sessions without an explicit duration default to 60 minutes.",
    );
  }

  const create_events: Array<Record<string, unknown>> = input.sessions.map((s) => ({
    schedule_id: input.schedule_id,
    course_id: toNum(sched.course_id),
    trainer_id: toNum(sched.trainer_id),
    trainer_rate_type_id: toNum(sched.trainer_rate_type_id),
    place_id: toNum(sched.place_id),
    room_id: toNum(sched.room_id),
    date_string: s.date,
    time_string: s.time !== undefined ? hhmmToMinutes(s.time) : defTimeMinutes,
    duration: s.duration ?? (defDuration > 0 ? defDuration : 60),
    // Sessions are billable. NOT cosmetic: api-v1 only applies the `billable = 1`
    // filter when billable_events > 0 (Schedule.php:1194-1198). Creating non-billable
    // sessions can make a priced class read as €0 — see commit-class.ts for the full
    // rationale (schedule 7683 shipped at €0 from exactly this).
    billable: true,
    ...(input.notify ? { notify: true } : {}),
  }));

  warnings.push(
    "New session dates are NOT checked against holiday/school-break closures — verify none land on a closure.",
  );
  if (input.notify) {
    warnings.push(`notify: true — committing will email enrolled clients about ${create_events.length} new session(s).`);
  }

  const summary = {
    op: "add" as const,
    schedule_id: input.schedule_id,
    class_name: pickStr(sched.name) ?? null,
    new_sessions: create_events.map((e) => ({
      date: e.date_string,
      time_minutes: e.time_string,
      duration: e.duration,
    })),
    notify: input.notify === true,
    warnings,
  };
  const plan: SessionsAddPlan = {
    kind: "sessions_add",
    company_id: input.company_id!,
    schedule_id: input.schedule_id,
    create_events,
    summary,
  };
  const { token, expires_in_seconds } = saveUpdatePlan(plan);
  return {
    content: [{ type: "text", text: JSON.stringify({ token, expires_in_seconds, ...summary }) }],
  };
}

async function commitSessionsAdd(
  plan: SessionsAddPlan,
  token: string,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const callAuth = withCompany(auth, plan.company_id);
  try {
    // POST /events with per-event schedule_id creates on the existing schedule
    // (same primitive commit-class uses; no `filter=filter` needed on the write path).
    const raw = await zoozaFetch<unknown>(
      "/events",
      { method: "POST", body: { events: plan.create_events } },
      callAuth,
    );
    markUpdatePlanUsed(token);
    const createdIds = extractCreatedIds(raw);
    const requested = plan.create_events.length;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            created_event_ids: createdIds,
            created_count: createdIds.length > 0 ? createdIds.length : requested,
            schedule_id: plan.schedule_id,
            notified: plan.summary.notify === true,
            ...(createdIds.length > 0 && createdIds.length < requested
              ? { note: `api-v1 created only ${createdIds.length} of ${requested} sessions — inspect the class.` }
              : {}),
          }),
        },
      ],
    };
  } catch (error) {
    return zoozaError(
      error,
      `Could not add the session(s) to class ${plan.schedule_id}. You may retry sessions_update once ` +
        "with the same token",
    );
  }
}

async function fetchScheduleForAdd(id: number, auth: ZoozaAuth): Promise<ScheduleForAdd> {
  const raw = await zoozaFetch<{ data?: ScheduleForAdd } | ScheduleForAdd>(
    `/schedules/${id}`,
    {},
    auth,
  );
  const rec = (raw as { data?: ScheduleForAdd })?.data ?? (raw as ScheduleForAdd);
  if (!rec || rec.id === undefined) {
    throw new ZoozaApiError(404, `/schedules/${id}`, "Schedule not found");
  }
  return rec;
}

function extractCreatedIds(raw: unknown): number[] {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : [];
  const ids: number[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      const idv = (row as { id?: unknown }).id;
      const id = typeof idv === "number" ? idv : Number.parseInt(String(idv), 10);
      if (Number.isFinite(id)) ids.push(id);
    }
  }
  return ids;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
  return h * 60 + m;
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
  // `filter=filter` is REQUIRED: api-v1's /events collection search (__collection,
  // events.php:65-70) only runs when it is present. Without it the endpoint IGNORES
  // the `ids` param entirely and returns one unrelated event — which made every id
  // resolve as "not found" and blocked all rescheduling (spec ZMCP-20260827-001,
  // confirmed live 2026-08-27). No `status` filter: id-targeted resolution must be
  // status-neutral (`status=any` is a narrowing whitelist of scheduled+unplanned,
  // Collection/Events.php:299-302, that would silently drop a `finished` session).
  const raw = await zoozaFetch<ApiListResponse<EventRecord> | EventRecord[]>(
    "/events",
    {
      query: {
        filter: "filter",
        ids: ids.join("|"),
        sort_by: "date_asc",
        page_size: ids.length,
      },
    },
    auth,
  );
  return unwrapList<EventRecord>(raw).records;
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
  "Edit specific individual sessions (events) of a class, OR add new sessions to a class. Two modes, one tool.\n\n" +
  "EDIT-MODE — pass `event_ids` + `changes`: reschedule a session's date/time, or change a hand-picked " +
  "session's instructor, venue/room, block, or duration. Works on one session or a chosen set.\n\n" +
  "ADD-MODE — pass `schedule_id` + `sessions`: CREATE one or more new sessions on an existing class (e.g. " +
  "\"add one more session at the end\", \"add a make-up class on 2026-05-04\"). Each new session needs a `date`; " +
  "its time, duration, trainer, venue and room default from the class. To append after the last session, first " +
  "resolve the class's latest session with sessions_find_events, then pass the next date. New sessions are " +
  "created billable so a priced class keeps charging.\n\n" +
  "The two modes are mutually exclusive — send event_ids/changes OR schedule_id/sessions, never both.\n\n" +
  "TWO CALLS either way. First WITHOUT `token`: returns a preview (per-session before→after for edits, or the " +
  "list of sessions to be created for adds) plus a single-use token. Show it to the operator and get explicit " +
  "approval (and, if `notify` is set, confirm that clients will be emailed). Then call again with `token` + " +
  "`confirmed: true` to apply — send nothing else, the plan is frozen.\n\n" +
  "Use EDIT-MODE when the user points at particular sessions (\"move next Tuesday's class to Wednesday 5pm\", " +
  "\"give Friday's session to Jana\"). To change an attribute across ALL or all upcoming sessions of a class in " +
  "one go, use classes_update with session_scope instead. To cancel sessions, use the cancellation tools — this " +
  "tool does not cancel.";

export const sessionsUpdateInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  event_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .optional()
    .describe(
      "EDIT-MODE. Existing session ids to change; pair with `changes`. Resolve with sessions_find_events. " +
        "Not with schedule_id/sessions.",
    ),
  changes: changesSchema.optional().describe("EDIT-MODE. The edits to apply to `event_ids`."),
  schedule_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "ADD-MODE. Class to append NEW sessions to; pair with `sessions`. Resolve with classes_find_classes. " +
        "Not with event_ids/changes.",
    ),
  sessions: z
    .array(sessionAddSpecSchema)
    .nonempty()
    .optional()
    .describe(
      "ADD-MODE. New sessions to create on `schedule_id`. Each needs a date; time/duration default from the " +
        "class. For \"one more at the end\", get the last session via sessions_find_events and pass the next date.",
    ),
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
    const args =
      rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
    const isAdd = args.schedule_id !== undefined || args.sessions !== undefined;
    const isEdit = args.event_ids !== undefined || args.changes !== undefined;
    if (isAdd && isEdit) {
      return errorResult(
        "Provide EITHER event_ids + changes (edit existing sessions) OR schedule_id + sessions " +
          "(add new sessions) — not both in one call.",
      );
    }
    if (isAdd) {
      return runSessionsPrepareAdd(rawInput, auth);
    }
    return runSessionsPrepareUpdate(rawInput, auth);
  }
  return runSessionsCommitUpdate({ token: decision.token }, auth);
}
