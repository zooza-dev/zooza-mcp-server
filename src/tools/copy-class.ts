import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import {
  planSessions,
  type Holiday,
  type HolidayDecision,
  type PlanFlag,
  type PlannedEvent,
  type PlanResult,
  type SourceSession,
} from "./copy-class-planner.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import {
  getClassCopyPlan,
  markClassCopyPlanUsed,
  saveClassCopyPlan,
  type ClassCopyPlan,
} from "./copy-class-plan-store.js";
import { CHUNK_MAX } from "./show-copy-progress.js";
import { isTemporaryStepError, noteTemporaryFailure } from "./copy-retry-ledger.js";
import type { ApiListResponse, RawBillingPeriodRecord, RawEventRecord, RawScheduleRecord } from "./types.js";

// Spec ZMCP-20261122-001. Reads the target period, the source classes, their sessions
// and the holidays of every venue the copies will run at, and plans the sessions
// (copy-class-planner.ts). Any undecided holiday returns `needs_decision`. Otherwise the
// batch body goes through api-v1's own dry run (`POST schedules/copy?action=preflight_check`,
// class/Class_Copy_Preflight.php), the preview is shaped from that response, and the
// body is frozen under a token. The apply POSTs the frozen body unchanged and returns
// the `schedule_copy` job (class/Class_Copy.php).
//
// Holidays come ONLY from GET holidays. The local generator (events-preview.ts) is
// holiday-blind, so it is never a fallback: no holidays, no plan.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PAGE_SIZE = 200;
/** 20 × 200 = 4 000 rows per class or venue; a guard against a loop, not a real limit. */
const MAX_PAGES = 20;
/** Session reads in flight at once (spec Composition step 2). */
const EVENTS_PARALLEL = 5;
/** The holiday window runs this far past the target period, so a run past its end is checked too. */
const HOLIDAY_TAIL_DAYS = 56;
/** No period end: look a year ahead of the start (plus the tail). */
const OPEN_PERIOD_DAYS = 365;
const DAY_MS = 86_400_000;

export const CHUNK_ERROR =
  "At most 25 classes per call. Split them by venue, instructor or programme; classes_show_copy_progress shows what is left.";
export const ASK_OPERATOR_ERROR =
  "Ask the operator how many sessions each class should have (or same_as_source) and whether to copy the enrolled clients, then call again.";

export const copyClassTitle = "Copy classes into a billing period";

// The spec's description also points to get_skill("period-rollover"); that skill does
// not exist yet (ZMCP-20261122-003), so the reference is added with it.
export const copyClassDescription =
  "Copies 1–25 existing CLASSES into a BILLING PERIOD (customers say term, semester, season), each with new " +
  "sessions and, if asked, its enrolled clients. Use it to start a new term or roll classes over " +
  '(get_skill("period-rollover") first), or to copy a single class into another period. ' +
  "Not for moving a client between classes (bookings_copy_booking) or for " +
  "creating a class from scratch (classes_preview_schedule). Call it without a token to preview. The preview " +
  "lists every holiday that hits a planned session; decide each one (skip, run or exchange) and preview again. " +
  "Then apply with the token and confirmed:true. A class with a problem of its own comes back in set_aside with " +
  "its reason while the rest still previews; tell the operator about each one. More than 25 classes: split them by " +
  "venue, instructor or programme (classes_show_copy_progress).";

const dateSchema = (what: string) =>
  z.string().regex(DATE_RE, `${what} must be YYYY-MM-DD`);

const classSchema = z.object({
  schedule_id: z.number().int().positive().describe("Source class (resolve via classes_find_classes)."),
  course_id: z.number().int().positive().optional().describe("New programme, for a progression (Tots 1 → Tots 2)."),
  name: z.string().min(1).optional().describe("New class name. Default: the source name, no suffix."),
  trainer_id: z.number().int().positive().optional().describe("New instructor."),
  place_id: z.number().int().positive().optional().describe("New venue; its holidays are the ones checked."),
  room_id: z.number().int().positive().optional().describe("New room."),
  capacity: z.number().int().min(0).optional().describe("New capacity."),
  price: z.number().min(0).optional().describe("Mapped to price or unit_price by the target programme's pricing model."),
  online_registration: z.boolean().optional().describe("Online booking on or off."),
  first_session_on: dateSchema("first_session_on")
    .optional()
    .describe("YYYY-MM-DD: this class's exact first session; moves it to that weekday."),
  time: z.string().regex(TIME_RE, "time must be HH:MM").optional().describe("HH:MM, applied to all sessions."),
  allow_repeat_copy: z
    .boolean()
    .optional()
    .describe('Explicit "yes, copy again" when this class already has a copy in the target period.'),
});

export const copyClassInputSchema = {
  company_id: companyIdSchema,
  // target_billing_period_id / classes / bookings / session_count are optional and
  // classes has no max HERE, at the registration layer only: the SDK and call_tool
  // validate against this shape before the handler runs. The apply call sends only
  // { token, confirmed } (live, 2026-11-22: call_tool refused every apply because these
  // were required here), and the spec's ASK_OPERATOR_ERROR / CHUNK_ERROR must win over a
  // generic zod error. runCopyClass enforces all of them on preview via the strict shape.
  target_billing_period_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required to preview. Resolve via classes_find_resource kind:billing_period, or create via classes_add_billing_period."),
  bookings: z
    .enum(["enrolled", "none"])
    .optional()
    .describe("Required, no default: carry the enrolled clients (registered + pre_registered), or none."),
  session_count: z
    .union([z.number().int().min(1), z.literal("same_as_source")])
    .optional()
    .describe("Required, no default: sessions per class, or same_as_source. Ask the operator."),
  first_session_on: dateSchema("first_session_on")
    .optional()
    .describe("YYYY-MM-DD: no session before this; each class keeps its weekday. Default: the period's start."),
  holiday_decisions: z
    .array(
      z.object({
        holiday_id: z.number().int().positive().describe("From a needs_decision result."),
        action: z
          .enum(["skip", "run", "exchange"])
          .describe("skip = drop the date and add one at the end; run = hold as normal; exchange = move to exchange_date."),
        exchange_date: dateSchema("exchange_date").optional().describe("Only with exchange; only for single-day holidays."),
      }),
    )
    .optional()
    .describe("One decision per holiday that hits a planned session; pass the same list to every chunk."),
  classes: z.array(classSchema).min(1).optional().describe("Required to preview: 1..25 source classes, each with optional overrides."),
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
};

