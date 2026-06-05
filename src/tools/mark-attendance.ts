import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { type CallerContext, getCallerContext } from "./caller-context.js";
import { companyIdSchema, TRIAL_STATUSES, unwrapList } from "./common.js";
import { projectSummaryState } from "./get-attendance.js";
import type {
  MarkAttendanceResult,
  MarkAttendanceRow,
  RawAttendanceRow,
  RawEventDetail,
} from "./types.js";

const ATTENDANCE_VALUES = [
  "attended",
  "noshow",
  "canceled",
  "going",
  "ignore",
] as const;

export const markAttendanceTitle = "Mark per-attendee attendance on one event";

export const markAttendanceDescription =
  "Record per-attendee attendance for **one event** (a single session of a class — e.g. \"Monday Ballet on 2026-06-03 at 09:00\"). Pass an `event_id` and a list of attendees, each with their own attendance value (`attended`, `noshow`, `canceled`, `going`, `ignore`). Each value is set on **that one attendee for that one event**, never on the event as a whole. The tool writes each attendee individually and returns a per-row outcome. Use this **after** you already know the event and the attendees you want to mark — typically because the user dictated them or because you previously called `get_attendance`. If you don't yet know which event or who's enrolled, call `find_events` or `get_attendance` first. This tool does **not** cancel or reschedule the event itself or handle trialist follow-ups — those are separate tools.\n\n**Follow-up chaining.** The response includes a top-level `summary` block with `public_set` / `internal_set` / `writable_by_caller` flags. After a successful mark, if `summary.public_set=false` AND `summary.writable_by_caller=true`, proactively offer the user the option to write a parent-visible recap via `add_session_summary`. If `writable_by_caller=false`, don't offer (the caller's role can't write summaries). If `public_set=true`, don't volunteer an update unless asked.\n\n**Trial follow-ups.** A per-row `pending_action: \"trial_followup\"` (with `todo_id`) means that attendee just completed their trial by being marked `attended` — a follow-up (parent feedback + continuing-class recommendation) is now pending. Tell the user it's waiting and offer to handle it; the attendance skill resolves it against the todo. This tool only surfaces the hint — it does not orchestrate the follow-up. If the field is absent, there's nothing pending.\n\nAttendance value semantics:\n- `attended` — attendee was present.\n- `noshow` — attendee did not show up and did not warn.\n- `canceled` — attendee cancelled (admin-recorded). Triggers server-side make-up credit creation automatically when the programme allows it; do not call any other tool to issue credits.\n- `going` — pre-event RSVP / \"planning to attend.\" Restricted for member/receptionist roles under `trainer_attendance_management=\"limited\"`.\n- `ignore` — hide this event from the attendee's history (Zooza-specific; rare).\n\n`use_voucher` is a tentative V1 design: only meaningful when `attendance=\"going\"` AND `course.registration_type=\"open\"`. Check the attendee's `entrance_voucher.unused_entrance_vouchers > 0` (from `get_attendance`) before setting it to true; the server silently downgrades to cash debt when no voucher is available.";

const attendeeSchema = z.object({
  registration_id: z.number().int().positive(),
  attendance: z.enum(ATTENDANCE_VALUES),
  cancellation_reason: z.string().optional(),
  use_voucher: z.boolean().optional(),
});

export const markAttendanceInputSchema = {
  company_id: companyIdSchema,
  event_id: z
    .number()
    .int()
    .positive()
    .describe("Target event id (one session of a class). Required."),
  attendees: z
    .array(attendeeSchema)
    .min(1)
    .describe(
      "Per-attendee marks. At least one item required. Each item targets ONE attendee on the event by registration_id; the attendance value is set per attendee, not on the event as a whole.",
    ),
};

const inputSchema = z.object(markAttendanceInputSchema);

