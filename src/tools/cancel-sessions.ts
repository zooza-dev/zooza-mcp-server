import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { getCallerContext } from "./caller-context.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import type { ApiListResponse } from "./types.js";
import {
  getUpdatePlan,
  markUpdatePlanUsed,
  saveUpdatePlan,
  type SessionsCancelPlan,
} from "./update-plan-store.js";

// ── guard limits (spec ZMCP-20260921-001) ─────────────────────────────────────
// Operator-chosen caps, deliberately low. A wider cancellation is a bulk operation
// that belongs in the app, where the whole affected set is on screen at once.
export const MAX_SPAN_DAYS = 7;
export const MAX_SESSIONS = 20;
export const MAX_CLIENTS = 150;

/** api-v1 roles that hold `edit_course` (class/User.php:749-750). Everyone else
 *  gets `low_permissions` from the router, so we refuse in the preview phase with
 *  an explanation instead of letting the commit fail after the operator approved. */
const ROLES_THAT_MAY_CANCEL = new Set(["owner", "assistant"]);

/** Attendance values that DO travel to a make-up session. api-v1's
 *  Attendance::move_attendees() (class/Attendance.php:2674-2695) loops the
 *  attending rows and `continue`s on anything that is not `going` — verified
 *  against production data 2026-09-21: on manually cancelled sessions with a
 *  replacement, 2 992 origin rows are `canceled` (the flip the move performs)
 *  while 914 rows in other states kept their value, and all 5 `waitlist` rows
 *  had no row on the replacement at all. */
const MOVES_TO_REPLACEMENT = "going";

export const cancelSessionsTitle = "Cancel sessions (preview, then apply)";

export const cancelSessionsDescription =
  "Cancel one or more scheduled SESSIONS of a class so they do not take place — \"cancel Tuesday's sessions\", " +
  "\"the pool is closed on Friday\", \"Martina is ill all week, cancel her classes\". A cancelled session stays " +
  "visible in Zooza with a cancelled status; it is NOT deleted.\n\n" +
  "Scope the call to exactly ONE entity: `event_ids`, a single `date`, a single `trainer_id` with `from`/`to`, a " +
  "single `schedule_id` with `from`/`to`, or a single `place_id` with a `date`. Two instructors or two classes in " +
  "one call are refused by design — cancel them one at a time so each blast radius is reviewed on its own. " +
  `At most ${MAX_SPAN_DAYS} days, ${MAX_SESSIONS} sessions and ${MAX_CLIENTS} affected clients per call.\n\n` +
  "TWO CALLS. First WITHOUT `token`: returns every affected session, the client count, how many emails would be " +
  "sent, and what will NOT happen — plus a single-use token. Show that to the operator and get explicit approval. " +
  "Then call again with `token` + `confirmed: true` to apply; send nothing else, the plan is frozen.\n\n" +
  "`reason` is required and is recorded for staff only. `public_reason` is what clients read and is required when " +
  "`notify` is true — one email per session per client, so five sessions in a class of 25 is 125 messages; the " +
  "preview states the exact count either way.\n\n" +
  "Optionally create a make-up session with `replacement_date`, which moves the attendees onto the new date. " +
  "Allowed ONLY when exactly one session is in scope, because a make-up date belongs to one session. Attendees " +
  "who already have attendance marked (attended / no-show) and anyone waitlisted do NOT move — the preview counts " +
  "them.\n\n" +
  "Sessions that already happened are left out unless you pass `include_past: true`. Only owners and assistants " +
  "can cancel; other roles are refused with an explanation.\n\n" +
  "This tool does NOT un-cancel a session, does NOT delete sessions (cancelling and deleting are different " +
  "verbs in Zooza), does NOT cancel ONE client's booking on a session — that is `sessions_mark_attendance` with " +
  "`attendance: 'canceled'`, and that is the path that issues make-up credits — and does NOT reschedule anything " +
  "(`sessions_update`). Cancelling a session issues no make-up credits to anyone.";