/** What the handler actually accepts, once the directive checks above have passed. */
export const copyClassStrictShape = {
  ...copyClassInputSchema,
  target_billing_period_id: copyClassInputSchema.target_billing_period_id.unwrap(),
  bookings: copyClassInputSchema.bookings.unwrap(),
  session_count: copyClassInputSchema.session_count.unwrap(),
  classes: copyClassInputSchema.classes.unwrap().max(CHUNK_MAX),
};

const inputSchema = z.object(copyClassStrictShape);
export type CopyClassInput = z.infer<typeof inputSchema>;
export type CopyClassClassInput = z.infer<typeof classSchema>;

// ── api-v1 batch body (class/Class_Copy_Request.php, branch feature-class-copy-copy-jobs) ──

/** One `events[]` item: keys mirror `POST events` (Class_Copy_Request::parse_events). */
export interface CopyEventBody {
  date_string: string;
  /** Minutes since midnight, 0..1439. */
  time_string: number;
  duration: number;
  blocks: string[];
  /** Optional in api-v1, default false (as POST events stores it). Always sent. */
  billable: boolean;
  /** Optional in api-v1, default "scheduled" (b4796c9c). Always sent: a cancelled source session stays cancelled. */
  status: "scheduled" | "unplanned";
}

/** `overrides` keys accepted by Class_Copy_Request::parse_overrides. Anything left out is cloned. */
export interface CopyOverridesBody {
  billing_period_id: number;
  course_id?: number;
  name?: string;
  trainer_id?: number;
  place_id?: number;
  room_id?: number;
  capacity?: number;
  online_registration?: boolean;
  /** Minutes since midnight. */
  time?: number;
  /** Set only by `mapPriceOverrides`, to the field the preflight's `price_hints.price_field` names. */
  price?: number;
  unit_price?: number;
}

export interface CopyClassBody {
  overrides: CopyOverridesBody;
  events: CopyEventBody[];
  registrations?: "all";
  allow_repeat_copy?: true;
}

/** `POST schedules/copy`: `classes` keyed by source class id. */
export interface CopyBatchBody {
  classes: Record<string, CopyClassBody>;
}

/** "HH:MM" → minutes since midnight, the unit api-v1's `time_string` and `time` take. */
export function hhmmToMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new Error(`time "${hhmm}" is not HH:MM.`);
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * The batch body, from the operator's input and the planned sessions. Pure.
 *
 * Overrides carry only what the operator gave, plus the target billing period: every key
 * left out is cloned from the source class by api-v1. `first_session_on` is not an
 * override: the class row has no weekdays, its dates come from `events[]`.
 * `price` is not mapped here — it goes to `price` or `unit_price` by the preflight's
 * `price_hints` (phase 2).
 */
export function buildCopyBatchBody(args: {
  target_billing_period_id: number;
  bookings: "enrolled" | "none";
  classes: Array<{ input: CopyClassClassInput; events: PlannedEvent[] }>;
}): CopyBatchBody {
  const classes: Record<string, CopyClassBody> = {};
  for (const { input, events } of args.classes) {
    const overrides: CopyOverridesBody = { billing_period_id: args.target_billing_period_id };
    if (input.course_id !== undefined) overrides.course_id = input.course_id;
    if (input.name !== undefined) overrides.name = input.name;
    if (input.trainer_id !== undefined) overrides.trainer_id = input.trainer_id;
    if (input.place_id !== undefined) overrides.place_id = input.place_id;
    if (input.room_id !== undefined) overrides.room_id = input.room_id;
    if (input.capacity !== undefined) overrides.capacity = input.capacity;
    if (input.online_registration !== undefined) overrides.online_registration = input.online_registration;
    if (input.time !== undefined) overrides.time = hhmmToMinutes(input.time);
    const body: CopyClassBody = {
      overrides,
      events: events.map((e) => ({
        date_string: e.date,
        time_string: hhmmToMinutes(e.time),
        duration: e.duration,
        blocks: [...e.blocks],
        billable: e.billable,
        status: e.status,
      })),
    };
    if (args.bookings === "enrolled") body.registrations = "all";
    if (input.allow_repeat_copy === true) body.allow_repeat_copy = true;
    classes[String(input.schedule_id)] = body;
  }
  return { classes };
}

// ── Results ──

export type HolidayType = "public" | "school" | "custom";

export interface NeedsDecisionHoliday {
  holiday_id: number;
  name: string;
  start: string;
  end: string;
  type: HolidayType;
  single_day: boolean;
  hits: Array<{ schedule_id: number; dates: string[] }>;
}

/** A class left out of this call for a reason of its own; the rest of the chunk goes on. */
export interface SetAsideClass {
  schedule_id: number;
  name: string;
  reason: string;
}

export interface NeedsDecisionResult {
  status: "needs_decision";
  holidays: NeedsDecisionHoliday[];
  /** Echo of the decisions already given, to pass forward to the next call and chunk. */
  decided: HolidayDecision[];
  notices?: string[];
  set_aside?: SetAsideClass[];
}

/** One class's plan, carried to the preview (phase 2). */
export interface ClassPlanSummary {
  source_schedule_id: number;
  name: string;
  programme_id: number | null;
  place_id: number | null;
  pattern: PlanResult["pattern"];
  sessions: { count: number; first: string | null; last: string | null };
  block_counts: PlanResult["block_counts"];
  flags: PlanFlag[];
  cancelled_in_source: number;
}

export interface PeriodInfo {
  id: number;
  name: string;
  start: string | null;
  end: string | null;
}

export interface CopyPlanReady {
  kind: "ready";
  target: { id: number; name: string; start: string; end: string | null };
  /** Every billing period of the company, to name the source periods in the scope sentence. */
  periods: PeriodInfo[];
  classes: ClassPlanSummary[];
  holiday_decisions: HolidayDecision[];
  body: CopyBatchBody;
  /** Classes left out of `body`, each with its reason. */
  set_aside: SetAsideClass[];
}

export type CopyPlanOutcome =
  | { kind: "error"; text: string }
  | { kind: "needs_decision"; result: NeedsDecisionResult }
  | CopyPlanReady;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function jsonResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

// ── Reads ──

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function apiText(error: unknown): string {
  return error instanceof ZoozaApiError ? `api-v1 ${error.status}: ${error.humanMessage}` : String(error);
}

/** Every page of a list endpoint, with its `settings`. Throws on a failed page. */
async function allPages<T>(
  path: string,
  query: Record<string, string | number>,
  auth: ZoozaAuth,
): Promise<{ records: T[]; settings: Record<string, unknown> }> {
  const records: T[] = [];
  let settings: Record<string, unknown> = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await zoozaFetch<ApiListResponse<T> | T[]>(
      path,
      { query: { ...query, filter: "filter", page, page_size: PAGE_SIZE } },
      auth,
    );
    const list = unwrapList<T>(raw);
    if (page === 0) settings = list.settings;
    records.push(...list.records);
    // Stop on `total`, not on a short page (an endpoint may cap page_size below ours).
    if (list.records.length === 0 || records.length >= list.total) return { records, settings };
  }
  throw new Error(`${path}: more than ${MAX_PAGES * PAGE_SIZE} rows; refusing to plan from a partial list.`);
}

