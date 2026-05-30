import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { getCallerContext, isAutoScopedRole } from "./caller-context.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import type {
  ApiListResponse,
  AttendanceCounts,
  EventMatch,
  FindEventsResult,
  FindEventsScopeHint,
  RawEventRecord,
} from "./types.js";

const STATUS_VALUES = ["scheduled", "unplanned", "finished", "any"] as const;
const TYPE_VALUES = [
  "over_capacity",
  "under_capacity",
  "custom_replacement",
  "rescheduled",
  "substituted",
  "cancelled",
] as const;
const SORT_VALUES = [
  "date_asc",
  "date_desc",
  "event_no_asc",
  "event_no_desc",
  "created_asc",
  "created_desc",
] as const;

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const numberOrNumberArray = z.union([
  z.number().int().positive(),
  z.array(z.number().int().positive()).min(1),
]);

export const findEventsTitle = "Find events (scheduled sessions)";

export const findEventsDescription =
  "List **events** (scheduled sessions of classes) in the caller's company. Use this whenever you need to resolve an `event_id` from natural language (\"my next class,\" \"Monday's ballet,\" \"all swim sessions this week,\" \"Sarah's classes tomorrow\") before chaining into another tool like `get_attendance_roster` or `mark_attendance`. With no filters, returns **ALL upcoming scheduled sessions in the company** (closest first) — not just the caller's. Filters cover date window, course, schedule, trainer, place, room, segment, billing period, status, and event-type (over-capacity, substituted, cancelled, etc.). Each returned row includes denormalised names (trainer, place, event-number), the event's date and duration, capacity, and an `attendance_counts` object (`going`, `attended`, `noshow`, `canceled`, `canceled_late`, `waitlist`). Read-only — does not modify events.\n\n**Critical: \"my sessions\" / \"what am I teaching\" / \"my classes today\".** When the user is asking for THEIR OWN sessions (any first-person framing), you MUST pass `trainer_id` matching `whoami.identity.user_id`. Without it, this tool returns every trainer's events in the company — which is almost never what the user meant when they said \"my.\" The only exception: when the caller's role is `member` or `external_member`, the server silently auto-scopes to their assignments anyway; `meta.scoped_to` in the response flags when this has happened.\n\nFilter notes:\n- `trainer_id` matches across FIVE trainer relationships including pre-substitution and schedule-level extras. Treat it as \"events trainer X is connected to,\" not strictly \"events trainer X currently teaches.\"\n- `status` uses raw db terms: `scheduled` (default — only state attendance can be tracked on), `unplanned` (includes cancelled events), `finished`, or `any`.\n- `segment_id=[0]` is a sentinel matching events with NO segment assignment.\n- Counters in `attendance_counts` may be sub-second-stale; for real-time counts on one event, chain into `get_attendance_roster`.";

export const findEventsInputSchema = {
  company_id: companyIdSchema,
  ids: z.array(z.number().int().positive()).min(1).optional(),
  from: z.string().optional().describe("YYYY-MM-DD, inclusive lower bound on event date."),
  to: z.string().optional().describe("YYYY-MM-DD, inclusive upper bound on event date."),
  date: z.string().optional().describe("YYYY-MM-DD, exact-day match."),
  past: z
    .boolean()
    .optional()
    .describe(
      "When true, include events whose date is in the past. Default false. If neither past, from, to, nor date is provided, the tool injects upcoming_events=true (the dashboard default).",
    ),
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'Event lifecycle status. Default "scheduled" (matches dashboard; attendance can only be tracked on scheduled events). "unplanned" covers cancelled events. "any" expands to (scheduled, unplanned).',
    ),
  type: z
    .enum(TYPE_VALUES)
    .optional()
    .describe(
      'Event-shape filter. "cancelled" surfaces events explicitly cancelled (server-side maps to status=unplanned). Other values target dashboard cases: oversold, undersold, ad-hoc replacements, etc.',
    ),
  schedule_id: z.number().int().positive().optional(),
  course_id: numberOrNumberArray.optional(),
  trainer_id: numberOrNumberArray.optional(),
  place_id: numberOrNumberArray.optional(),
  room_id: numberOrNumberArray.optional(),
  segment_id: z
    .array(z.number().int().nonnegative())
    .min(1)
    .optional()
    .describe(
      "Schedule-segment id(s). Pass [0] to match events with NO segment assignment (sentinel).",
    ),
  billing_period_id: numberOrNumberArray.optional(),
  sort: z.enum(SORT_VALUES).optional(),
  page: z.number().int().min(0).optional(),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
};