export const cancelSessionsInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  event_ids: z
    .array(z.number().int().positive())
    .nonempty()
    .optional()
    .describe(
      "SCOPE. Exact sessions, at most 7 days apart. Resolve with sessions_find_events. The only scope that " +
        "may cross classes and instructors.",
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "SCOPE. One whole day, YYYY-MM-DD, company-wide unless place_id narrows it.",
    ),
  trainer_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "SCOPE. ONE instructor, with from/to. Resolve with classes_find_resource kind:'trainer'.",
    ),
  schedule_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "SCOPE. ONE class, with from/to. Resolve with classes_find_classes.",
    ),
  place_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "SCOPE. ONE venue, with date. Resolve with classes_find_resource kind:'place'.",
    ),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Inclusive range start, YYYY-MM-DD. Only with trainer_id or schedule_id."),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Inclusive range end, YYYY-MM-DD."),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "REQUIRED. Internal, staff-only; Zooza cannot clear it later.",
    ),
  public_reason: z
    .string()
    .optional()
    .describe(
      "Client-facing email text. Required when notify is true.",
    ),
  notify: z
    .boolean()
    .optional()
    .describe(
      "Default false. Set it on the FIRST call; it is frozen into the plan.",
    ),
  include_past: z
    .boolean()
    .optional()
    .describe(
      "Default false — past sessions are skipped and reported.",
    ),
  replacement_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)
    .optional()
    .describe(
      "Make-up session date, \"YYYY-MM-DD HH:MM:SS\" — time defaults to the cancelled session's own. One " +
        "session in scope only.",
    ),
  replacement_place_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Make-up venue. Defaults to the cancelled session's."),
  replacement_room_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Make-up room; needs replacement_place_id. 0 = no room."),
};

const previewInput = z.object({
  company_id: companyIdSchema,
  event_ids: z.array(z.number().int().positive()).nonempty().optional(),
  date: z.string().optional(),
  trainer_id: z.number().int().positive().optional(),
  schedule_id: z.number().int().positive().optional(),
  place_id: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string().min(1).optional(),
  public_reason: z.string().optional(),
  notify: z.boolean().optional(),
  include_past: z.boolean().optional(),
  replacement_date: z.string().optional(),
  replacement_place_id: z.number().int().positive().optional(),
  replacement_room_id: z.number().int().nonnegative().optional(),
});

/** Loose view of a RAW /v1/events row. The names here are api-v1's own, verified
 *  against find-events.ts's projection (which is where they were confirmed live):
 *  attendance counts arrive as `__calc__attendance__*`, capacity is nested under
 *  `schedule`, and the trainer's name is a materialised `__calc__` column. Reading
 *  the *projected* names (`attendance_counts`, `capacity`, `trainer_name`) off a raw
 *  row silently yields 0 / "" — which is exactly the defect found while testing
 *  through Claude on 2026-09-21, where a session with 37 enrolled previewed as 0. */
interface EventRow {
  id?: number | string;
  date?: string;
  status?: string;
  schedule_id?: number | string;
  trainer_id?: number | string;
  place_id?: number | string;
  replaced_by?: number | string;
  __calc__attendance__going?: number | string;
  __calc__attendance__attended?: number | string;
  __calc__attendance__noshow?: number | string;
  __calc__attendance__canceled?: number | string;
  __calc__attendance__canceled_late?: number | string;
  __calc__attendance__waitlist?: number | string;
  __calc__event_trainer?: string;
  course?: { name?: string };
  schedule?: { name?: string; capacity?: number | string };
  [k: string]: unknown;
}

/** One preview row, as the operator reads it. */
export interface CancelPreviewSession {
  event_id: number;
  date: string;
  schedule_id: number;
  class_name: string;
  trainer_name: string;
  going: number;
  capacity: number;
}

type ScopeKind = "event_ids" | "date" | "trainer" | "schedule" | "place";

interface ResolvedScope {
  kind: ScopeKind;
  label: string;
  query: Record<string, string | number>;
  /** Days the range spans, 1 for a single day. */
  spanDays: number;
}

/** Live attendance counts for one session, read from the register rather than
 *  from the materialised `__calc__attendance__*` columns.
 *
 *  Those columns are recomputed asynchronously and were plainly wrong on the
 *  session this was found with (2026-09-21): the register held 1 `going` + 4
 *  `attended` rows while the column said 0, so the preview reported "0 clients
 *  affected" for a session that had five people on it, and the client cap was
 *  measured against a zero. find-events already warns the counters may be stale;
 *  for a destructive action the operator's decision number cannot be stale. */