/** `fn` over `items`, at most `limit` at a time; rejects on the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

class ReadError extends Error {}

async function fetchSchedule(id: number, auth: ZoozaAuth): Promise<RawScheduleRecord> {
  let raw: { data?: RawScheduleRecord } | RawScheduleRecord | unknown[] | undefined;
  try {
    raw = await zoozaFetch<{ data?: RawScheduleRecord } | RawScheduleRecord>(`/schedules/${id}`, {}, auth);
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status === 404) throw new ReadError(`Class ${id} not found in this company.`);
    throw new ReadError(`Could not read class ${id} (${apiText(error)}). Nothing was copied.`);
  }
  const rec = Array.isArray(raw) ? undefined : ((raw as { data?: RawScheduleRecord })?.data ?? (raw as RawScheduleRecord));
  if (!rec || rec.id === undefined || toInt(rec.id) !== id) throw new ReadError(`Class ${id} not found in this company.`);
  return rec;
}

/** Every session of a class, cancelled ones included. */
async function fetchSessions(id: number, auth: ZoozaAuth): Promise<RawEventRecord[]> {
  try {
    // status=any is api-v1's scheduled + unplanned (Collection/Events.php:323-326); the
    // collection defaults to scheduled only, which would hide the source's cancellations.
    const { records } = await allPages<RawEventRecord>(
      "/events",
      { schedule_id: id, status: "any", sort_by: "date_asc" },
      auth,
    );
    return records;
  } catch (error) {
    throw new ReadError(`Could not read the sessions of class ${id} (${apiText(error)}). Nothing was copied.`);
  }
}

interface RawHoliday {
  id: number | string;
  name?: string;
  start?: string;
  end?: string;
  type?: number | string;
}

interface VenueHolidays {
  holidays: Array<Holiday & { type: HolidayType }>;
  /** The venue has region (subdivision) codes, so school breaks are filtered to them. */
  has_region: boolean;
}

const HOLIDAY_TYPES: Record<number, HolidayType> = { 1: "public", 2: "school", 3: "custom" }; // api-v1 class/Holiday.php:6-8

async function fetchHolidays(placeId: number, from: string, to: string, auth: ZoozaAuth): Promise<VenueHolidays> {
  let res: { records: RawHoliday[]; settings: Record<string, unknown> };
  try {
    res = await allPages<RawHoliday>("/holidays", { date_from: from, date_to: to, place_id: placeId }, auth);
  } catch (error) {
    throw new ReadError(
      `Could not read the holidays of venue ${placeId} (${apiText(error)}). Sessions are never planned without holidays; nothing was copied.`,
    );
  }
  return {
    holidays: res.records.map((h) => ({
      id: toInt(h.id),
      name: h.name ?? "",
      start: String(h.start ?? "").slice(0, 10),
      end: String(h.end ?? h.start ?? "").slice(0, 10),
      type: HOLIDAY_TYPES[toInt(h.type)] ?? "custom",
    })),
    // api-v1 sets `settings.subdivision` only when the venue's places_subdivisions list is
    // non-empty (Collection/Holidays.php:99-114 reads it, :215-223 sets the setting); an
    // empty list adds no filter, so every region's school breaks come back.
    has_region: typeof res.settings.subdivision === "string" && res.settings.subdivision.length > 0,
  };
}