export async function runMarkAttendance(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  const callAuth = withCompany(auth, input.company_id!);

  // Pre-flight: attendance list + event (via collection path) in parallel.
  // Either failure aborts the whole call with a clean message rather than
  // fanning out N PUTs that will all fail identically. We use the collection
  // path /events?filter=filter&ids=N instead of /events/{id} because the
  // detail path returns a stubbed course block with track_attendance unset —
  // see get-attendance.ts for the same rationale.
  let enrolledRows: RawAttendanceRow[];
  let eventDetail: RawEventDetail | undefined;
  let caller: CallerContext | null = null;
  try {
    const [attendanceRaw, eventCollection, callerCtx] = await Promise.all([
      zoozaFetch<RawAttendanceRow[] | { data?: RawAttendanceRow[] }>(
        "/attendance",
        { query: { event_id: input.event_id } },
        callAuth,
      ),
      zoozaFetch<{ data?: RawEventDetail[] }>(
        "/events",
        { query: { filter: "filter", ids: String(input.event_id) } },
        callAuth,
      ),
      // Caller context is needed for summary.writable_by_caller in the
      // response hint; degrade to null on failure (writable_by_caller
      // falls back to false, which is safe).
      safeCallerContext(callAuth),
    ]);
    enrolledRows = unwrapList<RawAttendanceRow>(attendanceRaw).records;
    eventDetail = eventCollection?.data?.[0];
    caller = callerCtx;
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not load event ${input.event_id} pre-flight (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const trackAttendance = eventDetail?.course?.track_attendance;
  if (!isTrackable(trackAttendance)) {
    return errorResult(
      "track_attendance_disabled: Attendance tracking is disabled for this event's course — cannot mark.",
    );
  }

  const enrolledIndex = new Map<number, RawAttendanceRow>();
  for (const row of enrolledRows) {
    if (typeof row.registration_id === "number") {
      enrolledIndex.set(row.registration_id, row);
    }
  }

  // Sequential per the spec (small N typical, no parallelism needed for V1).
  // The api-v1 advisory lock per (registration, event, company) makes
  // each call idempotent, so a retry on transient failure is safe.
  const results: MarkAttendanceRow[] = [];
  for (const attendee of input.attendees) {
    if (!enrolledIndex.has(attendee.registration_id)) {
      results.push({
        registration_id: attendee.registration_id,
        attendance: attendee.attendance,
        status: "error",
        error_code: "not_enrolled",
        error_message: `Registration ${attendee.registration_id} is not enrolled in this class session (event ${input.event_id}).`,
      });
      continue;
    }

    const body: Record<string, unknown> = {
      action: "set_attendance",
      event_id: input.event_id,
      attendance: attendee.attendance,
    };
    if (attendee.cancellation_reason !== undefined) {
      body.cancellation_reason = attendee.cancellation_reason;
    }
    if (attendee.use_voucher !== undefined) {
      body.use_voucher = attendee.use_voucher;
    }

    try {
      await zoozaFetch<unknown>(
        `/registrations/${attendee.registration_id}`,
        { method: "PUT", body },
        callAuth,
      );
      results.push({
        registration_id: attendee.registration_id,
        attendance: attendee.attendance,
        status: "ok",
      });
    } catch (error) {
      const row = rowError(attendee.registration_id, attendee.attendance, error);
      results.push(row);
    }
  }

  // Deferred trial-follow-up hints (agreed handoff -20260527-001 / api
  // API-20260529-001). Marking `attended` on a trial's final session triggers a
  // server-side `trial_started → trial_ended` transition that creates a
  // `trial_followup` todo. `set_attendance`'s response shape is unchanged, so we
  // detect it with a follow-up read and echo a neutral per-row hint. Done AFTER
  // the write loop and in PARALLEL — the reads are independent and read-only, so
  // a slow todos endpoint never stalls the attendance writes. Best-effort: a
  // missing/erroring endpoint just omits the hint. Gated to attended-on-a-trial
  // rows (pre-flight attendance status) to avoid needless reads.
  const trialFollowupTargets = results.filter((r) => {
    if (r.status !== "ok" || r.attendance !== "attended") return false;
    const currentStatus = enrolledIndex.get(r.registration_id)?.status;
    return typeof currentStatus === "string" && TRIAL_STATUSES.has(currentStatus);
  });
  await Promise.all(
    trialFollowupTargets.map(async (r) => {
      const todoId = await findOpenTrialFollowupTodo(r.registration_id, callAuth);
      if (todoId !== null) {
        r.pending_action = "trial_followup";
        r.todo_id = todoId;
      }
    }),
  );

  const succeeded = results.filter((r) => r.status === "ok").length;
  const failed = results.length - succeeded;

  const result: MarkAttendanceResult = {
    event_id: input.event_id,
    total: results.length,
    succeeded,
    failed,
    results,
    summary: projectSummaryState(eventDetail, caller),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

async function safeCallerContext(auth: ZoozaAuth): Promise<CallerContext | null> {
  try {
    return await getCallerContext(auth);
  } catch {
    return null;
  }
}

/**
 * Pure: given the `GET /v1/todos/?...` response body and the registration we
 * marked, return the id of an OPEN `trial_followup` todo that actually belongs
 * to THAT registration, or null. Tolerates a bare array or a `{ data: [...] }`
 * envelope. We do NOT trust the endpoint's filtering — every match is verified
 * locally on `entity_type`/`entity_id`/`kind`/`status` so that an endpoint which
 * ignores an unknown query param (returning company-wide or closed todos) can't
 * cause us to echo a wrong or stale `todo_id`. `status` must be explicitly
 * `"open"` (a status-less or differently-cased row is not treated as open).
 * Exported for unit testing without a live endpoint.
 */
export function extractOpenTrialFollowupTodoId(
  body: unknown,
  registrationId: number,
): number | null {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : [];
  for (const t of rows) {
    if (!t || typeof t !== "object") continue;
    const todo = t as {
      id?: unknown;
      status?: unknown;
      kind?: unknown;
      entity_type?: unknown;
      entity_id?: unknown;
    };
    if (typeof todo.id !== "number") continue;
    if (todo.status !== "open") continue;
    if (todo.kind !== "trial_followup") continue;
    if (todo.entity_type !== "registration") continue;
    // entity_id may arrive as number or numeric string.
    if (Number(todo.entity_id) !== registrationId) continue;
    return todo.id;
  }
  return null;
}

/**
 * Best-effort lookup of an open trial_followup todo for a registration. Returns
 * the todo id or null. NEVER throws — if the endpoint isn't deployed yet, or any
 * read error occurs, we return null so the (already-successful) attendance write
 * is unaffected.
 */
async function findOpenTrialFollowupTodo(
  registrationId: number,
  auth: ZoozaAuth,
): Promise<number | null> {
  try {
    const body = await zoozaFetch<unknown>(
      "/todos",
      {
        query: {
          entity_type: "registration",
          entity_id: String(registrationId),
          kind: "trial_followup",
        },
      },
      auth,
    );
    return extractOpenTrialFollowupTodoId(body, registrationId);
  } catch {
    return null;
  }
}

/**
 * Project a per-call failure into the row report shape, preserving the
 * upstream error key (translation code) when api-v1 surfaces it so the
 * LLM can react to specific conditions like `low_permissions` or
 * `cancellation_limit_reached`.
 */
function rowError(
  registration_id: number,
  attendance: string,
  error: unknown,
): MarkAttendanceRow {
  if (error instanceof ZoozaApiError) {
    const { code, message } = extractApiError(error.responseText, error.humanMessage);
    return {
      registration_id,
      attendance,
      status: "error",
      error_code: code ?? `upstream_${error.status}`,
      error_message: message ?? error.humanMessage,
    };
  }
  return {
    registration_id,
    attendance,
    status: "error",
    error_code: "unknown",
    error_message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * api-v1 surfaces validation failures as `error_log_raw[].{key,val}`. The
 * key is the translation code (e.g. "low_permissions") and the val is the
 * already-i18n'd human message. ZoozaApiError keeps only the val; for the
 * per-row report we want both. Re-parse the response body locally rather
 * than expand the shared error type.
 */
function extractApiError(
  responseText: string,
  fallbackMessage: string,
): { code: string | null; message: string | null } {
  if (responseText.length === 0) return { code: null, message: fallbackMessage };
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    return { code: null, message: fallbackMessage };
  }
  if (!body || typeof body !== "object") {
    return { code: null, message: fallbackMessage };
  }
  const log = (body as { error_log_raw?: unknown }).error_log_raw;
  if (Array.isArray(log)) {
    for (const entry of log) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { key?: unknown; val?: unknown };
      const key = typeof e.key === "string" && e.key.length > 0 ? e.key : null;
      const val = typeof e.val === "string" && e.val.length > 0 ? e.val : null;
      if (key || val) return { code: key, message: val ?? fallbackMessage };
    }
  }
  return { code: null, message: fallbackMessage };
}

function isTrackable(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return false;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
