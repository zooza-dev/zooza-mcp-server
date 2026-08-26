import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type { ResolvedSchedule, ScheduleType } from "./types.js";

const SCHEDULE_TYPES: [ScheduleType, ...ScheduleType[]] = [
  "fixed_period",
  "lead_collection",
];

export const commitClassTitle = "Commit a class (schedule + events)";

/**
 * An instalment-priced programme charges unit_price x billable sessions, but the
 * session count does not exist until commit time — so classes_add_course records the
 * operator's TOTAL and leaves unit_price at 0, and the division happens here.
 *
 * This closes the defect that produced three wrongly-priced courses in a row: told
 * "EUR 300 for the term", the model put 300 into unit_price, which over 20 sessions
 * is EUR 6000. Documenting the field as "per session" was not enough, because at
 * classes_add_course time the divisor is genuinely unknowable.
 */
export function deriveUnitPrice(
  totalPrice: number,
  billableEvents: number,
  createdCount: number,
): { unit_price: number; divisor: number } | null {
  if (!(totalPrice > 0)) return null;
  const divisor = billableEvents > 0 ? billableEvents : createdCount;
  if (!(divisor > 0)) return null;
  return { unit_price: Math.round((totalPrice / divisor) * 100) / 100, divisor };
}

export const commitClassDescription =
  "Writes a class to api-v1 in one shot: creates the schedule, attaches any selected payment templates (bundled inline), and posts the assembled events array. Call this only after the user has confirmed the class shell (from `classes_preview_schedule`) and the full event list (accumulated from one or more `classes_preview_events` calls). For lead-collection classes, pass `events: []`. Returns the created schedule's id and url plus the list of created event ids. If api-v1 silently skips any events (a known quirk), the tool surfaces the mismatch as an error so the caller knows the partial state.\n\n`schedule.name` is OPTIONAL — omit unless the user explicitly asked for a custom class name. api-v1 auto-renders `{course_name} {class_name} {session_dates}` end-user-facing when name is absent.";

const scheduleShape = z.object({
  course_id: z
    .number()
    .int()
    .positive()
    .describe("Parent programme (course) this class belongs to. Resolve with classes_find_courses."),
  course_name: z
    .string()
    .describe("Display name of the parent programme, carried through from classes_preview_schedule for labelling."),
  name: z
    .string()
    .optional()
    .describe(
      "OPTIONAL custom class name — omit unless the user explicitly asked for one. When blank, api-v1 auto-renders `{course_name} {class_name} {session_dates}` for end users.",
    ),
  place_id: z
    .number()
    .int()
    .positive()
    .describe("Venue (place) where the class runs. Resolve with classes_find_places."),
  place_name: z
    .string()
    .describe("Display name of the venue, carried through from classes_preview_schedule for labelling."),
  room_id: z
    .number()
    .int()
    .nonnegative()
    .describe("Room within the venue. `0` = no specific room."),
  trainer_id: z
    .number()
    .int()
    .positive()
    .describe("Instructor assigned to the class. Resolve with trainers_find."),
  trainer_rate_type_id: z
    .number()
    .int()
    .nonnegative()
    .describe("Trainer PAY-RATE type (what the instructor is paid, not what clients pay). Resolve with trainers_find_rate_types. `0` = none."),
  capacity: z
    .number()
    .int()
    .positive()
    .describe("Basic maximum number of seats per session — the ordinary class size."),
  duration_minutes: z
    .number()
    .int()
    .positive()
    .describe("Session length in minutes."),
  all_day: z
    .boolean()
    .describe("When true, the session has no fixed start time (an all-day session)."),
  online_registration: z
    .boolean()
    .describe("Whether clients can self-register for this class online — true publishes it on the public website."),
  schedule_type: z
    .enum(SCHEDULE_TYPES)
    .describe(
      "What kind of class this is. 'fixed_period' = a real class with concrete dates (sessions get created on commit). 'lead_collection' = interest-gathering placeholder (no events; pass events: []).",
    ),
  unit_price: z
    .number()
    .nonnegative()
    .describe("Per-session price, used when the programme prices per session."),
  price: z
    .number()
    .nonnegative()
    .describe("Total price for the class/period, used when the programme prices by total."),
  registration_fee: z
    .number()
    .nonnegative()
    .describe("One-time enrollment fee charged on top of the class price."),
  billable_events: z
    .number()
    .nonnegative()
    .describe("Number of billable sessions used to compute what clients owe."),
  billing_period_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Term block (billing period) this class belongs to. Resolve with classes_find_billing_periods."),
  total_price: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "The TOTAL price for the whole run, when the programme is priced in instalments. Pass it through from " +
        "classes_preview_schedule; unit_price is then derived here as total / billable sessions. Do NOT also pass " +
        "a non-zero unit_price — the operator quoted one number, not two.",
    ),
});