/** api-v1 event → planner session. Blocks: `segments[].name`, else `__schedule_segments__name`. */
export function toSourceSession(r: RawEventRecord, fallbackDuration: number): SourceSession {
  let blocks: string[] = [];
  if (Array.isArray(r.segments) && r.segments.length > 0) {
    blocks = r.segments.map((s) => (typeof s?.name === "string" ? s.name : "")).filter((n) => n.length > 0);
  } else if (typeof r.__schedule_segments__name === "string" && r.__schedule_segments__name.length > 0) {
    // api-v1 joins the names with '|' (class/Materialization.php:421, GROUP_CONCAT … SEPARATOR '|'),
    // and a block name may itself contain a comma ("Mon, Group 1").
    blocks = r.__schedule_segments__name.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const duration = toInt(r.duration);
  return {
    date: String(r.date ?? ""),
    duration: duration > 0 ? duration : fallbackDuration,
    cancelled: r.status === "unplanned",
    replacement: r.is_custom_replacement_event === true || toInt(r.is_custom_replacement_event) === 1,
    blocks,
    billable: r.billable === true || toInt(r.billable) === 1,
  };
}

// ── Plan ──

/**
 * Reads everything the copy needs and plans each class. No write, no dry run.
 * Exported for phase 2, which sends `body` to api-v1's preflight.
 */
export async function planCopy(input: CopyClassInput, auth: ZoozaAuth): Promise<CopyPlanOutcome> {
  const ids = input.classes.map((c) => c.schedule_id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) {
    return { kind: "error", text: `Class ${dupes.join(", ")} is listed more than once. List each source class once.` };
  }
  const targetId = input.target_billing_period_id;
  const decisions: HolidayDecision[] = input.holiday_decisions ?? [];

  // 1. Target period + source classes, in parallel.
  let periods: RawBillingPeriodRecord[];
  let schedules: RawScheduleRecord[];
  try {
    [periods, schedules] = await Promise.all([
      // Never page billing_periods: filter=filter alone returns them all (research §2.5).
      zoozaFetch<ApiListResponse<RawBillingPeriodRecord> | RawBillingPeriodRecord[]>(
        "/billing_periods",
        { query: { filter: "filter" } },
        auth,
      )
        .then((raw) => unwrapList<RawBillingPeriodRecord>(raw).records)
        .catch((error) => {
          throw new ReadError(`Could not read billing period ${targetId} (${apiText(error)}). Nothing was copied.`);
        }),
      Promise.all(ids.map((id) => fetchSchedule(id, auth))),
    ]);
  } catch (error) {
    return { kind: "error", text: error instanceof ReadError ? error.message : String(error) };
  }
  const period = periods.find((p) => toInt(p.id) === targetId);
  if (!period) return { kind: "error", text: `Billing period ${targetId} not found.` };
  const periodStart = pickStr(period.period_start)?.slice(0, 10);
  const periodEnd = pickStr(period.period_end)?.slice(0, 10) ?? null;
  if (!periodStart) {
    return {
      kind: "error",
      text: `Billing period ${targetId} ("${period.name}") has no start date. Set it in Zooza, then call again.`,
    };
  }

  // 2. Sessions per class, at most 5 reads at a time.
  let sessions: RawEventRecord[][];
  try {
    sessions = await mapLimit(ids, EVENTS_PARALLEL, (id) => fetchSessions(id, auth));
  } catch (error) {
    return { kind: "error", text: error instanceof ReadError ? error.message : String(error) };
  }

  // A class with a problem of its own is set aside with its reason, and the rest of the
  // chunk goes on (live, 2026-11-22: one long class's error held back 15 others for a whole
  // round trip). Index → reason, phrased to follow "Class <id>".
  const setAside = new Map<number, string>();

  // 3. Holidays once per distinct effective venue, over the period plus 8 weeks.
  let venueOf = input.classes.map((c, i) => c.place_id ?? toInt(schedules[i].place_id));
  venueOf.forEach((v, i) => {
    if (v <= 0) setAside.set(i, " has no venue, so its holidays cannot be looked up. Give it a place_id.");
  });
  const firstDates = [input.first_session_on, ...input.classes.map((c) => c.first_session_on)].filter(
    (d): d is string => d !== undefined,
  );
  // One day before the first possible session: api-v1 matches date_from as
  // `start >= :date_from OR (start < :date_from AND end > :date_from)` with an inclusive
  // `end` (api-v1 class/Zooza/Collection/Holidays.php:85-87), so a break ending exactly on
  // the first planned date would be missed if queried from that date.
  const windowFrom = addDays([periodStart, ...firstDates].sort()[0], -1);
  const windowBase = [periodEnd ?? addDays(periodStart, OPEN_PERIOD_DAYS), ...firstDates].sort().at(-1)!;
  const windowTo = addDays(windowBase, HOLIDAY_TAIL_DAYS);
  const venues = [...new Set(venueOf.filter((v) => v > 0))];
  const holidaysByVenue = new Map<number, VenueHolidays>();
  try {
    const lists = await Promise.all(venues.map((v) => fetchHolidays(v, windowFrom, windowTo, auth)));
    venues.forEach((v, i) => holidaysByVenue.set(v, lists[i]));
  } catch (error) {
    return { kind: "error", text: error instanceof ReadError ? error.message : String(error) };
  }

  // 4. Plan each class.
  let plans: PlanResult[] = input.classes.map((c, i) =>
    planSessions({
      sessions: sessions[i].map((r) => toSourceSession(r, toInt(schedules[i].duration))),
      session_count: input.session_count,
      period_start: periodStart,
      period_end: periodEnd,
      first_session_on: c.first_session_on,
      not_before: input.first_session_on,
      time: c.time,
      holidays: holidaysByVenue.get(venueOf[i])?.holidays ?? [],
      decisions,
    }),
  );

  // An error every class shares is the operator's input (a bad decision): say it once and
  // stop. Anything else sets that class aside.
  const firstErrors = plans[0]?.errors.join(" ") ?? "";
  if (firstErrors && plans.every((p) => p.errors.join(" ") === firstErrors)) {
    return { kind: "error", text: firstErrors };
  }
  plans.forEach((p, i) => {
    if (setAside.has(i)) return;
    if (p.flags.includes("no_source_sessions")) setAside.set(i, " has no sessions to copy a pattern from.");
    else if (p.errors.length > 0) setAside.set(i, `: ${[...new Set(p.errors)].join(" ")}`);
    // A plan past the holiday window would be checked against nothing there.
    else if ((p.events.at(-1)?.date ?? "") > windowTo) {
      setAside.set(
        i,
        ` would run past ${windowTo}, beyond the holidays looked up for the target period. Copy it on its own with a ` +
          "smaller session_count, or start it earlier.",
      );
    }
  });
  const set_aside: SetAsideClass[] = [...setAside.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, reason]) => ({ schedule_id: input.classes[i].schedule_id, name: schedules[i].name ?? "", reason: `Class ${input.classes[i].schedule_id}${reason}` }));
  if (setAside.size === input.classes.length) {
    return { kind: "error", text: set_aside.map((c) => c.reason).join(" ") };
  }
  if (setAside.size > 0) {
    const keep = input.classes.map((_, i) => i).filter((i) => !setAside.has(i));
    input = { ...input, classes: keep.map((i) => input.classes[i]) };
    schedules = keep.map((i) => schedules[i]);
    venueOf = keep.map((i) => venueOf[i]);
    plans = keep.map((i) => plans[i]);
  }
  const keptIds = input.classes.map((c) => c.schedule_id);

  // 5. Any undecided holiday: needs_decision, no token, nothing sent to api-v1.
  if (plans.some((p) => p.undecided.length > 0)) {
    const byHoliday = new Map<number, NeedsDecisionHoliday>();
    const notices: string[] = [];
    plans.forEach((p, i) => {
      const venue = holidaysByVenue.get(venueOf[i])!;
      for (const hit of p.hits) {
        if (!p.undecided.includes(hit.holiday_id)) continue;
        const h = venue.holidays.find((x) => x.id === hit.holiday_id)!;
        const entry = byHoliday.get(hit.holiday_id) ?? {
          holiday_id: hit.holiday_id, name: hit.name, start: hit.start, end: hit.end,
          type: h.type, single_day: hit.single_day, hits: [],
        };
        entry.hits.push({ schedule_id: input.classes[i].schedule_id, dates: hit.dates });
        byHoliday.set(hit.holiday_id, entry);
      }
    });
    // A venue with no region codes gets every region's school breaks (spec Notes,
    // 2026-11-22: venue 16 got three different spring-break weeks). Say so whenever such
    // a venue's school break is on the list, so the operator is not asked about breaks
    // that are not theirs as if they were.
    for (const v of venues) {
      const venue = holidaysByVenue.get(v)!;
      if (venue.has_region) continue;
      const listed = [...byHoliday.values()].some(
        (h) => h.type === "school" && h.hits.some((x) => venueOf[keptIds.indexOf(x.schedule_id)] === v),
      );
      if (!listed) continue;
      const idx = venueOf.indexOf(v);
      const name = input.classes[idx].place_id === undefined ? pickStr(schedules[idx].__calc__course_place) : undefined;
      notices.push(
        `Venue ${name ? `"${name}" (${v})` : v} has no region set, so the school breaks of every region are listed. ` +
          "Ask the operator which ones apply to them; the others can be run.",
      );
    }
    const result: NeedsDecisionResult = {
      status: "needs_decision",
      holidays: [...byHoliday.values()].sort((a, b) => a.start.localeCompare(b.start) || a.holiday_id - b.holiday_id),
      decided: decisions,
      ...(notices.length > 0 ? { notices } : {}),
      ...(set_aside.length > 0 ? { set_aside } : {}),
    };
    return { kind: "needs_decision", result };
  }

  // 6. Everything decided: the batch body.
  const body = buildCopyBatchBody({
    target_billing_period_id: targetId,
    bookings: input.bookings,
    classes: input.classes.map((c, i) => ({ input: c, events: plans[i].events })),
  });
  const classes: ClassPlanSummary[] = input.classes.map((c, i) => {
    const p = plans[i];
    return {
      source_schedule_id: c.schedule_id,
      name: schedules[i].name ?? "",
      programme_id: toInt(schedules[i].course_id) || null,
      place_id: venueOf[i],
      pattern: p.pattern,
      sessions: { count: p.events.length, first: p.events[0]?.date ?? null, last: p.events.at(-1)?.date ?? null },
      block_counts: p.block_counts,
      flags: p.flags,
      cancelled_in_source: p.cancelled_in_source,
    };
  });
  return {
    kind: "ready",
    target: { id: targetId, name: period.name ?? "", start: periodStart, end: periodEnd },
    periods: periods.map((p) => ({
      id: toInt(p.id),
      name: p.name ?? "",
      start: pickStr(p.period_start)?.slice(0, 10) ?? null,
      end: pickStr(p.period_end)?.slice(0, 10) ?? null,
    })),
    classes,
    holiday_decisions: decisions,
    body,
    set_aside,
  };
}

