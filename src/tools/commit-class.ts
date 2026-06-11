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

export const commitClassDescription =
  "Writes a class to api-v1 in one shot: creates the schedule, attaches any selected payment templates (bundled inline), and posts the assembled events array. Call this only after the user has confirmed the class shell (from `classes_preview_schedule`) and the full event list (accumulated from one or more `classes_preview_events` calls). For lead-collection classes, pass `events: []`. Returns the created schedule's id and url plus the list of created event ids. If api-v1 silently skips any events (a known quirk), the tool surfaces the mismatch as an error so the caller knows the partial state.\n\n`schedule.name` is OPTIONAL — omit unless the user explicitly asked for a custom class name. api-v1 auto-renders `{course_name} {class_name} {session_dates}` end-user-facing when name is absent.";

const scheduleShape = z.object({
  course_id: z.number().int().positive(),
  course_name: z.string(),
  name: z.string().optional(),
  place_id: z.number().int().positive(),
  place_name: z.string(),
  room_id: z.number().int().nonnegative(),
  trainer_id: z.number().int().positive(),
  trainer_rate_type_id: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  duration_minutes: z.number().int().positive(),
  all_day: z.boolean(),
  online_registration: z.boolean(),
  schedule_type: z
    .enum(SCHEDULE_TYPES)
    .describe(
      "What kind of class this is. 'fixed_period' = a real class with concrete dates (sessions get created on commit). 'lead_collection' = interest-gathering placeholder (no events; pass events: []).",
    ),
  unit_price: z.number().nonnegative(),
  price: z.number().nonnegative(),
  registration_fee: z.number().nonnegative(),
  billable_events: z.number().nonnegative(),
  billing_period_id: z.number().int().positive().optional(),
});

const eventShape = z.object({
  date_string: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time_minutes: z.number().int().min(0).max(1439),
  duration: z.number().int().positive(),
  billable: z.boolean(),
  trainer_id: z.number().int().positive().optional(),
});

export const commitClassInputSchema = {
  company_id: companyIdSchema,
  schedule: scheduleShape,
  events: z.array(eventShape),
  payment_schedule_template_ids: z.array(z.number().int().positive()).optional(),
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

  const schedulePayload = buildSchedulePayload(
    schedule,
    input.payment_schedule_template_ids ?? [],
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
        billable: e.billable,
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
    warnings: [] as string[],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function buildSchedulePayload(
  s: ResolvedSchedule,
  paymentTemplateIds: number[],
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
    unit_price: s.unit_price,
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

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
