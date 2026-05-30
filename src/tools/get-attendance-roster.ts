import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import {
  type CallerContext,
  getCallerContext,
} from "./caller-context.js";
import { companyIdSchema, pickStr, TRIAL_STATUSES, unwrapList } from "./common.js";
import type {
  EventSummaryState,
  RawAttendancePerson,
  RawAttendanceRow,
  RawEventDetail,
  RosterAttendee,
  RosterAttendeeIdentity,
  RosterPerson,
  RosterResult,
  RosterVoucher,
} from "./types.js";

const SUMMARY_WRITER_ROLES = new Set(["owner", "assistant"]);

const ALL_ALLOWED = ["attended", "noshow", "canceled", "going", "ignore"] as const;
const RESTRICTED_ALLOWED = ["attended", "noshow", "ignore"] as const;

export const getAttendanceRosterTitle = "Get the attendance roster for one event";

export const getAttendanceRosterDescription =
  "Read the attendee roster for **one event** (a single session of a class). Pass an `event_id`; the tool returns who is enrolled, each attendee's current attendance value (if already marked), and per-row context the LLM needs to mark attendance correctly: `allowed_statuses[]` (the statuses the **current caller** is permitted to set for THIS attendee), `is_trial` / `is_last_trial_session` flags, warnings about cross-company or cascade-sensitive (full2) cases, and — for open-type registrations only — `entrance_voucher` info (how many unused vouchers the attendee has, and whether one is already spent on this event). Use this **before** `mark_attendance` whenever the user has not already dictated the full list of attendees and marks — typically: \"open the register for X,\" \"who's enrolled in tomorrow's class,\" \"show me Monday's roster.\" If the event's course has attendance tracking disabled, the tool returns an `attendance_tracking_disabled` error rather than an empty roster. This tool is read-only — it never writes attendance, notes, or summaries.\n\n**Attendee vs client (critical for children's-class programmes).** Each row carries TWO people:\n- `attendee` — who actually shows up to the session. Often a child (Zooza data-model name: `customer`). May have `user_id: 0` when they aren't a registered account holder, which is normal for children. `attendee.date_of_birth` is available.\n- `client` — the account holder / payer (Zooza data-model name: `buyer`). Usually the parent. Has a real `user_id`. Contact info (`email`, `phone`) lives on the client when the attendee is a child; copy from client when speaking to / messaging the family.\n- `display_name` — a pre-formatted one-line label. When attendee == client (adult attending themselves), just the one name. When they differ, `attendee_name (client_name)` — e.g. `\"Jozko Jozko (Martin Rapavy)\"`. Use this when listing the roster; the LLM doesn't need to compose it from scratch.\n\nResponse shape notes:\n- `allowed_statuses[]` already factors in the caller's role, `company.trainer_attendance_management`, and the row's cross-company state. Do not propose a status not in this array — refuse locally and explain instead of calling `mark_attendance` to discover the constraint.\n- `is_last_trial_session` is currently `null` in V1 (derivation requires either a new api-v1 field or extra per-row lookups; deferred). Treat `is_trial=true` as the trigger for caution — a future enrichment will tighten this.\n- `entrance_voucher` is non-null only when `course.registration_type=\"open\"`. Check it before setting `mark_attendance`'s `use_voucher=true` on a `going` write.\n- `summary` block at the top level surfaces whether this event already has a public / internal session summary (`public_set` / `internal_set`), whether the public one is locked, and whether the caller's role is permitted to write summaries (`writable_by_caller`). After the user has marked attendance, the LLM can use this to offer `add_session_summary` as a follow-up when appropriate.";

export const getAttendanceRosterInputSchema = {
  company_id: companyIdSchema,
  event_id: z
    .number()
    .int()
    .positive()
    .describe("Target event id (one session of a class). Required."),
};

const inputSchema = z.object(getAttendanceRosterInputSchema);