// ── Preflight (api-v1 class/Class_Copy_Preflight.php, branch feature-class-copy-copy-jobs) ──

/** `POST schedules/copy`, the batch route (api-v1 schedules.php:363-368). */
const COPY_PATH = "/schedules/copy";

/**
 * One check (class/Preflight.php:63-90). Checks are keyed by name; `data` is set only on
 * a check that did not pass (Class_Copy_Preflight.php:1025-1036).
 */
export interface PreflightCheck {
  name: string;
  severity: string;
  result: string;
  data?: Record<string, unknown>;
}

export interface PreflightBooking {
  registration_id: number;
  status?: string;
  target_status?: string | null;
  /** Class_Copy_Preflight::amount() (:646-662). */
  amount_indicative?: { price?: number; registration_fee?: number; total?: number; admin_price?: boolean };
  already_carried?: { registration_id: number; schedule_id: number } | null;
  refusal?: string | null;
  /** null when carried; e.g. "booking_status_changed" for a cancelled booking, which is never
   *  carried and is left out of totals.bookings (api-v1, 2026-11-22). */
  notice?: string | null;
}

/** One class of the preflight (Class_Copy_Preflight::preview_class(), :171-177). */
export interface PreflightClass {
  /** The resolved new-class fields plus diff, price_hints, session_summary (:851-881). */
  schedule: {
    name?: string;
    course_id?: number | string | null;
    billing_period_id?: number | string | null;
    /** `{ field: { from, to } }` against the source; `{}` when nothing changed. */
    diff?: Record<string, { from: unknown; to: unknown }>;
    price_hints?: { course_price?: number; course_registration_fee?: number; price_field?: string };
    session_summary?: { count?: number; first_date?: string | null; last_date?: string | null };
  };
  sessions?: Array<{ date: string; time: number; duration: number; blocks?: string[] }>;
  bookings?: PreflightBooking[];
  checks?: Record<string, PreflightCheck> | PreflightCheck[];
}

/** Class_Copy_Preflight::preview() (:107-111). */
export interface PreflightResponse {
  classes: Record<string, PreflightClass>;
  totals: { classes: number; sessions: number; bookings: number; amount_indicative: number };
  checks?: Record<string, PreflightCheck> | PreflightCheck[];
}

type PreflightOutcome = { ok: true; response: PreflightResponse } | { ok: false; text: string };

/** PHP encodes an assoc array as an object, an empty one as `[]`: read both. */
function checkList(checks: PreflightResponse["checks"]): PreflightCheck[] {
  if (!checks || typeof checks !== "object") return [];
  return Object.values(checks).filter((c): c is PreflightCheck => !!c && typeof c === "object");
}

function failed(checks: PreflightResponse["checks"]): PreflightCheck[] {
  return checkList(checks).filter((c) => c.result === "not_passed");
}

/** The response is the array `Class_Copy::batch()` returns; a `data` envelope is read too. */
function unwrapPreflight(raw: unknown): PreflightResponse | null {
  const r = raw && typeof raw === "object" && "data" in raw && !("classes" in raw) ? (raw as { data: unknown }).data : raw;
  if (!r || typeof r !== "object") return null;
  const p = r as Partial<PreflightResponse>;
  if (!p.classes || typeof p.classes !== "object" || !p.totals || typeof p.totals !== "object") return null;
  return p as PreflightResponse;
}

/** api-v1's dry run of the batch body. Writes nothing (Class_Copy::run(), class/Class_Copy.php). */
async function preflight(body: CopyBatchBody, auth: ZoozaAuth): Promise<PreflightOutcome> {
  let raw: unknown;
  try {
    raw = await zoozaFetch<unknown>(COPY_PATH, { method: "POST", query: { action: "preflight_check" }, body }, auth);
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status >= 400 && error.status < 500) {
      return { ok: false, text: `Zooza refused the copy: ${error.humanMessage}. Nothing was copied.` };
    }
    return {
      ok: false,
      text: `Zooza's dry run of the copy failed (${apiText(error)}). Nothing was copied; there is no preview without it.`,
    };
  }
  const response = unwrapPreflight(raw);
  const missing = Object.keys(body.classes).filter((id) => !response?.classes[id]);
  if (!response || missing.length > 0) {
    return {
      ok: false,
      text: `Zooza's dry run did not return class ${missing.join(", ") || "rows"}. Nothing was copied; there is no preview without it.`,
    };
  }
  return { ok: true, response };
}

/**
 * The body with each operator `price` set on the field api-v1 prices that class by:
 * `price_hints.price_field` of the first preflight (Class_Copy_Preflight::price_hints(),
 * :889-907, which mirrors Schedule::get_unit_price()). Pure; the input body is unchanged.
 */
export function mapPriceOverrides(
  body: CopyBatchBody,
  classes: CopyClassClassInput[],
  first: PreflightResponse,
): { ok: true; body: CopyBatchBody } | { ok: false; text: string } {
  const out: CopyBatchBody = { classes: {} };
  for (const [id, cls] of Object.entries(body.classes)) out.classes[id] = { ...cls, overrides: { ...cls.overrides } };
  for (const c of classes) {
    if (c.price === undefined) continue;
    const field = first.classes[String(c.schedule_id)]?.schedule?.price_hints?.price_field;
    if (field !== "price" && field !== "unit_price") {
      return {
        ok: false,
        text: `Zooza did not say which price field class ${c.schedule_id} uses, so its price cannot be set. Nothing was copied.`,
      };
    }
    out.classes[String(c.schedule_id)].overrides[field] = c.price;
  }
  return { ok: true, body: out };
}