export interface LiveCounts {
  /** Enrolled and expecting to attend: an explicit `going`, plus rows nobody has
   *  marked yet — the register lists them, so they think the class is happening. */
  expected: number;
  /** Rows that would actually travel to a make-up session: `going` only.
   *  api-v1's move_attendees skips everything else (class/Attendance.php:2674). */
  moving: number;
  /** Enrolled but staying on the cancelled session: marked attended / no-show,
   *  waitlisted, or simply unmarked. None of these are moved. */
  staying: number;
  /** False when the register could not be read and the figures fall back to the
   *  materialised columns. */
  live: boolean;
}

const ALREADY_OFF = new Set(["canceled", "canceled_late", "deleted", "ignore"]);

export function countRegisterForTest(rows: Array<{ attendance?: string | null }>): LiveCounts {
  let expected = 0;
  let moving = 0;
  let staying = 0;
  for (const row of rows) {
    const value = (row.attendance ?? "").trim();
    if (ALREADY_OFF.has(value)) continue;
    if (value === MOVES_TO_REPLACEMENT) {
      expected += 1;
      moving += 1;
      continue;
    }
    // Unmarked rows count as expected — the register lists them and nobody told
    // them otherwise — but they do NOT move to a make-up session.
    expected += 1;
    staying += 1;
  }
  return { expected, moving, staying, live: true };
}

/** Fallback when the register cannot be read: the materialised columns, flagged
 *  as not live so the preview can say so out loud. */
function countFromMaterialised(row: EventRow): LiveCounts {
  const going = toNum(row.__calc__attendance__going);
  const staying =
    toNum(row.__calc__attendance__attended) +
    toNum(row.__calc__attendance__noshow) +
    toNum(row.__calc__attendance__waitlist);
  return { expected: going + staying, moving: going, staying, live: false };
}

/** One register read per session, in parallel. Bounded by MAX_SESSIONS, which is
 *  checked before this runs. */
async function fetchLiveCounts(
  rows: EventRow[],
  auth: ZoozaAuth,
): Promise<Map<number, LiveCounts>> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const id = toNum(row.id);
      try {
        const raw = await zoozaFetch<
          ApiListResponse<{ attendance?: string | null }> | Array<{ attendance?: string | null }>
        >("/attendance", { query: { event_id: id } }, auth);
        return [id, countRegisterForTest(unwrapList<{ attendance?: string | null }>(raw).records)] as const;
      } catch {
        return [id, countFromMaterialised(row)] as const;
      }
    }),
  );
  return new Map(entries);
}

export async function runCancelSessions(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "preview") return previewCancel(rawInput, auth);
  return applyCancel(decision.token, auth);
}

// ── preview ───────────────────────────────────────────────────────────────────