const eventShape = z.object({
  date_string: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Date of this session, YYYY-MM-DD."),
  time_minutes: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .describe("Session start time as minutes past midnight (0-1439, e.g. 540 = 09:00)."),
  duration: z
    .number()
    .int()
    .positive()
    .describe("Session length in minutes."),
  trainer_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional per-session instructor override. Resolve with trainers_find; defaults to the schedule's trainer_id when omitted."),
});

export const commitClassInputSchema = {
  company_id: companyIdSchema,
  schedule: scheduleShape.describe(
    "The confirmed class shell (course, venue, trainer, capacity, prices, billing period) as returned by classes_preview_schedule.",
  ),
  events: z
    .array(eventShape)
    .describe(
      "The full list of sessions to create, accumulated from one or more classes_preview_events calls. Pass [] for lead_collection classes.",
    ),
  payment_schedule_template_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Ids of the payment schedule templates to attach to the class. Omit to keep the course's default template selection from classes_preview_schedule.",
    ),
};

const inputSchema = z.object(commitClassInputSchema);

interface CreatedScheduleResponse {
  id?: number | string;
  __calc__registration_url?: string | null;
  __view__admin_url?: string | null;
  __view__registration_url_active?: boolean;
  data?: {
    id?: number | string;
    __calc__registration_url?: string | null;
    __view__admin_url?: string | null;
    __view__registration_url_active?: boolean;
  };
  [k: string]: unknown;
}

interface CreatedEventResponse {
  id?: number;
  [k: string]: unknown;
}

interface PaginatedEventsResponse {
  total?: number;
  settings?: { ids?: number[] };
  data?: CreatedEventResponse[];
}