// ── Preview ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDay(ymd: string, withYear: boolean): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/** "12 Apr – 2 Jul 2027"; the year is said once when both ends share it. */
export function fmtPeriodDates(start: string | null, end: string | null): string {
  if (!start) return end ? `until ${fmtDay(end, true)}` : "no dates";
  if (!end) return `from ${fmtDay(start, true)}`;
  return `${fmtDay(start, start.slice(0, 4) !== end.slice(0, 4))} – ${fmtDay(end, true)}`;
}

/** "Mon 16:00, 45 min", slots joined with "; ", plus the interval when it is not weekly. */
export function patternText(pattern: PlanResult["pattern"]): string {
  if (!pattern) return "irregular: the source dates are shifted by whole weeks";
  const slots = pattern.slots.map((s) => `${s.weekday} ${s.time}, ${s.duration} min`).join("; ");
  return pattern.interval_days === 7 ? slots : `${slots}, every ${pattern.interval_days / 7} weeks`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function idList(v: unknown): string {
  return Array.isArray(v) ? v.map((x) => String(x)).join(", ") : "";
}

/** A check that did not pass, as the sentence the model reads (severity first). */
export function checkText(check: PreflightCheck, ctx: { className: string; periodName: string }): string {
  const d = check.data ?? {};
  let text: string;
  switch (check.name) {
    case "already_copied_to_billing_period":
      // Spec error catalog. The severity is error only when bookings are carried;
      // allow_repeat_copy makes it a notice (Class_Copy_Preflight.php:687-693).
      text =
        check.severity === "notice"
          ? `"${ctx.className}" already has a copy in "${ctx.periodName}" (class ${idList(d.schedule_ids)}); a second copy is made, as asked with allow_repeat_copy.`
          : `"${ctx.className}" already has a copy in "${ctx.periodName}" (class ${idList(d.schedule_ids)}). Drop it from the chunk, or set allow_repeat_copy: true if a second copy is intended.`;
      break;
    case "recently_copied":
      text =
        `This class was copied in the last 7 days` +
        (idList(d.schedule_ids) ? ` (class ${idList(d.schedule_ids)})` : "") +
        (idList(d.job_ids) ? `, or a copy job is still running for it (job ${idList(d.job_ids)})` : "") +
        ". Check with the operator that another copy is meant.";
      break;
    case "booking_already_in_target":
      text = `Booking ${idList(d.registration_ids)} already has a copy in a class copied from this one; it would be carried again.`;
      break;
    case "capacity_below_bookings":
      text = `Capacity ${String(d.capacity)} is below the ${String(d.seats)} seats the carried bookings take.`;
      break;
    case "registration_type_change":
      text = `The new programme books differently (${String(d.from)} → ${String(d.to)}).`;
      break;
    case "pricing_model_change":
      text = `The new programme prices differently (${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}).`;
      break;
    case "unknown_block_names":
      text = `Block ${idList(d.names)} is not a block of the source class; Zooza would create it as a new block.`;
      break;
    case "booking_refused": {
      const list = Array.isArray(d.bookings)
        ? d.bookings.map((b) => `${String((b as { registration_id?: unknown }).registration_id)} (${String((b as { error?: unknown }).error)})`)
        : [];
      text = `Zooza would refuse to carry booking ${list.join(", ")}.`;
      break;
    }
    case "class_cap":
      text = `${String(d.classes)} classes is more than the ${String(d.max)} one copy takes.`;
      break;
    default:
      text = `${check.name}${Object.keys(d).length > 0 ? ` ${JSON.stringify(d)}` : ""}.`;
  }
  return `${check.severity}: ${text}`;
}

export interface PreviewClassRow {
  source_schedule_id: number;
  name: string;
  programme: { id: number | null; name: string | null };
  new_programme: { id: number; name: string | null } | null;
  pattern: string;
  sessions: { count: number; first: string | null; last: string | null };
  blocks: PlanResult["block_counts"];
  bookings: { count: number; amount_indicative: number; not_carried?: Array<{ registration_id: number; notice: string }> };
  flags: string[];
  checks: string[];
}

export const INDICATIVE_WARNING = "Amounts are indicative: they are recomputed when each class is copied.";

/**
 * The preview, from api-v1's preflight response. Every class row and total is the
 * preflight's; only the pattern, blocks and flags are the planner's. Pure.
 */
export function shapePreview(args: {
  plan: CopyPlanReady;
  bookings: "enrolled" | "none";
  response: PreflightResponse;
  programmeNames: Map<number, string | null>;
}): { preview: Record<string, unknown>; blocking: string[] } {
  const { plan, response } = args;
  const periodName = (id: number) => plan.periods.find((p) => p.id === id);
  const blocking: string[] = [];
  const sourcePeriods: number[] = [];

  const classes: PreviewClassRow[] = plan.classes.map((c) => {
    const pf = response.classes[String(c.source_schedule_id)];
    const diff = pf.schedule.diff ?? {};
    // The source's period: the diff's `from` when the copy changes it, else the same.
    const from = diff.billing_period_id ? toInt(diff.billing_period_id.from) : toInt(pf.schedule.billing_period_id);
    if (!sourcePeriods.includes(from)) sourcePeriods.push(from);
    const newCourse = diff.course_id ? toInt(pf.schedule.course_id) : 0;
    const name = pf.schedule.name ?? c.name;
    // A booking with a notice is listed by api-v1 but not carried (e.g. cancelled since).
    const bookings = (pf.bookings ?? []).filter((b) => !b.notice);
    const notCarried = (pf.bookings ?? []).filter((b) => b.notice).map((b) => ({ registration_id: b.registration_id, notice: String(b.notice) }));
    const failedChecks = failed(pf.checks);
    if (failedChecks.some((x) => x.severity === "error")) blocking.push(`class ${c.source_schedule_id}`);
    const ss = pf.schedule.session_summary ?? {};
    const sessions = pf.sessions ?? [];
    return {
      source_schedule_id: c.source_schedule_id,
      name,
      programme: { id: c.programme_id, name: c.programme_id ? (args.programmeNames.get(c.programme_id) ?? null) : null },
      new_programme: newCourse ? { id: newCourse, name: args.programmeNames.get(newCourse) ?? null } : null,
      pattern: patternText(c.pattern),
      sessions: {
        count: ss.count ?? sessions.length,
        first: ss.first_date ?? sessions[0]?.date ?? null,
        last: ss.last_date ?? sessions.at(-1)?.date ?? null,
      },
      blocks: c.block_counts,
      bookings: {
        count: bookings.length,
        // api-v1 gives no per-class sum; this is the same sum its totals use (Class_Copy_Preflight.php:101).
        amount_indicative: round2(bookings.reduce((a, b) => a + (Number(b.amount_indicative?.total) || 0), 0)),
        ...(notCarried.length > 0 ? { not_carried: notCarried } : {}),
      },
      flags: [...c.flags, ...(c.cancelled_in_source > 0 ? [`cancelled_sessions_in_source: ${c.cancelled_in_source}`] : [])],
      checks: failedChecks.map((x) => checkText(x, { className: name, periodName: plan.target.name })),
    };
  });

  const jobChecks = failed(response.checks);
  if (jobChecks.some((x) => x.severity === "error")) blocking.push("the whole chunk");

  const src = sourcePeriods.map((id) => {
    const p = id > 0 ? periodName(id) : undefined;
    return p ? `"${p.name}" (${fmtPeriodDates(p.start, p.end)})` : id > 0 ? `${id}` : "none";
  });
  const t = response.totals;
  const bookingsText =
    args.bookings === "enrolled" ? `${t.bookings} bookings (enrolled clients)` : "no bookings (clients are not copied)";
  const scope =
    `Copying ${t.classes} ${t.classes === 1 ? "class" : "classes"} from billing ${src.length === 1 ? "period" : "periods"} ${src.join(", ")} ` +
    `into billing period "${plan.target.name}" (${fmtPeriodDates(plan.target.start, plan.target.end)}): ` +
    `${t.sessions} sessions, ${bookingsText}. Nobody is emailed.`;

  const preview: Record<string, unknown> = {
    scope,
    classes,
    totals: { classes: t.classes, sessions: t.sessions, bookings: t.bookings, amount_indicative: t.amount_indicative },
    holiday_decisions: plan.holiday_decisions,
    warnings: [
      INDICATIVE_WARNING,
      ...(plan.target.end === null
        ? [
            `Billing period "${plan.target.name}" has no last day, so no class can be flagged ends_after_period. ` +
              "Check each class's last session with the operator.",
          ]
        : []),
    ],
  };
  if (plan.set_aside.length > 0) {
    preview.set_aside = plan.set_aside;
    (preview.warnings as string[]).push(
      `${plan.set_aside.length === 1 ? "1 class is" : `${plan.set_aside.length} classes are`} NOT in this copy (set_aside, each with ` +
        "its reason). Tell the operator; never leave one out silently.",
    );
  }
  if (jobChecks.length > 0) {
    preview.checks = jobChecks.map((x) => checkText(x, { className: "", periodName: plan.target.name }));
  }
  return { preview, blocking };
}

/** Programme names for the rows, best-effort: a failed read leaves the name null. */
async function programmeNames(ids: number[], auth: ZoozaAuth): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  await Promise.all(
    [...new Set(ids.filter((id) => id > 0))].map(async (id) => {
      try {
        const raw = await zoozaFetch<{ data?: { name?: unknown }; name?: unknown }>(`/courses/${id}`, {}, auth);
        const rec = (raw?.data ?? raw) as { name?: unknown } | undefined;
        out.set(id, typeof rec?.name === "string" ? rec.name : null);
      } catch {
        out.set(id, null);
      }
    }),
  );
  return out;
}