async function previewCancel(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = previewInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  if (!input.reason || input.reason.trim() === "") {
    return errorResult(
      "reason is required: every cancelled session records an internal reason for staff, and api-v1 cannot " +
        "clear it afterwards. Ask the operator why the sessions are cancelled, then call again.",
    );
  }
  if (input.notify === true && (!input.public_reason || input.public_reason.trim() === "")) {
    return errorResult(
      "notify: true emails clients a notice that quotes public_reason — without it they receive a bare " +
        "\"cancelled\" message. Add public_reason, or set notify: false.",
    );
  }

  const scope = resolveScope(input);
  if ("error" in scope) return errorResult(scope.error);

  if (scope.spanDays > MAX_SPAN_DAYS) {
    return errorResult(
      `That range spans ${scope.spanDays} days; the limit is ${MAX_SPAN_DAYS}. Narrow the range, or cancel ` +
        "week by week so each batch is reviewed on its own.",
    );
  }

  const callAuth = withCompany(auth, input.company_id!);

  // Role first: only owner/assistant hold `edit_course` upstream, and finding that
  // out AFTER the operator approved a preview is the worst possible moment.
  try {
    const caller = await getCallerContext(callAuth);
    if (caller.role !== null && !ROLES_THAT_MAY_CANCEL.has(caller.role)) {
      return errorResult(
        `Your Zooza role (${caller.role}) cannot cancel sessions — only owners and assistants can. Ask an ` +
          "owner to cancel this, or do it in the Zooza app if your role allows it there.",
      );
    }
  } catch (error) {
    return zoozaError(error, "Could not establish whether your role may cancel sessions");
  }

  let rows: EventRow[];
  try {
    rows = await fetchScopedEvents(scope, callAuth);
  } catch (error) {
    return zoozaError(error, "Could not resolve the sessions to cancel");
  }

  if (rows.length === 0) {
    return errorResult(
      `No sessions matched ${scope.label}. Check the dates and ids with sessions_find_events — with no ` +
        "filters it returns upcoming sessions, and any filter returns the full matching set.",
    );
  }

  // Partition: already cancelled, past, and actually cancellable.
  const now = Date.now();
  const alreadyCancelled: EventRow[] = [];
  const past: EventRow[] = [];
  const target: EventRow[] = [];
  for (const row of rows) {
    const status = pickStr(row.status) ?? "";
    if (status === "unplanned") {
      alreadyCancelled.push(row);
      continue;
    }
    if (!input.include_past && isPast(row.date, now)) {
      past.push(row);
      continue;
    }
    target.push(row);
  }

  if (target.length === 0) {
    const bits: string[] = [];
    if (alreadyCancelled.length > 0) bits.push(`${alreadyCancelled.length} already cancelled`);
    if (past.length > 0) bits.push(`${past.length} already happened`);
    return errorResult(
      `Nothing left to cancel in ${scope.label} — ${bits.join(", ")}.` +
        (past.length > 0
          ? " To cancel sessions that already happened, call again with include_past: true."
          : ""),
    );
  }

  // The span cap has to be re-checked on what actually resolved, not only on a
  // from/to the caller typed. An `event_ids` list carries no range to pre-check, so
  // without this the documented 7-day limit simply would not apply to it — a model
  // can hand over 20 ids spread across a year. Found while testing through Claude
  // (2026-09-21), where it reshaped 11 per-day calls into 3 id-list calls.
  const resolvedSpan = spanOfDates(target.map((row) => pickStr(row.date) ?? ""));
  if (resolvedSpan > MAX_SPAN_DAYS) {
    const days = target
      .map((row) => (pickStr(row.date) ?? "").slice(0, 10))
      .filter(Boolean)
      .sort();
    return errorResult(
      `Those sessions span ${resolvedSpan} days (${days[0]} to ${days[days.length - 1]}); the limit is ` +
        `${MAX_SPAN_DAYS}. Split them into windows of at most ${MAX_SPAN_DAYS} days so each batch is ` +
        "reviewed on its own.",
    );
  }

  if (target.length > MAX_SESSIONS) {
    return errorResult(
      `${target.length} sessions matched; the limit is ${MAX_SESSIONS}. Narrow the scope — add a schedule_id, ` +
        "or shorten the range.",
    );
  }

  // Live register reads — one per session, in parallel, after the session cap has
  // bounded the fan-out. The client count is the operator's decision number, so it
  // is not taken from a materialised column (see LiveCounts).
  const counts = await fetchLiveCounts(target, callAuth);
  const countFor = (row: EventRow): LiveCounts =>
    counts.get(toNum(row.id)) ?? countFromMaterialised(row);
  const approximate = target.some((row) => !countFor(row).live);

  const clients = target.reduce((sum, row) => sum + countFor(row).expected, 0);
  if (clients > MAX_CLIENTS) {
    return errorResult(
      `${clients} clients would be affected across ${target.length} sessions; the limit is ${MAX_CLIENTS}. ` +
        "Cancel in smaller batches so each notification volume is reviewed.",
    );
  }

  if (input.replacement_date !== undefined && target.length !== 1) {
    return errorResult(
      `A make-up date belongs to ONE session, but ${target.length} are in scope. Cancel the session that needs ` +
        "a make-up date on its own, or drop replacement_date and compensate another way.",
    );
  }
  if (input.replacement_room_id !== undefined && input.replacement_place_id === undefined) {
    return errorResult(
      "replacement_room_id needs replacement_place_id — api-v1 only moves the venue when both are sent.",
    );
  }

  // Attendees who will NOT travel to a make-up session: anyone whose attendance is
  // already marked, plus the waitlist. Only a `going` row moves.
  const stayingBehind =
    input.replacement_date !== undefined ? countFor(target[0]).staying : 0;

  const event_payloads = target.map((row) => {
    const id = toNum(row.id);
    const payload: Record<string, unknown> & { id: number } = {
      id,
      status: "unplanned",
      // Verified 2026-09-21 against production: api-v1's manual cancel path never
      // clears `billable` (894 unplanned events still carry it, 61 of them on
      // courses where `billable_events > 0` so it really prices), while the
      // auto-cancel worker does (class/Event.php:661-668). Sending it explicitly is
      // what stops a cancelled session from continuing to bill.
      billable: false,
      cancellation_reasoning: input.reason,
    };
    if (input.public_reason && input.public_reason.trim() !== "") {
      payload.cancellation_reasoning_public = input.public_reason;
    }
    if (input.notify === true) payload.notify = true;
    if (input.replacement_date !== undefined) {
      payload.replacement_date = normaliseReplacementDate(input.replacement_date, row.date);
      if (input.replacement_place_id !== undefined) {
        payload.replacement_place_id = input.replacement_place_id;
        payload.replacement_room_id = input.replacement_room_id ?? 0;
      }
    }
    return payload;
  });

  const warnings: string[] = [];
  if (alreadyCancelled.length > 0) {
    warnings.push(
      `${alreadyCancelled.length} session(s) in this scope are already cancelled and will be skipped.`,
    );
  }
  if (past.length > 0) {
    warnings.push(
      `${past.length} session(s) already happened and were left out. Pass include_past: true to cancel them too.`,
    );
  }
  if (stayingBehind > 0) {
    warnings.push(
      `${stayingBehind} enrolled attendee(s) will NOT move to the make-up session — only a "going" row ` +
        "travels, so anyone already marked attended / no-show, waitlisted, or simply unmarked keeps their " +
        "place on the cancelled session and holds no seat on the new one.",
    );
  }
  if (input.replacement_date !== undefined) {
    warnings.push(
      "A make-up date after the class's last session extends the class's date range to cover it — observed " +
        "live 2026-09-21, where a 2022 class gained an end date in 2026. Check anything keyed off that range.",
    );
    warnings.push(
      "api-v1 swallows a failed make-up creation, so the cancel can succeed with no make-up session. This tool " +
        "reads the session back and reports whether it was really created.",
    );
  }
  // The loudest thing this preview can say: people are enrolled and nothing will
  // reach them. Zooza sends no cancellation mail of its own, so silence here is
  // final — the client finds out by turning up to a class that is not happening.
  if (clients > 0 && input.notify !== true) {
    warnings.push(
      `${clients} enrolled client(s) will NOT be told: notify is off and Zooza sends nothing on its own. ` +
        "They would only find out by turning up, unless you reach them another way.",
    );
  }
  if (approximate) {
    warnings.push(
      "The attendance register could not be read for every session, so these client counts fall back to " +
        "Zooza's cached counters and may be out of date. Re-run the preview, or check the session in Zooza.",
    );
  }
  warnings.push("Cancelling issues no make-up credits — nobody's credit balance changes.");

  const summary = {
    scope: { kind: scope.kind, description: scope.label },
    sessions: target.map((row) => ({ ...projectSessionRow(row), going: countFor(row).expected })),
    totals: {
      sessions_to_cancel: target.length,
      clients_affected: clients,
      already_cancelled_skipped: alreadyCancelled.length,
      past_skipped: past.length,
    },
    notification: {
      will_send: input.notify === true,
      messages: input.notify === true ? clients : 0,
      messages_if_enabled: clients,
    },
    replacement:
      input.replacement_date === undefined
        ? null
        : {
            date: normaliseReplacementDate(input.replacement_date, target[0].date),
            moves_attendees: countFor(target[0]).moving,
            staying_on_the_cancelled_session: stayingBehind,
          },
    reason: input.reason,
    public_reason: input.public_reason ?? null,
    warnings,
  };

  const plan: SessionsCancelPlan = {
    kind: "sessions_cancel",
    company_id: input.company_id!,
    event_payloads,
    verify_replacement: input.replacement_date !== undefined,
    summary,
  };
  const { token, expires_in_seconds } = saveUpdatePlan(plan);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          phase: "preview",
          token,
          expires_in_seconds,
          ...summary,
          next_step:
            "Show this to the operator. On approval call sessions_cancel again with the token and " +
            "confirmed: true, and nothing else.",
        }),
      },
    ],
  };
}

