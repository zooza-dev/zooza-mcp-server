import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type {
  AvailablePaymentTemplate,
  CourseDto,
  PaymentScheduleTemplateDto,
  PaymentScheduleType,
  PlaceDto,
  PreviewScheduleResult,
  ResolvedSchedule,
  ScheduleType,
} from "./types.js";

const SCHEDULE_TYPES: [ScheduleType, ...ScheduleType[]] = [
  "fixed_period",
  "lead_collection",
];

export const previewScheduleTitle = "Preview a class schedule shell";

export const previewScheduleDescription =
  "Resolves a new class's *schedule shell* — the course, venue, trainer, capacity, prices, billing period, and default payment templates — and returns the result alongside any warnings. Performs no writes. Use this first in a class-creation flow to confirm the basic class settings with the user before collecting session dates via `classes_preview_events` and committing via `classes_commit_class`. Defaults are copied from the parent course where the caller hasn't specified them (capacity from `target_audience`, prices from the course's pricing fields). Always surface the `warnings[]` array to the user — entries about `online_registration` and `billing_period_id` are real decisions to confirm, not noise. For lead-collection classes (`schedule_type: lead_collection`), the events step is skipped entirely after this preview.\n\n`name` is OPTIONAL — do NOT pass it unless the user explicitly asked for a custom class name. End-user-facing display is auto-rendered by api-v1 as `{course_name} {class_name} {session_dates}`, so leaving it blank gives users the most informative label by default. Only set `name` when the user says something like 'call it \"Morning Yoga Group A\"'.";

export const previewScheduleInputSchema = {
  company_id: companyIdSchema,
  course_id: z.number().int().positive(),
  place_id: z.number().int().positive(),
  trainer_id: z.number().int().positive(),
  room_id: z.number().int().nonnegative().optional(),
  trainer_rate_type_id: z.number().int().nonnegative().optional(),
  schedule_type: z
    .enum(SCHEDULE_TYPES)
    .describe(
      "What kind of class this is. 'fixed_period' = a real class with concrete dates the trainer will run — sessions get created and customers register for them. 'lead_collection' = a pre-launch interest-gathering placeholder (no dates yet); customers can express interest, and the operator converts it to a fixed_period class once dates are decided. For lead_collection, the events step is skipped entirely after preview.",
    )
    .optional(),
  capacity: z.number().int().positive().optional(),
  duration_minutes: z.number().int().positive().optional(),
  all_day: z.boolean().optional(),
  online_registration: z.boolean().optional(),
  unit_price: z.number().nonnegative().optional(),
  price: z.number().nonnegative().optional(),
  registration_fee: z.number().nonnegative().optional(),
  billable_events: z.number().nonnegative().optional(),
  billing_period_id: z.number().int().positive().optional(),
  payment_schedule_template_ids: z.array(z.number().int().positive()).optional(),
  name: z
    .string()
    .describe(
      "OPTIONAL — leave unset unless the user explicitly asked for a custom class name. api-v1 auto-renders `{course_name} {class_name} {session_dates}` for end users when name is blank, which is almost always what you want.",
    )
    .optional(),
};

const inputSchema = z.object(previewScheduleInputSchema);

type PreviewScheduleInput = z.infer<typeof inputSchema>;