async function runPreview(input: CopyClassInput, auth: ZoozaAuth): Promise<ToolResult> {
  const callAuth = withCompany(auth, input.company_id!);
  const outcome = await planCopy(input, callAuth);
  if (outcome.kind === "error") return errorResult(outcome.text);
  if (outcome.kind === "needs_decision") return jsonResult(outcome.result as unknown as Record<string, unknown>);

  // Dry run. A price override needs the first response's price_hints to know its field,
  // so it takes a second dry run with the mapped body; only that one drives the preview.
  let body = outcome.body;
  let pf = await preflight(body, callAuth);
  if (!pf.ok) return errorResult(pf.text);
  if (input.classes.some((c) => c.price !== undefined)) {
    const mapped = mapPriceOverrides(body, input.classes, pf.response);
    if (!mapped.ok) return errorResult(mapped.text);
    body = mapped.body;
    pf = await preflight(body, callAuth);
    if (!pf.ok) return errorResult(pf.text);
  }
  const response = pf.response;

  const names = await programmeNames(
    [
      ...outcome.classes.map((c) => c.programme_id ?? 0),
      ...Object.values(response.classes).map((c) => (c.schedule.diff?.course_id ? toInt(c.schedule.course_id) : 0)),
    ],
    callAuth,
  );
  const { preview, blocking } = shapePreview({ plan: outcome, bookings: input.bookings, response, programmeNames: names });

  // Any failed error check, in a class or for the chunk: no token. api-v1's commit would
  // refuse it anyway (Class_Copy::refuse_failed_error()).
  if (blocking.length > 0) {
    return jsonResult({
      ...preview,
      blocked:
        `No token: an error check failed for ${blocking.join(", ")}. Fix or drop ${blocking.length === 1 && blocking[0] !== "the whole chunk" ? "that class" : "those classes"} ` +
        "(see each class's checks), then preview again.",
    });
  }

  const plan: ClassCopyPlan = {
    company_id: input.company_id!,
    body: body as unknown as Record<string, unknown>,
    target: { id: outcome.target.id, name: outcome.target.name },
  };
  const { token, expires_at } = saveClassCopyPlan(plan);
  return jsonResult({ token, expires_at, ...preview });
}

// ── Apply ──

/** `{ job: { id, type, status, deduplicated, steps[] } }` (Class_Copy::job_response(), class/Class_Copy.php). */
interface RawJobResponse {
  id?: number | string;
  status?: string;
  deduplicated?: boolean;
  steps?: Array<{
    source_schedule_id?: number | string | null;
    status?: string;
    /** Class_Copy_Step::run() (class/Class_Copy_Step.php:118, :175). */
    result?: {
      schedule_id?: number | string;
      bookings?: Array<{ new_registration_id?: number | null; amount_charged?: number; skipped?: boolean }>;
    } | null;
    error?: { key?: string; data?: unknown };
  }>;
}

export function unconfirmedText(target: { id: number; name: string }): string {
  return `Zooza did not confirm the copy. Do NOT call again; check classes_show_copy_progress for billing period "${target.name}" (${target.id}) first.`;
}

