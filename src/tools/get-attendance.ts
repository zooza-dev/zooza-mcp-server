import { z } from "zod";
import { config } from "../config.js";
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
  AttendanceRow,
  AttendeeIdentity,
  AttendancePerson,
  AttendanceResult,
  AttendanceVoucher,
} from "./types.js";

const SUMMARY_WRITER_ROLES = new Set(["owner", "assistant"]);

const ALL_ALLOWED = ["attended", "noshow", "canceled", "going", "ignore"] as const;
const RESTRICTED_ALLOWED = ["attended", "noshow", "ignore"] as const;

export const getAttendanceTitle = "View attendance for one class session";

export const getAttendanceDescription =
  "Read who's enrolled in **one event** (a single session of a class) and their current attendance, so you can show the list and then mark it. Pass an `event_id`; the tool returns each enrolled attendee, their current attendance value (if already marked), and per-row context the LLM needs to mark attendance correctly: `allowed_statuses[]` (the statuses the **current caller** is permitted to set for THIS attendee), `is_trial` / `is_last_trial_session` flags, warnings about cross-company or cascade-sensitive (full2) cases, and — for open-type registrations only — `entrance_voucher` info (how many unused vouchers the attendee has, and whether one is already spent on this event). Use this **before** `sessions_mark_attendance` whenever the user has not already dictated the full list of attendees and marks — typically: \"open attendance for X,\" \"who's enrolled in tomorrow's class,\" \"show me Monday's attendance.\" If the event's course has attendance tracking disabled, the tool returns an `attendance_tracking_disabled` error rather than an empty list. This tool is read-only — it never writes attendance, notes, or summaries.\n\n**Talking to the user — vocabulary.** Zooza's customers are activity brands — dance, swim, language, sport, STEAM schools. Call this **\"attendance,\" \"the attendance list,\" \"the class list,\" or \"who's coming.\"** Don't expose the tool name or use sports/HR jargon (\"roster\") — it reads as foreign to these businesses. When the user asks to \"see attendance\" / \"open the register\" / \"who's in Monday's class,\" just call this tool and render the list directly.\n\n**Attendee vs client (critical for children's-class programmes).** Each row carries TWO people:\n- `attendee` — who actually shows up to the session. Often a child (Zooza data-model name: `customer`). May have `user_id: 0` when they aren't a registered account holder, which is normal for children. `attendee.date_of_birth` is available.\n- `client` — the account holder / payer (Zooza data-model name: `buyer`). Usually the parent. Has a real `user_id`. Contact info (`email`, `phone`) lives on the client when the attendee is a child; copy from client when speaking to / messaging the family.\n- `display_name` — a pre-formatted one-line label. When attendee == client (adult attending themselves), just the one name. When they differ, `attendee_name (client_name)` — e.g. `\"Jozko Jozko (Martin Rapavy)\"`. Use this when listing attendees; the LLM doesn't need to compose it from scratch.\n\nResponse shape notes:\n- `allowed_statuses[]` already factors in the caller's role, `company.trainer_attendance_management`, and the row's cross-company state. Do not propose a status not in this array — refuse locally and explain instead of calling `sessions_mark_attendance` to discover the constraint.\n- `is_last_trial_session` is currently `null` in V1 (derivation requires either a new api-v1 field or extra per-row lookups; deferred). Treat `is_trial=true` as the trigger for caution — a future enrichment will tighten this.\n- `entrance_voucher` is non-null only when `course.registration_type=\"open\"`. Check it before setting `sessions_mark_attendance`'s `use_voucher=true` on a `going` write.\n- `summary` block at the top level surfaces whether this event already has a public / internal session summary (`public_set` / `internal_set`), whether the public one is locked, and whether the caller's role is permitted to write summaries (`writable_by_caller`). After the user has marked attendance, the LLM can use this to offer `sessions_add_summary` as a follow-up when appropriate.";

export const getAttendanceInputSchema = {
  company_id: companyIdSchema,
  event_id: z
    .number()
    .int()
    .positive()
    .describe("Target event id (one session of a class). Required."),
};

const inputSchema = z.object(getAttendanceInputSchema);