const inputSchema = z.object(findEventsInputSchema);

export async function runFindEvents(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: FindEventsResult;
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

  // Local date-shape validation (api-v1 silently drops malformed dates).
  for (const field of ["from", "to", "date"] as const) {
    const v = input[field];
    if (v !== undefined && !ISO_DATE.test(v)) {
      return errorResult(
        `Invalid ${field}: '${v}' — expected YYYY-MM-DD.`,
      );
    }
  }

  const warnings: string[] = [];
  // The schema already caps at MAX_PAGE_SIZE, but a wrapper or future schema
  // change might let a larger value through. Clamp defensively and warn.
  const requestedPageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  let pageSize = requestedPageSize;
  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
    warnings.push(`page_size clamped to ${MAX_PAGE_SIZE} (received ${requestedPageSize}).`);
  }
  const page = input.page ?? 0;

  // When the caller is targeting specific event ids, don't second-guess
  // them with date/status defaults — they want the requested rows as-is.
  // The dashboard defaults only apply for open-ended searches.
  const targetingIds = input.ids !== undefined && input.ids.length > 0;

  const query: Record<string, string | number | undefined> = {
    filter: "filter",
    page,
    page_size: pageSize,
    sort_by: input.sort ?? "date_asc",
  };

  if (input.status !== undefined) {
    query.status = input.status;
  } else if (!targetingIds) {
    query.status = "scheduled";
  }

  // Default to upcoming when caller didn't ask for any time window AND
  // isn't pinning ids. Open-ended searches get the dashboard's "next
  // sessions" framing; id-targeted reads stay neutral.
  const hasDateFilter =
    input.from !== undefined ||
    input.to !== undefined ||
    input.date !== undefined ||
    input.past === true;
  if (!hasDateFilter && !targetingIds) {
    query.upcoming_events = "true";
  }
  if (input.from !== undefined) query.from = input.from;
  if (input.to !== undefined) query.to = input.to;
  if (input.date !== undefined) query.date = input.date;
  if (input.past === true) query.past = "true";
  if (input.type !== undefined) query.type = input.type;
  if (input.schedule_id !== undefined) query.schedule_id = input.schedule_id;
  if (input.ids !== undefined) query.ids = pipeJoin(input.ids);
  if (input.course_id !== undefined) query.course_id = pipeJoin(input.course_id);
  if (input.trainer_id !== undefined) query.trainer_id = pipeJoin(input.trainer_id);
  if (input.place_id !== undefined) query.place_id = pipeJoin(input.place_id);
  if (input.room_id !== undefined) query.room_id = pipeJoin(input.room_id);
  if (input.segment_id !== undefined) query.segment_id = pipeJoin(input.segment_id);
  if (input.billing_period_id !== undefined)
    query.billing_period_id = pipeJoin(input.billing_period_id);

  try {
    const callAuth = withCompany(auth, input.company_id!);
    const [raw, caller] = await Promise.all([
      zoozaFetch<ApiListResponse<RawEventRecord> | RawEventRecord[]>(
        "/events",
        { query },
        callAuth,
      ),
      // Detection of server-side trainer auto-scoping needs the caller's
      // role. /v1/user is the cheapest way to read it; ride along in
      // parallel with the events fetch so the wall-clock impact is
      // bounded by the slower of the two requests.
      safeCallerContext(callAuth),
    ]);
    const { records, total } = unwrapList<RawEventRecord>(raw);

    const events: EventMatch[] = records.map(projectEvent);

    const scoped_to: FindEventsScopeHint | null =
      caller && isAutoScopedRole(caller.role) && caller.user_id !== null
        ? { reason: "caller_is_trainer", trainer_id: caller.user_id }
        : null;

    const result: FindEventsResult = {
      meta: {
        page,
        page_size: pageSize,
        total,
        scoped_to,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      events,
    };

    // Dual-content response: compact markdown for the LLM to pass through
    // verbatim (saves output tokens vs reformatting JSON every turn) and
    // structuredContent with the full JSON for chaining into
    // get_attendance_roster / mark_attendance. MCP clients that support
    // structuredContent may also render it as a richer widget.
    return {
      content: [{ type: "text", text: formatEventsMarkdown(result, input) }],
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not list events (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Compact markdown summary the LLM passes through to the user. Designed
 * to be scannable in Claude.ai's renderer (one bullet per session, grouped
 * by date) and to avoid re-stating data the LLM can pull from
 * structuredContent on follow-up questions.
 *
 * Format:
 *
 *   **{title}** — showing **{n} of {total}** *(scoped hint)*
 *
 *   ### {weekday}, {month} {day}
 *   - **HH:MM** — Course @ Place — Trainer (going/capacity)
 *
 * Edge handling: empty result → "no matches" line. Capacity = 0 (open
 * events) → just the going count. Trainer / place absent → skipped.
 * Unplanned events get a "[cancelled]" suffix; finished events get "[done]".
 */
function formatEventsMarkdown(
  result: FindEventsResult,
  input: z.infer<typeof inputSchema>,
): string {
  if (result.events.length === 0) {
    return "No matching events found.";
  }

  const title = inferTitle(input);
  const scope = result.meta.scoped_to
    ? " *(scoped to your assignments)*"
    : "";
  const headerLine = `**${title}** — showing **${result.events.length} of ${result.meta.total}**${scope}`;

  // Group by YYYY-MM-DD prefix of the event's date string. api-v1 emits
  // local time; we slice rather than parsing to avoid timezone churn.
  const groups = new Map<string, EventMatch[]>();
  const order: string[] = [];
  for (const ev of result.events) {
    const dateKey = (ev.date ?? "").slice(0, 10);
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
      order.push(dateKey);
    }
    groups.get(dateKey)!.push(ev);
  }

  const sections: string[] = [];
  for (const dateKey of order) {
    sections.push(`### ${formatDateHeader(dateKey)}`);
    for (const ev of groups.get(dateKey)!) {
      sections.push(`- ${formatEventLine(ev)}`);
    }
  }

  const out = [headerLine, "", ...sections];
  if (result.meta.warnings && result.meta.warnings.length > 0) {
    out.push("");
    out.push(`_Warnings: ${result.meta.warnings.join("; ")}_`);
  }
  return out.join("\n");
}

function inferTitle(input: z.infer<typeof inputSchema>): string {
  if (input.type === "cancelled") return "Cancelled sessions";
  if (input.status === "finished" || input.past === true) return "Sessions";
  if (input.status === "unplanned") return "Unplanned sessions";
  if (input.status === "any") return "Sessions";
  // Default path (no date filter → upcoming_events injected; status=scheduled).
  return "Upcoming sessions";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDateHeader(yyyymmdd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return yyyymmdd || "(no date)";
  // Parse as local-date to avoid the UTC midnight shift that "YYYY-MM-DD"
  // strings get when fed straight into new Date().
  const [y, m, d] = yyyymmdd.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return yyyymmdd;
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

function formatEventLine(ev: EventMatch): string {
  const time = (ev.date ?? "").slice(11, 16) || "??:??";
  const parts: string[] = [`**${time}**`];

  if (ev.course_name) {
    parts.push(`— ${ev.course_name}`);
  }
  if (ev.place_name) {
    parts.push(`@ ${ev.place_name}`);
  }
  if (ev.trainer_name) {
    parts.push(`— ${ev.trainer_name}`);
  }

  // Attendance hint: going/capacity for closed-capacity events; bare
  // going count for open-capacity (capacity=0). Skip when neither is
  // informative.
  const going = ev.attendance_counts.going;
  if (ev.capacity > 0) {
    parts.push(`(${going}/${ev.capacity})`);
  } else if (going > 0) {
    parts.push(`(${going} going)`);
  }

  // Status badge suffix (only when non-default).
  if (ev.status === "unplanned") parts.push("**[cancelled]**");
  else if (ev.status === "finished") parts.push("[done]");

  // event_id MUST appear in the rendered text — it's the join key for chaining
  // into get_attendance_roster / mark_attendance. Clients that don't surface
  // structuredContent to the model (e.g. plain browser chat) can only see this
  // markdown, so omitting the id silently breaks the documented chain.
  parts.push(`· \`event_id:${ev.event_id}\``);

  return parts.join(" ");
}

function projectEvent(r: RawEventRecord): EventMatch {
  const attendance_counts: AttendanceCounts = {
    going: toInt(r.__calc__attendance__going),
    attended: toInt(r.__calc__attendance__attended),
    noshow: toInt(r.__calc__attendance__noshow),
    canceled: toInt(r.__calc__attendance__canceled),
    canceled_late: toInt(r.__calc__attendance__canceled_late),
    waitlist: toInt(r.__calc__attendance__waitlist),
  };

  // Segments: prefer the embedded segments[] (richer), fall back to the
  // comma-joined __schedule_segments__name materialiser column.
  let segments: string[] = [];
  if (Array.isArray(r.segments) && r.segments.length > 0) {
    segments = r.segments
      .map((s) => (typeof s?.name === "string" ? s.name : ""))
      .filter((n) => n.length > 0);
  } else if (typeof r.__schedule_segments__name === "string" && r.__schedule_segments__name.length > 0) {
    segments = r.__schedule_segments__name
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const course_name = pickStr(r.course?.name) ?? "";
  const trainer_name = pickStr(r.__calc__event_trainer) ?? "";
  const place_name = pickStr(r.__calc__event_place) ?? "";
  const event_number = stringify(r.__calc__event_number);
  const capacity = toInt(r.schedule?.capacity);
  const has_public_summary =
    typeof r.summary_public === "string" && r.summary_public.trim().length > 0;
  const cancellation_reasoning_public =
    typeof r.cancellation_reasoning_public === "string" &&
    r.cancellation_reasoning_public.length > 0
      ? r.cancellation_reasoning_public
      : null;

  return {
    event_id: r.id,
    schedule_id: r.schedule_id ?? 0,
    course_id: r.course_id ?? 0,
    trainer_id: r.trainer_id ?? 0,
    place_id: r.place_id ?? 0,
    room_id: r.room_id ?? 0,
    date: pickStr(r.date) ?? "",
    duration: toInt(r.duration),
    status: pickStr(r.status) ?? "",
    course_name,
    trainer_name,
    place_name,
    event_number,
    capacity,
    attendance_counts,
    segments,
    is_substituted: !!r.substituted,
    is_replacement: !!r.is_custom_replacement_event,
    has_public_summary,
    cancellation_reasoning_public,
  };
}

/**
 * Best-effort caller context fetch. Returns null on failure so we degrade
 * gracefully: scoped_to becomes null and the LLM gets standard results
 * instead of the call hard-failing because /v1/user is briefly unhappy.
 */
async function safeCallerContext(auth: ZoozaAuth) {
  try {
    return await getCallerContext(auth);
  } catch {
    return null;
  }
}

function pipeJoin(v: number | number[]): string {
  return Array.isArray(v) ? v.join("|") : String(v);
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function toInt(v: number | string | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