// ── apply ─────────────────────────────────────────────────────────────────────

async function applyCancel(
  token: string,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const lookup = getUpdatePlan(token);
  if (!lookup.ok) {
    return errorResult(
      "This cancellation plan is no longer valid (tokens are single-use and expire after 15 minutes — this one " +
        `is ${lookup.reason}). Call sessions_cancel again and re-confirm with the operator.`,
    );
  }
  if (lookup.plan.kind !== "sessions_cancel") {
    return errorResult("This token is not a cancellation plan. Use the tool that produced it.");
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);
  const requestedIds = plan.event_payloads.map((p) => p.id);

  let raw: unknown;
  try {
    raw = await zoozaFetch<unknown>(
      "/events",
      { method: "PUT", body: { events: plan.event_payloads } },
      callAuth,
    );
  } catch (error) {
    return zoozaError(
      error,
      `Could not cancel the session(s) (${requestedIds.join(", ")}). Nothing was confirmed — you may retry ` +
        "sessions_cancel once with the same token",
    );
  }
  markUpdatePlanUsed(token);

  const rowOutcomes = readBatchOutcomes(raw, requestedIds);

  // The batch reports `updated: true` without proving the status changed, and it
  // swallows a failed make-up creation entirely. Read the sessions back so the
  // answer to the operator is observed rather than assumed.
  let verified: Map<number, { status: string; replaced_by: number }> | null = null;
  try {
    const after = await fetchEventsByIds(requestedIds, callAuth);
    verified = new Map(
      after.map((row) => [
        toNum(row.id),
        { status: pickStr(row.status) ?? "", replaced_by: toNum(row.replaced_by) },
      ]),
    );
  } catch {
    verified = null;
  }

  const cancelled: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  for (const id of requestedIds) {
    const outcome = rowOutcomes.get(id);
    if (outcome && outcome.updated === false) {
      failed.push({ event_id: id, message: outcome.message || "api-v1 reported the row as not updated" });
      continue;
    }
    const check = verified?.get(id);
    cancelled.push({
      event_id: id,
      verified: check ? check.status === "unplanned" : null,
      ...(plan.verify_replacement
        ? { replacement_created: check ? check.replaced_by > 0 : null }
        : {}),
    });
  }

  const notes: string[] = [];
  if (verified === null) {
    notes.push(
      "The verification read failed, so `verified` is null: the cancellation was sent and api-v1 accepted it, " +
        "but this tool did not confirm the new status. Check in Zooza before telling clients.",
    );
  }
  if (plan.verify_replacement && cancelled.some((c) => c.replacement_created === false)) {
    notes.push(
      "The make-up session was NOT created — api-v1 swallowed the failure. The session is cancelled and the " +
        "attendees were not moved. Create the make-up session with sessions_update (add-mode).",
    );
  }
  if (failed.length > 0) {
    notes.push(
      "The cancelled sessions stand — do not re-run the whole batch; re-resolve only the failed ids.",
    );
  }

  const summaryNotify = (plan.summary as { notification?: { will_send?: boolean; messages?: number } })
    .notification;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          phase: "applied",
          cancelled,
          failed,
          totals: {
            requested: requestedIds.length,
            cancelled: cancelled.length,
            failed: failed.length,
          },
          notification: {
            sent: summaryNotify?.will_send === true,
            messages: summaryNotify?.will_send === true ? (summaryNotify?.messages ?? 0) : 0,
          },
          ...(notes.length > 0 ? { notes } : {}),
        }),
      },
    ],
  };
}