export async function runGetAttendance(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: AttendanceResult;
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
    const [attendanceRows, eventCollection, caller] = await Promise.all([
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

    // Precheck: hard error rather than ambiguous empty attendance list.
    const trackAttendance = eventDetail?.course?.track_attendance;
    if (!isTrackable(trackAttendance)) {
      return errorResult(
        "attendance_tracking_disabled: Attendance tracking is disabled for this event's course — no attendance list available.",
      );
    }

    const rows = unwrapList<RawAttendanceRow>(attendanceRows).records;

    const courseRegistrationType =
      pickStr(eventDetail?.course?.registration_type) ?? "";
    // `attendance_management` is a REGISTRATION-level field (values default /
    // limited / king_of_schedule, drives cancellation cascade), NOT a course
    // field — api-v1 confirmed it never appears on the course object (handoff
    // 2026-05-28-attendance-field-shapes). It rides on each attendance row; within
    // one event every row carries the same value.
    const courseAttendanceManagement =
      pickStr(rows[0]?.attendance_management) ?? "default";
    const courseId = eventDetail?.course?.id ?? eventDetail?.course_id ?? 0;

    const attendees: AttendanceRow[] = rows.map((row) =>
      projectAttendee(
        row,
        courseRegistrationType,
        callerCompanyId,
        caller,
      ),
    );

    const result: AttendanceResult = {
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
      // Branded markdown table for display (Option 2). The full machine-readable
      // result rides in structuredContent below — that's the model's source for
      // sessions_mark_attendance (registration_id, allowed_statuses, voucher).
      content: [{ type: "text", text: renderAttendanceMarkdown(result) }],
      // structuredContent sidecar: lets MCP-Apps hosts hydrate the interactive
      // attendance card and lets text clients chain on the
      // parsed object instead of re-parsing the text blob.
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      // /v1/events/{id} or /v1/attendance returning 4xx — the most common
      // case is event_not_found; surface the upstream message verbatim.
      return errorResult(
        `Could not load attendance (api-v1 ${error.status}: ${error.humanMessage}).`,
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
): AttendanceRow {
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
  const attendee: AttendeeIdentity = {
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
  const client: AttendancePerson = {
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
 * Shared shape with sessions_mark_attendance — see EventSummaryState in types.ts.
 * Lets the LLM decide whether to offer sessions_add_summary as a follow-up.
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

// --- Branded markdown rendering (ZMCP-20260529-001, Option 2) -----------------
// The display text is a ready-made markdown table, not a JSON dump — Claude
// passes clean markdown through to the user far more often than it paraphrases
// JSON. The machine-readable detail (registration_id, allowed_statuses, voucher)
// stays in `structuredContent`, which is the model's source for sessions_mark_attendance.

const STATUS_DISPLAY: Record<string, { emoji: string; label: string }> = {
  attended: { emoji: "🟢", label: "Present" },
  going: { emoji: "🟧", label: "Going" },
  noshow: { emoji: "🔴", label: "No-show" },
  canceled: { emoji: "⚪", label: "Cancelled" },
  ignore: { emoji: "⚫", label: "Ignore" },
};

// Show the Zooza icon at the top of the branded reply. The image URL is derived
// from the server's public origin (config.auth.resourceUrl), so it's correct in
// every environment — e.g. https://mcp.zooza.app/icon.png in prod. Set to false
// to drop the inline logo. Hosts that rebuild the table from structuredContent
// (e.g. Claude) ignore it; faithful markdown hosts render it.
const SHOW_LOGO = true;
function logoUrl(): string {
  if (!SHOW_LOGO) return "";
  try {
    return new URL(config.auth.resourceUrl).origin + "/icon.png";
  } catch {
    return "";
  }
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function statusCell(status: string): string {
  const d = STATUS_DISPLAY[status];
  if (d) return `${d.emoji} ${d.label}`;
  return status ? escapeCell(status) : "⬜ Unmarked";
}

function contactCell(a: AttendanceRow): string {
  const email = a.client?.email || a.attendee?.email || "";
  const phone = a.client?.phone || a.attendee?.phone || "";
  return escapeCell([email, phone].filter(Boolean).join(" · ")) || "—";
}

function renderAttendanceMarkdown(result: AttendanceResult): string {
  const rows = result.attendees ?? [];
  const t = result.totals;
  const lines: string[] = [];
  const logo = logoUrl();
  if (logo) lines.push(`![Zooza](${logo})`, "");
  lines.push(`**Attendance — event #${result.event_id}**`, "");

  if (rows.length === 0) {
    lines.push("_No one is enrolled in this session._");
    return lines.join("\n");
  }

  lines.push("| Attendee | Status | Contact |", "| --- | --- | --- |");
  for (const a of rows) {
    const badges = [
      a.is_trial ? "🔸 trial" : "",
      a.entrance_voucher && a.entrance_voucher.unused_entrance_vouchers > 0 ? "🎟️ voucher" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const name =
      escapeCell(a.display_name || a.attendee?.name || `#${a.registration_id}`) +
      (badges ? ` ${badges}` : "");
    lines.push(`| ${name} | ${statusCell(a.status)} | ${contactCell(a)} |`);
  }

  lines.push(
    "",
    `**${t.enrolled} enrolled · ${t.marked} marked${t.trial ? ` · ${t.trial} trial` : ""}**`,
  );

  const allowed = Array.from(new Set(rows.flatMap((a) => a.allowed_statuses ?? [])));
  if (allowed.length > 0) {
    lines.push(
      "",
      `Set status: ${allowed.map((s) => STATUS_DISPLAY[s]?.label ?? s).join(" · ")}`,
    );
  }
  return lines.join("\n");
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
 * so the LLM can list attendees without re-rendering names downstream.
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
 * return the full set, matching sessions_mark_attendance's behaviour of surfacing the
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
): AttendanceVoucher | null {
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
    // attendance for a course that doesn't actually track attendance.
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