export async function runPreviewSchedule(
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
  // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
  const callAuth = withCompany(auth, input.company_id!);

  let course: CourseDto;
  try {
    course = await fetchCourse(input.course_id, callAuth);
  } catch (error) {
    return zoozaErrorResult(
      error,
      `Course ${input.course_id} not found in company ${input.company_id}. Use classes_find_courses to look up by name.`,
    );
  }

  let place: PlaceDto;
  try {
    place = await fetchPlace(input.place_id, callAuth);
  } catch (error) {
    return zoozaErrorResult(
      error,
      `Place ${input.place_id} not found. Use classes_find_places to look up by name.`,
    );
  }

  let templates: PaymentScheduleTemplateDto[];
  try {
    templates = await fetchCoursePaymentTemplates(input.course_id, callAuth);
  } catch (error) {
    return zoozaErrorResult(
      error,
      "Could not load payment templates for the course.",
    );
  }

  const scheduleType: ScheduleType = input.schedule_type ?? "fixed_period";
  const schedule = resolveSchedule(input, course, place, scheduleType);
  const selectedTemplateIds =
    input.payment_schedule_template_ids ?? templates.map((t) => t.id);
  const availableTemplates: AvailablePaymentTemplate[] = templates.map((t) => ({
    id: t.id,
    name: renderTemplateName(t),
    selected_by_default: selectedTemplateIds.includes(t.id),
  }));
  const warnings = buildWarnings(input, course, place, schedule);

  const result: PreviewScheduleResult = {
    schedule,
    payment_templates: availableTemplates,
    warnings,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

async function fetchCourse(id: number, auth: ZoozaAuth): Promise<CourseDto> {
  const raw = await zoozaFetch<{ data?: CourseDto } | CourseDto>(`/courses/${id}`, {}, auth);
  const course = (raw as { data?: CourseDto })?.data ?? (raw as CourseDto);
  if (!course || !course.id) {
    throw new ZoozaApiError(404, `/courses/${id}`, "Course not found");
  }
  return course;
}

async function fetchPlace(id: number, auth: ZoozaAuth): Promise<PlaceDto> {
  const raw = await zoozaFetch<{ data?: PlaceDto } | PlaceDto>(`/places/${id}`, {}, auth);
  const place = (raw as { data?: PlaceDto })?.data ?? (raw as PlaceDto);
  if (!place || !place.id) {
    throw new ZoozaApiError(404, `/places/${id}`, "Place not found");
  }
  return place;
}

async function fetchCoursePaymentTemplates(
  courseId: number,
  auth: ZoozaAuth,
): Promise<PaymentScheduleTemplateDto[]> {
  const raw = await zoozaFetch<
    | { data?: { data?: PaymentScheduleTemplateDto[] } | PaymentScheduleTemplateDto[] }
    | PaymentScheduleTemplateDto[]
  >(`/courses/${courseId}/payment_schedules_templates`, {}, auth);
  const outer = (raw as { data?: unknown })?.data ?? raw;
  const list = (outer as { data?: PaymentScheduleTemplateDto[] })?.data ?? outer;
  return Array.isArray(list) ? list : [];
}

function resolveSchedule(
  input: PreviewScheduleInput,
  course: CourseDto,
  place: PlaceDto,
  scheduleType: ScheduleType,
): ResolvedSchedule {
  const isGroups = course.target_audience === "groups";
  const capacity = input.capacity ?? (isGroups ? 10 : 1);

  return {
    course_id: input.course_id,
    course_name: course.name,
    // Only carry `name` when the caller explicitly provided one. api-v1
    // auto-composes the end-user label from course + sessions otherwise.
    ...(input.name ? { name: input.name } : {}),
    place_id: input.place_id,
    place_name: place.name,
    room_id: input.room_id ?? 0,
    trainer_id: input.trainer_id,
    trainer_rate_type_id: input.trainer_rate_type_id ?? 0,
    capacity,
    duration_minutes: input.duration_minutes ?? 60,
    all_day: input.all_day ?? false,
    online_registration: input.online_registration ?? true,
    schedule_type: scheduleType,
    unit_price: input.unit_price ?? toNumber(course.unit_price),
    price: input.price ?? toNumber(course.price),
    registration_fee: input.registration_fee ?? toNumber(course.registration_fee),
    billable_events: input.billable_events ?? toNumber(course.billable_events),
    billing_period_id: input.billing_period_id,
  };
}

function buildWarnings(
  input: PreviewScheduleInput,
  course: CourseDto,
  place: PlaceDto,
  schedule: ResolvedSchedule,
): string[] {
  const warnings: string[] = [];
  const room = place.rooms?.find((r) => r.id === schedule.room_id);
  if (room) {
    if (typeof room.capacity === "number" && room.capacity > 0) {
      if (schedule.capacity > room.capacity) {
        warnings.push(
          `Schedule capacity (${schedule.capacity}) exceeds the room's capacity (${room.capacity}). The class will be created but bookings will be capped by the schedule value.`,
        );
      }
    } else if (schedule.room_id !== 0) {
      warnings.push(
        `Room ${schedule.room_id} has no capacity configured — cannot compare against schedule capacity (${schedule.capacity}).`,
      );
    }
  }
  const courseUnit = toNumber(course.unit_price);
  if (input.unit_price === undefined && courseUnit > 0) {
    warnings.push(
      `Copied unit_price ${courseUnit} from the parent course. Pass unit_price explicitly to override.`,
    );
  }
  const coursePrice = toNumber(course.price);
  if (input.price === undefined && coursePrice > 0) {
    warnings.push(
      `Copied price ${coursePrice} from the parent course. Pass price explicitly to override.`,
    );
  }
  if (input.online_registration === undefined) {
    warnings.push(
      "Defaulted online_registration to true — the class will be published on your public website. Confirm with the user; pass online_registration: false to keep it private.",
    );
  }
  if (input.billing_period_id === undefined) {
    warnings.push(
      "billing_period_id not provided — api-v1 will fall back to the most recent active billing period. Ask the user which billing period applies before committing (use classes_find_billing_periods once available).",
    );
  }
  return warnings;
}

const SCHEDULE_TYPE_LABELS: Record<PaymentScheduleType, string> = {
  single_payment: "One-off payment (Discount or Combination)",
  in_advance: "Prepaid Periodic Payment",
  pay_as_you_go: "Membership Payment",
  by_attendance: "Post-attendance Periodic Payment",
};

const FREQUENCY_LABELS: Record<string, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  quarterly: "Quarterly",
  annual: "Annual",
};

function renderTemplateName(t: PaymentScheduleTemplateDto): string {
  if (t.name && t.name.length > 0) return t.name;

  const scheduleType = t.schedule_type;
  if (!scheduleType || !(scheduleType in SCHEDULE_TYPE_LABELS)) {
    return `template-${t.id}`;
  }
  const base = SCHEDULE_TYPE_LABELS[scheduleType];

  if (scheduleType === "single_payment") {
    return base;
  }

  const parts = [base];
  const freq = t.frequency
    ? FREQUENCY_LABELS[t.frequency] ?? t.frequency
    : null;
  if (freq) parts.push(freq);

  if (typeof t.value_date === "number") {
    if (t.value_date === 0) {
      parts.push("Scheduled payment at the time of the next anniversary");
    } else {
      parts.push(`Payment on the ${t.value_date}. of the month`);
    }
  }
  return parts.join(", ");
}

function toNumber(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function zoozaErrorResult(error: unknown, fallback: string) {
  if (error instanceof ZoozaApiError) {
    if (error.status === 404) {
      return errorResult(fallback);
    }
    return errorResult(
      `${fallback} (api-v1 returned ${error.status}: ${error.humanMessage})`,
    );
  }
  return errorResult(error instanceof Error ? error.message : String(error));
}