export async function runGetAttendanceRoster(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: RosterResult;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  try {
    const callAuth = withCompany(auth, input.company_id!);
    const callerCompanyId = parseInt(callAuth.company, 10) || 0;

    // The three reads have no dependencies on each other; pay one wall-clock
    // tick instead of three. The collection path /events?filter=filter&ids=N
    // is what we need (not /events/{id} — that detail path stubs the embedded
    // course block with only __calc__available_currencies, leaving
    // track_attendance / registration_type / attendance_management all null).
    // Confirmed empirically against api-v1; ZMCP-20260527-003 originally
    // assumed the detail path was sufficient.
    const [roster, eventCollection, caller] = await Promise.all([
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
      safeCallerContext(callAuth),
    ]);
    const eventDetail = eventCollection?.data?.[0];

    // Precheck: hard error rather than ambiguous empty roster.
    const trackAttendance = eventDetail?.course?.track_attendance;
    if (!isTrackable(trackAttendance)) {
      return errorResult(
        "attendance_tracking_disabled: Attendance tracking is disabled for this event's course — no roster available.",
      );
    }

    const rows = unwrapList<RawAttendanceRow>(roster).records;

    const courseRegistrationType =
      pickStr(eventDetail?.course?.registration_type) ?? "";
    // `attendance_management` is a REGISTRATION-level field (values default /
    // limited / king_of_schedule, drives cancellation cascade), NOT a course
    // field — api-v1 confirmed it never appears on the course object (handoff
    // 2026-05-28-attendance-field-shapes). It rides on each roster row; within
    // one event every row carries the same value.
    const courseAttendanceManagement =
      pickStr(rows[0]?.attendance_management) ?? "default";
    const courseId = eventDetail?.course?.id ?? eventDetail?.course_id ?? 0;

    const attendees: RosterAttendee[] = rows.map((row) =>
      projectAttendee(
        row,
        courseRegistrationType,
        callerCompanyId,
        caller,
      ),
    );

    const result: RosterResult = {
      event_id: input.event_id,
      course: {
        id: courseId,
        registration_type: courseRegistrationType,
        attendance_management: courseAttendanceManagement,
      },
      totals: {
        enrolled: attendees.length,
        marked: attendees.filter((a) => a.attendance !== null).length,
        trial: attendees.filter((a) => a.is_trial).length,
      },
      summary: projectSummaryState(eventDetail, caller),
      attendees,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      // structuredContent sidecar: lets MCP-Apps hosts hydrate the interactive
      // roster card (ZMCP-20260529-001) and lets text clients chain on the
      // parsed object instead of re-parsing the text blob.
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      // /v1/events/{id} or /v1/attendance returning 4xx — the most common
      // case is event_not_found; surface the upstream message verbatim.
      return errorResult(
        `Could not load roster (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectAttendee(
  row: RawAttendanceRow,
  courseRegistrationType: string,
  callerCompanyId: number,
  caller: CallerContext | null,
): RosterAttendee {
  const status = pickStr(row.status) ?? "";
  const cross_company =
    typeof row.company_id === "number" &&
    callerCompanyId > 0 &&
    row.company_id !== callerCompanyId;

  const allowed_statuses = computeAllowedStatuses(
    caller?.role ?? null,
    caller?.trainer_attendance_management ?? null,
    cross_company,
  );

  const entrance_voucher = projectVoucher(row, courseRegistrationType);

  // Attendee = customer in api-v1's data model. Fall back to ef_full_name
  // when the legacy shape doesn't carry a customer block; ef_full_name is
  // a free-text extra field the operator can set per-attendee.
  const attendee: RosterAttendeeIdentity = {
    name:
      personName(row.customer) ||
      pickStr(row.ef_full_name) ||
      "",
    user_id: toInt(row.customer?.user_id),
    email: pickStr(row.customer?.person_data?.email) ?? null,
    phone: pickStr(row.customer?.person_data?.phone) ?? null,
    date_of_birth:
      pickStr(row.customer?.person_data?.date_of_birth) ?? null,
  };

  // Client = buyer in api-v1's data model. Top-level email/phone reflect
  // the buyer in practice; use buyer.person_data when present, else fall
  // back to those top-level fields (legacy shape).
  const client: RosterPerson = {
    name: personName(row.buyer) || pickStr(row.full_name) || "",
    user_id: toInt(row.buyer?.user_id ?? row.user_id),
    email:
      pickStr(row.buyer?.person_data?.email) ??
      pickStr(row.email) ??
      null,
    phone: pickStr(row.buyer?.person_data?.phone) ?? null,
  };

  return {
    registration_id: row.registration_id ?? 0,
    display_name: buildDisplayName(attendee.name, client.name),
    attendee,
    client,
    status,
    is_trial: TRIAL_STATUSES.has(status),
    is_last_trial_session: null,
    attendance: pickStr(row.attendance) ?? null,
    cancellation_reason: pickStr(row.cancellation_reason) ?? null,
    note: pickStr(row.note) ?? null,
    replacement: !!row.replacement,
    is_free_event: !!row.is_free_event,
    cross_company,
    allowed_statuses,
    entrance_voucher,
  };
}

/**
 * Project the event-level summary state into the LLM-facing hint block.
 * Shared shape with mark_attendance — see EventSummaryState in types.ts.
 * Lets the LLM decide whether to offer add_session_summary as a follow-up.
 */
export function projectSummaryState(
  event: RawEventDetail | undefined,
  caller: CallerContext | null,
): EventSummaryState {
  const publicVal = event?.summary_public;
  const internalVal = event?.summary;
  const filledAt = event?.summary_public_filled_at;
  return {
    public_set: typeof publicVal === "string" && publicVal.trim().length > 0,
    public_filled_at:
      typeof filledAt === "string" && filledAt.length > 0 ? filledAt : null,
    public_locked: !!event?.summary_public_locked,
    internal_set: typeof internalVal === "string" && internalVal.trim().length > 0,
    writable_by_caller:
      caller?.role !== undefined &&
      caller?.role !== null &&
      SUMMARY_WRITER_ROLES.has(caller.role),
  };
}

function personName(p?: RawAttendancePerson): string {
  if (!p) return "";
  const first = pickStr(p.first_name) ?? "";
  const last = pickStr(p.last_name) ?? "";
  return [first, last].filter((s) => s.length > 0).join(" ").trim();
}

/**
 * Build the one-line display label. When attendee == client (adult
 * self-attending), the single name; when they differ, `attendee (client)`
 * so the LLM can list a roster without re-rendering names downstream.
 */
function buildDisplayName(attendeeName: string, clientName: string): string {
  if (!attendeeName) return clientName;
  if (!clientName || attendeeName === clientName) return attendeeName;
  return `${attendeeName} (${clientName})`;
}

/**
 * Mirrors api-v1's `class/Attendance.php:1356-1363` decision tree (confirmed in
 * agreed handoff 2026-05-28-attendance-field-shapes):
 *   - cross-company rows → only attended/noshow/ignore (blocks canceled/going).
 *   - same-company, trainer_attendance_management=limited + the caller is in
 *     `is_member()`-or-receptionist → blocks exactly `canceled`/`going`.
 *     api confirmed the gated set is {main_member, member, external_member, receptionist}.
 *   - otherwise → all five.
 *
 * NOTE: `trainerAttendanceManagement` is null until api-v1 ships the additive
 * `company.trainer_attendance_management` field on /v1/user — until then this
 * gate is dormant and returns the full set (per the agreed degraded-not-broken
 * contract). When the caller's role is unknown (whoami fetch failed) we likewise
 * return the full set, matching mark_attendance's behaviour of surfacing the
 * upstream `low_permissions` error per-row rather than blocking blindly.
 */
const LIMITED_GATED_ROLES = new Set([
  "main_member",
  "member",
  "external_member",
  "receptionist",
]);

export function computeAllowedStatuses(
  role: string | null,
  trainerAttendanceManagement: string | null,
  crossCompany: boolean,
): string[] {
  if (crossCompany) return [...RESTRICTED_ALLOWED];
  if (
    trainerAttendanceManagement === "limited" &&
    role !== null &&
    LIMITED_GATED_ROLES.has(role)
  ) {
    return [...RESTRICTED_ALLOWED];
  }
  return [...ALL_ALLOWED];
}

function projectVoucher(
  row: RawAttendanceRow,
  courseRegistrationType: string,
): RosterVoucher | null {
  if (courseRegistrationType !== "open") return null;
  const v = row.entrance_voucher;
  // Open-type without a voucher block — surface zeros so the LLM knows
  // vouchers don't apply (vs. the field being absent which is ambiguous).
  if (!v || typeof v !== "object") {
    return { unused_entrance_vouchers: 0, credit_id: null };
  }
  return {
    unused_entrance_vouchers: toInt(v.unused_entrance_vouchers),
    credit_id: toIntOrNull(v.credit_id),
  };
}

function isTrackable(v: unknown): boolean {
  if (v === undefined || v === null) {
    // Field missing — fail closed; we'd rather error than risk surfacing
    // a roster for a course that doesn't actually track attendance.
    return false;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return false;
}

async function safeCallerContext(auth: ZoozaAuth): Promise<CallerContext | null> {
  try {
    return await getCallerContext(auth);
  } catch {
    return null;
  }
}

function toInt(v: number | string | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function toIntOrNull(v: number | string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