/** What the model is told to do with failed classes (owner decision 2026-11-22, copy-retry-ledger.ts). */
export function failedClassesNext(failed: Array<{ source_schedule_id: number; error?: string; retryable?: boolean }>): string {
  const again = failed.filter((c) => c.retryable).map((c) => c.source_schedule_id);
  const ask = failed.filter((c) => !c.retryable).map((c) => c.source_schedule_id);
  const parts: string[] = ["Each failed class is all or nothing: no half-made copy exists."];
  if (again.length > 0) {
    parts.push(
      `Class ${again.join(", ")} failed with a temporary error (retryable: true). The operator already approved this ` +
        "copy: preview exactly those classes again with the same settings and apply once more without asking again.",
    );
  }
  if (ask.length > 0) {
    parts.push(
      `Class ${ask.join(", ")}: tell the operator why it failed (error) and let them decide; a retryable: false class ` +
        "already failed twice or needs a change, so do not repeat it unchanged.",
    );
  }
  return parts.join(" ");
}

function jobResult(job: RawJobResponse, target: { id: number; name: string }, companyId: string): Record<string, unknown> {
  const jobId = toInt(job.id);
  const status = String(job.status ?? "unknown");
  const classes = (job.steps ?? []).map((s) => {
    const r = s.result ?? null;
    const bookings = r?.bookings ?? [];
    const failedStep = s.status === "failed";
    const key = s.error?.key;
    const temporary = failedStep && isTemporaryStepError(key, s.error?.data);
    return {
      source_schedule_id: toInt(s.source_schedule_id),
      status: String(s.status ?? "unknown"),
      new_schedule_id: r ? toInt(r.schedule_id) || null : null,
      bookings_copied: r ? bookings.filter((b) => b.new_registration_id != null && b.skipped !== true).length : null,
      bookings_skipped: r ? bookings.filter((b) => b.skipped === true).length : null,
      amount_charged: r ? round2(bookings.reduce((a, b) => a + (Number(b.amount_charged) || 0), 0)) : null,
      ...(key ? { error: s.error?.data != null ? `${key}: ${JSON.stringify(s.error.data)}` : key } : {}),
      ...(failedStep
        ? { retryable: temporary && noteTemporaryFailure(companyId, toInt(s.source_schedule_id), jobId) }
        : {}),
    };
  });
  const where = `classes_show_copy_progress for billing period "${target.name}" (${target.id})`;
  let next: string;
  if (status === "completed") next = `Copied. ${where} shows what is left to copy.`;
  else if (status === "failed") {
    next = `Job ${jobId} failed for the classes marked failed. ${failedClassesNext(classes.filter((c) => c.status === "failed"))}`;
  } else {
    next =
      `Job ${jobId} is ${status}. Follow it with classes_show_copy_progress job_id:${jobId} in a minute ` +
      `(the period view, ${where.replace("classes_show_copy_progress ", "")}, shows these classes as in_progress); ` +
      "do not call this again for the same classes.";
  }
  if (job.deduplicated === true) {
    next = `An identical copy was already queued or running; this is that job, nothing new was started. ${next}`;
  }
  return { job_id: jobId || null, status, classes, next };
}

async function runApply(token: string, auth: ZoozaAuth): Promise<ToolResult> {
  const lookup = getClassCopyPlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This copy token is ${lookup.reason} (tokens are single-use and expire after 15 minutes). ` +
        "Call classes_copy_class again without a token and show the operator the new preview.",
    );
  }
  const plan = lookup.plan;
  // Company and body come from the stored plan, never from args: a caller passing
  // company_id alongside a token cannot redirect the write (dual-phase.ts:38-43).
  const callAuth = withCompany(auth, plan.company_id);

  let raw: unknown;
  try {
    // One POST, never retried: a repeat could start a second job.
    raw = await zoozaFetch<unknown>(COPY_PATH, { method: "POST", body: plan.body }, callAuth);
  } catch (error) {
    // 4xx: api-v1 refused before writing (Class_Copy::refuse_failed_error(), a changed
    // source, an already-copied class). The token stays valid, but the body is frozen.
    if (error instanceof ZoozaApiError && error.status >= 400 && error.status < 500) {
      return errorResult(
        `Zooza refused the copy: ${refusalText(error)}. Nothing was copied. Tell the operator why; to change ` +
          "the chunk, preview again without a token.",
      );
    }
    // 5xx, timeout, a dropped connection, or a 2xx we could not read: the job may exist.
    markClassCopyPlanUsed(token);
    const detail = error instanceof ZoozaApiError ? `api-v1 ${error.status}: ${error.humanMessage}` : String(error);
    return errorResult(`${unconfirmedText(plan.target)} (${detail})`);
  }
  markClassCopyPlanUsed(token);
  const r = raw && typeof raw === "object" ? (raw as { job?: RawJobResponse; data?: { job?: RawJobResponse } }) : {};
  const job = r.job ?? r.data?.job;
  if (!job || typeof job !== "object") return errorResult(`${unconfirmedText(plan.target)} (no job in Zooza's reply)`);
  return jsonResult(jobResult(job, plan.target, String(plan.company_id)));
}

/**
 * api-v1's refusal with its error KEY, not only the value: the shared parser keeps the
 * value alone, which for `resource_not_found` is just "Schedule" (live, 2026-11-22),
 * and that tells neither the model nor the operator anything.
 */
export function refusalText(error: ZoozaApiError): string {
  try {
    const body = JSON.parse(error.responseText) as { error_log_raw?: Array<{ key?: unknown; val?: unknown }>; errors?: unknown[] };
    const fromLog = (body.error_log_raw ?? [])
      .map((e) => [e.key, e.val].filter((x) => typeof x === "string" && x.length > 0).join(": "))
      .filter((t) => t.length > 0);
    if (fromLog.length > 0) return [...new Set(fromLog)].join("; ");
    const fromErrors = (body.errors ?? []).flatMap((e) =>
      e && typeof e === "object" ? Object.entries(e as Record<string, unknown>).map(([code, msg]) => `${code} ${Array.isArray(msg) ? msg.join(": ") : String(msg)}`) : [],
    );
    if (fromErrors.length > 0) return fromErrors.join("; ");
  } catch {
    // not JSON: fall through
  }
  return `api-v1 ${error.status}: ${error.humanMessage}`;
}

// ── Tool entry ──

export async function runCopyClass(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const raw = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const phase = resolveDualPhase(raw);
  if (phase.kind === "error") return errorResult(phase.message);
  if (phase.kind === "apply") return runApply(phase.token, auth);

  // Before zod, so these read as the spec's directives rather than schema errors.
  if (Array.isArray(raw.classes) && raw.classes.length > CHUNK_MAX) return errorResult(CHUNK_ERROR);
  if (raw.bookings === undefined || raw.session_count === undefined) return errorResult(ASK_OPERATOR_ERROR);

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  return runPreview(parsed.data, auth);
}