// ── scope resolution + guards ─────────────────────────────────────────────────

/** Exactly one scope, and the range only where a range makes sense. Exported for
 *  unit tests — the guard text is part of the tool's contract. */
export function resolveScope(input: {
  event_ids?: number[];
  date?: string;
  trainer_id?: number;
  schedule_id?: number;
  place_id?: number;
  from?: string;
  to?: string;
}): ResolvedScope | { error: string } {
  const hasRange = input.from !== undefined || input.to !== undefined;
  const given: ScopeKind[] = [];
  if (input.event_ids !== undefined) given.push("event_ids");
  if (input.trainer_id !== undefined) given.push("trainer");
  if (input.schedule_id !== undefined) given.push("schedule");
  // `place_id` + `date` is ONE scope, not two — a venue closing for a day.
  if (input.place_id !== undefined) given.push("place");
  else if (input.date !== undefined) given.push("date");

  if (given.length === 0) {
    return {
      error:
        "No sessions selected. Pick exactly one scope: event_ids, a single date, a single trainer_id with " +
        "from/to, a single schedule_id with from/to, or a single place_id with a date.",
    };
  }
  if (given.length > 1) {
    return {
      error:
        `Cancel one entity at a time. You sent ${given.length} scopes (${given.join(", ")}). Cancel each ` +
        "separately so its effect is reviewed on its own.",
    };
  }

  const kind = given[0];

  if (kind === "event_ids") {
    if (hasRange || input.date !== undefined) {
      return {
        error:
          "event_ids already names the exact sessions — drop date/from/to, or drop event_ids and scope by " +
          "date or entity instead.",
      };
    }
    return {
      kind,
      label: `the ${input.event_ids!.length} session(s) you listed`,
      query: { filter: "filter", ids: input.event_ids!.join("|"), page_size: input.event_ids!.length },
      spanDays: 1,
    };
  }

  if (kind === "date") {
    if (hasRange) {
      return {
        error:
          "Use either a single date or from/to with an entity, not both. A whole day company-wide is `date` " +
          "on its own.",
      };
    }
    return {
      kind,
      label: `${input.date}`,
      query: { filter: "filter", date: input.date!, status: "any", page_size: 200 },
      spanDays: 1,
    };
  }

  if (kind === "place") {
    if (input.date === undefined) {
      return {
        error:
          "place_id needs a date — \"the hall is closed on Friday\" is one venue on one day. For a longer " +
          "closure, cancel each day separately, or scope by schedule_id.",
      };
    }
    if (hasRange) {
      return { error: "place_id pairs with a single date, not from/to." };
    }
    return {
      kind,
      label: `venue ${input.place_id} on ${input.date}`,
      query: {
        filter: "filter",
        date: input.date,
        place_id: input.place_id!,
        status: "any",
        page_size: 200,
      },
      spanDays: 1,
    };
  }

  // trainer | schedule — both need an explicit range, and a bare range is refused.
  if (input.from === undefined || input.to === undefined) {
    return {
      error:
        `${kind === "trainer" ? "trainer_id" : "schedule_id"} needs both from and to — an open-ended ` +
        "cancellation has no reviewable blast radius. Add the range, or use `date` for a single day.",
    };
  }
  const spanDays = dayCount(input.from, input.to);
  if (spanDays <= 0) {
    return { error: `from (${input.from}) must be on or before to (${input.to}).` };
  }
  const idKey = kind === "trainer" ? "trainer_id" : "schedule_id";
  const idVal = kind === "trainer" ? input.trainer_id! : input.schedule_id!;
  return {
    kind,
    label: `${idKey} ${idVal} from ${input.from} to ${input.to}`,
    query: {
      filter: "filter",
      [idKey]: idVal,
      from: input.from,
      to: input.to,
      status: "any",
      page_size: 200,
    },
    spanDays,
  };
}

