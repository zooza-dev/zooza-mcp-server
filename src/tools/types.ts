export type ScheduleType = "fixed_period" | "lead_collection";
export type Cadence = "daily" | "weekly" | "biweekly" | "monthly";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface ResolvedSchedule {
  course_id: number;
  course_name: string;
  /** Optional. Omit when the user didn't explicitly request a name — api-v1 auto-renders `{course_name} {class_name} {session_dates}` for end users. */
  name?: string;
  place_id: number;
  place_name: string;
  room_id: number;
  trainer_id: number;
  trainer_rate_type_id: number;
  capacity: number;
  duration_minutes: number;
  all_day: boolean;
  online_registration: boolean;
  schedule_type: ScheduleType;
  unit_price: number;
  price: number;
  registration_fee: number;
  billable_events: number;
  billing_period_id?: number;
}

export interface AvailablePaymentTemplate {
  id: number;
  name: string;
  selected_by_default: boolean;
}

export interface PreviewScheduleResult {
  schedule: ResolvedSchedule;
  payment_templates: AvailablePaymentTemplate[];
  warnings: string[];
}

export interface PreviewEvent {
  date_string: string;
  time: string;
  time_minutes: number;
  duration: number;
  billable: boolean;
  trainer_id?: number;
}

/**
 * Outgoing block sent to api-v1 /v1/events/preview/. Each block must carry
 * EXACTLY ONE of `until_date` or `count` — api-v1 rejects both/neither with
 * `wrong_parameters_sent:block_repeat_mode`.
 */
export interface EventsPreviewBlock {
  weekdays?: Weekday[];
  time_minutes: number;
  duration: number;
  all_day: boolean;
  billable: boolean;
  cadence?: Cadence;
  trainer_id?: number;
  until_date?: string;
  count?: number;
}

export interface AdditionalDate {
  date_string: string;
  time_minutes: number;
  duration: number;
  billable: boolean;
  trainer_id?: number;
}

export interface EventsPreviewRequest {
  place_id: number;
  from_date: string;
  blocks: EventsPreviewBlock[];
  additional_dates: AdditionalDate[];
  skip_holidays: boolean;
  skip_school_holidays: boolean;
  skip_custom_holidays: boolean;
}

export interface EventsPreviewResponseEvent {
  date_string: string;
  time_minutes: number;
  duration: number;
  billable: boolean;
  trainer_id?: number;
}

export interface EventsPreviewSkipped {
  date_string: string;
  reason: string;
  label?: string;
}

export interface EventsPreviewResponse {
  events: EventsPreviewResponseEvent[];
  skipped: EventsPreviewSkipped[];
  holidays_snapshot_id?: string | null;
}

export interface CourseDto {
  id: number;
  name: string;
  registration_type?: "single" | "full2" | "open";
  target_audience?: string;
  price_type?: string;
  unit_price?: number | string;
  price?: number | string;
  registration_fee?: number | string;
  billable_events?: number | string;
}

export interface PlaceDto {
  id: number;
  name: string;
  rooms?: Array<{ id: number; name?: string; capacity?: number }>;
}

/**
 * Common envelope returned by api-v1's list endpoints (e.g. /v1/courses).
 * Settings echoes back the applied query filters so the LLM can confirm
 * what was searched.
 */
export interface ApiListResponse<T> {
  total?: number;
  page?: number;
  page_size?: number;
  settings?: Record<string, unknown>;
  data?: T[];
}

/** Shape returned to the LLM by find_* tools (envelope only — matches[] is per-tool). */
export interface FindMatchesEnvelope<T> {
  matches: T[];
  total: number;
  page: number;
  page_size: number;
  truncated: boolean;
  echo: Record<string, unknown>;
}

/** Curated match shape for find_courses — see ZMCP-20260523-001. */
export interface CourseMatch {
  id: number;
  name: string;
  registration_type: string;
  course_type: string;
  target_audience: string;
  price: number;
  unit_price: number;
  price_type: string;
  archive: boolean;
  online_registration: boolean;
  schedules_count: number;
  registrations_count: number;
}

/** Raw course record from /v1/courses — superset of CourseDto, only the fields find_courses reads. */
export interface RawCourseRecord {
  id: number;
  name: string;
  registration_type?: string;
  course_type?: string;
  target_audience?: string;
  price?: number | string;
  unit_price?: number | string;
  price_type?: string;
  archive?: boolean;
  online_registration?: boolean;
  __calc__schedules_count?: number | string;
  __calc__registrations_count?: number | string;
}

/** Curated match shape for find_billing_periods — see ZMCP-20260523-004. */
export interface BillingPeriodMatch {
  id: number;
  name: string;
  active: boolean;
}

/** Raw billing period record from /v1/billing_periods. */
export interface RawBillingPeriodRecord {
  id: number;
  name: string;
  active?: boolean;
}

/** Curated match shape for find_trainers — see ZMCP-20260523-003. */
export interface TrainerMatch {
  id: number;
  full_name: string;
  email: string;
  active: boolean;
  /**
   * True for system-wide placeholder trainers ("To be decided", "Trainer unassigned",
   * "Guest trainer", etc.) — accepted by api-v1 as `trainer_id` but with no real
   * user behind them. Treat them as valid pick options when the operator hasn't
   * assigned a real person yet.
   */
  virtual: boolean;
}

/** Raw user record from /v1/users. */
export interface RawUserRecord {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  role?: { role?: string } | string;
}

/** Curated match shape for find_places — see ZMCP-20260523-002. */
export interface PlaceMatch {
  id: number;
  name: string;
  city: string;
  street: string;
  rooms: Array<{ id: number; name: string; capacity: number }>;
}

/** Raw place record from /v1/places. */
export interface RawPlaceRecord {
  id: number;
  name?: string;
  city?: string;
  street?: string | null;
  status?: string;
  rooms?: Array<{
    id: number;
    name?: string;
    capacity?: number;
    status?: string;
  }>;
}

export type PaymentScheduleType =
  | "single_payment"
  | "in_advance"
  | "pay_as_you_go"
  | "by_attendance";

export type PaymentScheduleFrequency =
  | "monthly"
  | "weekly"
  | "biweekly"
  | "quarterly"
  | "annual";

export interface PaymentScheduleTemplateDto {
  id: number;
  name?: string;
  schedule_type?: PaymentScheduleType;
  frequency?: PaymentScheduleFrequency | string;
  value_date?: number;
  discount?: string;
}