export async function runCommitClass(
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
  const input = parsed.data;
  const schedule = input.schedule as ResolvedSchedule;
  // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
  const callAuth = withCompany(auth, input.company_id!);

  if (schedule.schedule_type === "lead_collection" && input.events.length > 0) {
    return errorResult(
      "Lead-collection classes cannot have events. Pass events: [] for schedule_type 'lead_collection'.",
    );
  }
  if (schedule.schedule_type === "fixed_period" && input.events.length === 0) {
    return errorResult(
      "Fixed-period classes need at least one event. Add sessions via classes_preview_events first.",
    );
  }

  // Instalment pricing: divide the operator's total by the sessions that now exist.
  // Guarded rather than silent — a caller who supplies BOTH numbers has contradicted
  // themselves, and picking one would hide the mistake.
  const derived = deriveUnitPrice(
    schedule.total_price ?? 0,
    schedule.billable_events,
    input.events.length,
  );
  if (schedule.total_price !== undefined && schedule.total_price > 0 && schedule.unit_price > 0) {
    return errorResult(
      `The class carries both a total_price (${schedule.total_price}) and a unit_price (${schedule.unit_price}). ` +
        "Those are different prices and Zooza would charge unit_price x sessions, ignoring the total. Keep " +
        "total_price if the operator quoted a price for the whole run, or unit_price if they quoted a per-session " +
        "price — not both.",
    );
  }
  if (schedule.total_price !== undefined && schedule.total_price > 0 && !derived) {
    return errorResult(
      `Cannot turn the total ${schedule.total_price} into a per-session price: this class has no billable ` +
        "sessions to divide by. Add sessions, or set billable_events on the class.",
    );
  }

  const schedulePayload = buildSchedulePayload(
    schedule,
    input.payment_schedule_template_ids ?? [],
    derived?.unit_price,
  );

  let scheduleResponse: CreatedScheduleResponse;
  try {
    scheduleResponse = await zoozaFetch<CreatedScheduleResponse>(
      "/schedules",
      { method: "POST", body: schedulePayload },
      callAuth,
    );
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `POST /v1/schedules failed (status ${error.status}): ${error.humanMessage}`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const scheduleId = extractScheduleId(scheduleResponse);
  if (!scheduleId) {
    return errorResult(
      "api-v1 returned a schedule shape with no id field — cannot continue. Inspect the api-v1 response.",
    );
  }
  const urls = extractScheduleUrls(scheduleResponse);

  let createdEventIds: number[] = [];
  if (schedule.schedule_type === "fixed_period" && input.events.length > 0) {
    const eventsPayload = {
      events: input.events.map((e) => ({
        schedule_id: scheduleId,
        course_id: schedule.course_id,
        trainer_id: e.trainer_id ?? schedule.trainer_id,
        trainer_rate_type_id: schedule.trainer_rate_type_id,
        place_id: schedule.place_id,
        room_id: schedule.room_id,
        date_string: e.date_string,
        time_string: e.time_minutes,
        duration: e.duration,
        // Sessions are billable. This is NOT cosmetic: api-v1 only applies the
        // `billable = 1` filter when billable_events > 0 (Schedule::get_remaining_events,
        // Schedule.php:1194-1198, gated by billable_set from get_billable_events_settings).
        // Creating non-billable events while ALSO setting billable_events > 0 makes that
        // filter match nothing, so remaining_events = 0 and the class prices at ZERO —
        // silently. That combination shipped and produced a EUR 0 course (schedule 7683).
        billable: true,
      })),
    };

    let raw: CreatedEventResponse[] | PaginatedEventsResponse;
    try {
      raw = await zoozaFetch<CreatedEventResponse[] | PaginatedEventsResponse>(
        "/events",
        { method: "POST", body: eventsPayload },
        callAuth,
      );
    } catch (error) {
      if (error instanceof ZoozaApiError) {
        return errorResult(
          `Schedule ${scheduleId} was created, but POST /v1/events failed (status ${error.status}): ${error.humanMessage}. The schedule shell exists with no events — either retry the events POST or DELETE /v1/schedules/${scheduleId}.`,
        );
      }
      throw error;
    }
    createdEventIds = extractEventIds(raw);
    if (createdEventIds.length === 0 && input.events.length > 0) {
      return errorResult(
        `Schedule ${scheduleId} was created, but POST /v1/events returned no event ids in any recognised shape: ${JSON.stringify(raw).slice(0, 300)}.`,
      );
    }
    if (createdEventIds.length !== input.events.length) {
      return errorResult(
        `api-v1 silently skipped ${input.events.length - createdEventIds.length} of ${input.events.length} sessions on POST /v1/events. Schedule ${scheduleId} exists with a partial session set (created ids: ${createdEventIds.join(", ")}). Inspect the schedule and either fix the inputs or use create_event for the missing dates.`,
      );
    }
  }

  const result = {
    schedule_id: scheduleId,
    registration_url: urls.registration_url,
    registration_url_active: urls.registration_url_active,
    admin_url: urls.admin_url,
    attached_payment_template_ids: input.payment_schedule_template_ids ?? [],
    created_event_ids: createdEventIds,
    ...(derived
      ? {
          pricing: {
            total_price: schedule.total_price,
            billable_sessions: derived.divisor,
            unit_price: derived.unit_price,
            note: `Zooza charges per session, so the total ${schedule.total_price} was divided across ${derived.divisor} billable session(s) to give unit_price ${derived.unit_price}. Tell the operator the TOTAL, not the per-session figure.`,
          },
        }
      : {}),
    warnings: [
      ...billableWarnings(schedule.billable_events, createdEventIds.length),
      ...(derived && derived.unit_price * derived.divisor !== schedule.total_price
        ? [
            `Rounding: ${derived.unit_price} x ${derived.divisor} = ${Math.round(derived.unit_price * derived.divisor * 100) / 100}, not exactly ${schedule.total_price}. Zooza's payment plan rounding settles the difference across instalments.`,
          ]
        : []),
    ],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
}

function buildSchedulePayload(
  s: ResolvedSchedule,
  paymentTemplateIds: number[],
  derivedUnitPrice?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    all_day: s.all_day,
    course_id: s.course_id,
    trainer_id: s.trainer_id,
    trainer_rate_type_id: s.trainer_rate_type_id,
    place_id: s.place_id,
    room_id: s.room_id,
    capacity: s.capacity,
    duration: s.duration_minutes,
    online_registration: s.online_registration,
    price: s.price,
    unit_price: derivedUnitPrice ?? s.unit_price,
    registration_fee: s.registration_fee,
    billable_events: s.billable_events,
    schedule_type: s.schedule_type,
  };
  // api-v1's Schedule validator (`Zooza\Resource\Schedule::insert_fields()`)
  // declares `name` REQUIRED + TYPE_STRING, so the field must always be on
  // the wire — but it accepts empty string. Empty name yields the auto-rendered
  // `{course_name} {session_dates}` end-user label per the agreed UX.
  payload.name = s.name?.trim() ?? "";
  if (s.billing_period_id !== undefined) {
    payload.billing_period_id = s.billing_period_id;
  }
  if (paymentTemplateIds.length > 0) {
    payload.payment_schedules = paymentTemplateIds;
  }
  return payload;
}

function extractScheduleId(raw: CreatedScheduleResponse): number | null {
  const candidates = [raw.id, raw.data?.id];
  for (const c of candidates) {
    if (typeof c === "number") return c;
    if (typeof c === "string") {
      const n = Number.parseInt(c, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractScheduleUrls(raw: CreatedScheduleResponse): {
  registration_url: string | null;
  admin_url: string | null;
  registration_url_active: boolean;
} {
  const inner = raw.data ?? raw;
  return {
    registration_url: inner.__calc__registration_url ?? null,
    admin_url: inner.__view__admin_url ?? null,
    registration_url_active: inner.__view__registration_url_active === true,
  };
}

function extractEventIds(
  raw: CreatedEventResponse[] | PaginatedEventsResponse,
): number[] {
  if (Array.isArray(raw)) {
    return raw
      .map((e) => e.id)
      .filter((id): id is number => typeof id === "number");
  }
  if (raw.settings?.ids && Array.isArray(raw.settings.ids)) {
    return raw.settings.ids.filter(
      (id): id is number => typeof id === "number",
    );
  }
  if (Array.isArray(raw.data)) {
    return raw.data
      .map((e) => e.id)
      .filter((id): id is number => typeof id === "number");
  }
  return [];
}

/**
 * Mirrors the app's own over/under-billable notice (app events_detail.js:1377-1385),
 * which the MCP had no equivalent of. A mismatch is not an error — a course can
 * deliberately charge for fewer sessions than it runs — but it is the kind of thing
 * an operator wants to hear about at creation time rather than at invoicing time.
 */
export function billableWarnings(billableEvents: number, createdCount: number): string[] {
  if (billableEvents <= 0 || billableEvents === createdCount) return [];
  return [
    billableEvents > createdCount
      ? `This class charges for ${billableEvents} sessions but only ${createdCount} were created — clients would be billed for ${billableEvents - createdCount} session(s) that do not exist. Set billable_events to ${createdCount}, or add the missing dates.`
      : `This class charges for ${billableEvents} of its ${createdCount} sessions — ${createdCount - billableEvents} session(s) are free. If that was not intended, set billable_events to ${createdCount}.`,
  ];
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