async function fetchScopedEvents(scope: ResolvedScope, auth: ZoozaAuth): Promise<EventRow[]> {
  const raw = await zoozaFetch<ApiListResponse<EventRow> | EventRow[]>(
    "/events",
    { query: { ...scope.query, sort_by: "date_asc" } },
    auth,
  );
  return unwrapList<EventRow>(raw).records;
}

async function fetchEventsByIds(ids: number[], auth: ZoozaAuth): Promise<EventRow[]> {
  // `filter=filter` is REQUIRED or api-v1 ignores `ids` entirely and returns one
  // unrelated event (spec ZMCP-20260827-001). Status-neutral on purpose: the
  // read-back must see whatever the rows actually became.
  const raw = await zoozaFetch<ApiListResponse<EventRow> | EventRow[]>(
    "/events",
    { query: { filter: "filter", ids: ids.join("|"), page_size: ids.length } },
    auth,
  );
  return unwrapList<EventRow>(raw).records;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Inclusive span covered by a set of event dates; 0 when none parse. Exported
 *  for the guard tests. */
export function spanOfDates(dates: string[]): number {
  const days = dates
    .map((d) => d.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (days.length === 0) return 0;
  return dayCount(days[0], days[days.length - 1]);
}

/** Inclusive day count between two YYYY-MM-DD dates; 1 for the same day. */
export function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

function isPast(date: string | undefined, now: number): boolean {
  if (!date) return false;
  const t = Date.parse(`${date.slice(0, 10)}T${date.slice(11, 19) || "00:00:00"}Z`);
  return Number.isFinite(t) && t < now;
}

/** Enrolled attendees on this session — the number the whole preview exists to
 *  show, and what the client cap is measured against. */
export function goingCount(row: EventRow): number {
  return toNum(row.__calc__attendance__going);
}

/** Attendees who will NOT travel to a make-up session. Only a `going` row moves
 *  (see MOVES_TO_REPLACEMENT), and `canceled` / `canceled_late` are already off
 *  this session, so what stays behind is the marked-and-waitlisted remainder. */
export function nonMovingCount(row: EventRow): number {
  return (
    toNum(row.__calc__attendance__attended) +
    toNum(row.__calc__attendance__noshow) +
    toNum(row.__calc__attendance__waitlist)
  );
}

/** Project a raw row into the shape the preview shows. Exported so a test can
 *  assert it against a realistic raw row rather than against our own guesses. */
export function projectSessionRow(row: EventRow): CancelPreviewSession {
  return {
    event_id: toNum(row.id),
    date: pickStr(row.date) ?? "",
    schedule_id: toNum(row.schedule_id),
    class_name: pickStr(row.schedule?.name) ?? pickStr(row.course?.name) ?? "",
    trainer_name: pickStr(row.__calc__event_trainer) ?? "",
    going: goingCount(row),
    capacity: toNum(row.schedule?.capacity),
  };
}

/** api-v1 parses `replacement_date` with Utils::DATE_FORMAT_FULL and silently
 *  ignores anything it cannot read, so we always send a complete datetime —
 *  falling back to the cancelled session's own time when only a date was given. */
function normaliseReplacementDate(input: string, originDate: string | undefined): string {
  const datePart = input.slice(0, 10);
  const timeInInput = input.length > 10 ? input.slice(11, 19) : "";
  if (/^\d{2}:\d{2}:\d{2}$/.test(timeInInput)) return `${datePart} ${timeInInput}`;
  if (/^\d{2}:\d{2}$/.test(timeInInput)) return `${datePart} ${timeInInput}:00`;
  const originTime = originDate && originDate.length >= 19 ? originDate.slice(11, 19) : "00:00:00";
  return `${datePart} ${originTime}`;
}

interface BatchOutcome {
  updated: boolean;
  message: string;
}

/** api-v1's batch returns `[{id, updated, message}]`. An unknown shape is treated
 *  as "no per-row information", which leaves the read-back as the only evidence. */
function readBatchOutcomes(raw: unknown, requested: number[]): Map<number, BatchOutcome> {
  const out = new Map<number, BatchOutcome>();
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : null;
  if (!rows) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { id?: unknown; updated?: unknown; message?: unknown };
    const id = toNum(r.id);
    if (!requested.includes(id)) continue;
    out.set(id, {
      updated: r.updated !== false,
      message: typeof r.message === "string" ? r.message : "",
    });
  }
  return out;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
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
