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

/** Curated match shape for classes_find_courses — see ZMCP-20260523-001. */
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

/** Raw course record from /v1/courses — superset of CourseDto, only the fields classes_find_courses reads. */
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

/** Curated match shape for classes_find_classes — see ZMCP-20260615-001.
 *  `start`/`end`/`time` + `trainer_name`/`place_name` are the disambiguators when
 *  several classes share a name; `schedule_id` is the resolve payload (feeds
 *  comms_prepare_message audience.schedule_id). `course_name` is intentionally
 *  ABSENT: the /schedules collection path does not honor load_course, so only
 *  course_id is available without a second call — resolve the name with
 *  classes_find_courses if needed. */
export interface ScheduleMatch {
  schedule_id: number;
  name: string;
  course_id: number;
  start: string;
  end: string;
  time: string;
  trainer_id: number;
  trainer_name: string;
  place_id: number;
  place_name: string;
  capacity: number;
  registrations_count: number;
  status: string;
}

/** Raw schedule record from /v1/schedules (collection path, load_trainer=1).
 *  Only the fields classes_find_classes reads are typed. */
export interface RawScheduleRecord {
  id: number;
  name?: string;
  course_id?: number;
  start?: string;
  end?: string;
  time?: string;
  trainer_id?: number;
  place_id?: number;
  capacity?: number | string;
  status?: string;
  /** Denormalised venue name (Schedule::place()). */
  __calc__course_place?: string;
  /** Materialised active-registration count (Schedule __calc__registered). */
  __calc__registered?: number | string;
  /** Present only when the request passed load_trainer=1. */
  trainer?: {
    id?: number;
    first_name?: string;
    last_name?: string;
  };
}

/** Curated match shape for classes_find_billing_periods — see ZMCP-20260523-004. */
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

/** Curated match shape for trainers_find — see ZMCP-20260523-003. */
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

/** Curated match shape for classes_find_places — see ZMCP-20260523-002. */
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

// ─── sessions_find_events / sessions_get_attendance / sessions_mark_attendance ─────────────────────────
// Shared types for the attendance tooling pillar (ZMCP-20260527-002, -003, -004).

/** Per-event attendance counters surfaced by sessions_find_events. Derived from
 *  api-v1's materialised `__calc__attendance__*` columns. Sums of
 *  `registrations.slots`, not COUNTs (one registration can book multiple slots). */
export interface AttendanceCounts {
  going: number;
  attended: number;
  noshow: number;
  canceled: number;
  canceled_late: number;
  waitlist: number;
}

/** Curated event row for sessions_find_events output. Trimmed from the full api-v1
 *  /v1/events row + embedded sub-resources for reasoning-ready LLM use. */
export interface EventMatch {
  event_id: number;
  schedule_id: number;
  course_id: number;
  trainer_id: number;
  place_id: number;
  room_id: number;
  date: string;
  duration: number;
  status: string;
  course_name: string;
  trainer_name: string;
  place_name: string;
  event_number: string;
  capacity: number;
  attendance_counts: AttendanceCounts;
  segments: string[];
  is_substituted: boolean;
  is_replacement: boolean;
  has_public_summary: boolean;
  cancellation_reasoning_public: string | null;
}

export interface FindEventsScopeHint {
  reason: "caller_is_trainer";
  trainer_id: number;
}

export interface FindEventsResult {
  // JSON-object DTO returned as a tool's structuredContent sidecar; the index
  // signature makes it assignable to the MCP SDK's `Record<string, unknown>`.
  [key: string]: unknown;
  meta: {
    page: number;
    page_size: number;
    total: number;
    scoped_to: FindEventsScopeHint | null;
    warnings?: string[];
  };
  events: EventMatch[];
}

/** Mark-attendance per-row result. */
export type MarkAttendanceRowStatus = "ok" | "error";

export interface MarkAttendanceRow {
  registration_id: number;
  attendance: string;
  status: MarkAttendanceRowStatus;
  error_code?: string;
  error_message?: string;
  /** Deferred action the caller should surface after this write (ZMCP-20260527-002
   *  / agreed handoff -20260527-001, api API-20260529-001). Currently only
   *  `"trial_followup"`: set when an `attended` write on a trial's final session
   *  produced an open `trial_followup` todo. The attendance skill resolves it. */
  pending_action?: "trial_followup";
  /** The `todos` row id backing `pending_action`, for the skill to read/resolve. */
  todo_id?: number;
}

export interface MarkAttendanceResult {
  event_id: number;
  total: number;
  succeeded: number;
  failed: number;
  results: MarkAttendanceRow[];
  /** Current event-level summary state — same shape as sessions_get_attendance's. Surfaced
   *  here so after-mark the LLM can offer sessions_add_summary without
   *  a separate read. */
  summary: EventSummaryState;
}

/** Per-row entrance-voucher state surfaced by sessions_get_attendance.
 *  Non-null only when the attendee's course has registration_type="open". */
export interface AttendanceVoucher {
  unused_entrance_vouchers: number;
  credit_id: number | null;
}

/** Identity block for one party on an attendance row.
 *
 *  Zooza's data model splits each registration into TWO people:
 *  - **attendee** (api-v1 field: `customer`) — the person who actually
 *    shows up. Often a child; may have `user_id = 0` if they aren't a
 *    registered Zooza account holder (typical for children).
 *  - **client** (api-v1 field: `buyer`) — the account holder / payer.
 *    Usually an adult; has a real `user_id`. Contact info (email, phone)
 *    lives here when the attendee is a child.
 *
 *  When the attendee IS the client (adult attending themselves), the two
 *  blocks carry the same data. */
export interface AttendancePerson {
  name: string;
  user_id: number;
  email: string | null;
  phone: string | null;
}

export interface AttendeeIdentity extends AttendancePerson {
  date_of_birth: string | null;
}

/** One attendee row in sessions_get_attendance output. */
export interface AttendanceRow {
  registration_id: number;
  /** Pre-formatted one-line display label. When attendee == client, just
   *  the one name (e.g. "Martin Rapavy"). When they differ, the attendee
   *  with the client in parens (e.g. "Jozko Jozko (Martin Rapavy)") so
   *  the LLM can list attendees without needing to compose names itself. */
  display_name: string;
  /** Person who attends (customer in api-v1). Often a child. */
  attendee: AttendeeIdentity;
  /** Account holder / payer (buyer in api-v1). Contact info lives here. */
  client: AttendancePerson;
  status: string;
  is_trial: boolean;
  /** V1: always null. See spec ZMCP-20260527-003 Notes — derivation requires
   *  either an api-v1 schema-level field or per-row lookups; deferred. */
  is_last_trial_session: boolean | null;
  attendance: string | null;
  cancellation_reason: string | null;
  note: string | null;
  replacement: boolean;
  is_free_event: boolean;
  cross_company: boolean;
  /** Statuses THIS caller is permitted to set for THIS attendee. Computed
   *  per row using the rules mirrored from `class/Attendance.php:1358-1367`. */
  allowed_statuses: string[];
  entrance_voucher: AttendanceVoucher | null;
}

export interface AttendanceResult {
  // JSON-object DTO returned as structuredContent; index signature makes it
  // assignable to the MCP SDK's `Record<string, unknown>`.
  [key: string]: unknown;
  event_id: number;
  course: {
    id: number;
    registration_type: string;
    attendance_management: string;
  };
  totals: {
    enrolled: number;
    marked: number;
    trial: number;
  };
  /** Current event-level summary state. Lets the LLM decide whether to
   *  offer sessions_add_summary as a follow-up without a second tool call. */
  summary: EventSummaryState;
  attendees: AttendanceRow[];
}

/** Raw nested person block on an attendance row (customer or buyer). */
export interface RawAttendancePerson {
  id?: number;
  user_id?: number | string;
  first_name?: string;
  last_name?: string;
  person_data?: {
    email?: string | null;
    phone?: string | null;
    date_of_birth?: string | null;
  };
}

/** Raw row from /v1/attendance?event_id=… listing. */
export interface RawAttendanceRow {
  registration_id?: number;
  event_id?: number;
  user_id?: number | string;
  full_name?: string;
  email?: string;
  attendance?: string | null;
  cancellation_reason?: string | null;
  note?: string | null;
  status?: string;
  attendance_management?: string;
  replacement?: boolean | number;
  is_free_event?: boolean | number;
  company_id?: number;
  registration_type?: string;
  /** Attendee (the person who shows up; often a child). */
  customer?: RawAttendancePerson;
  /** Account holder / payer (often the parent). */
  buyer?: RawAttendancePerson;
  /** Free-text "full name" extra field — sometimes the attendee name
   *  for legacy data shapes. Used as a fallback when customer is absent. */
  ef_full_name?: string;
  entrance_voucher?: {
    user_id?: number | string;
    unused_entrance_vouchers?: number | string;
    credit_id?: number | string | null;
  };
}

/** Raw event row from /v1/events?filter=filter — the collection path,
 *  which (unlike the bare /v1/events/{id} detail path) embeds the FULL
 *  course object including track_attendance, registration_type, and
 *  other course fields. Both sessions_get_attendance and sessions_mark_attendance
 *  use the collection-with-ids form to fetch a single event so the
 *  embedded course is populated. */
export interface RawEventDetail {
  id?: number;
  course_id?: number;
  course?: {
    id?: number;
    registration_type?: string;
    attendance_management?: string;
    /** 0/false disables attendance tracking — the hard error condition.
     *  Only populated via the collection path; absent on the detail path. */
    track_attendance?: boolean | number | string;
  };
  // Summary state — surfaced for the sessions_add_summary follow-up and
  // for the hint blocks on sessions_get_attendance/sessions_mark_attendance responses.
  summary?: string | null;
  summary_public?: string | null;
  summary_public_locked?: boolean | number | null;
  summary_public_filled_at?: string | null;
}

/** Event-level summary state — surfaced as a hint by sessions_get_attendance
 *  and sessions_mark_attendance so the LLM can offer sessions_add_summary as a
 *  follow-up without a separate read. Also returned by sessions_add_summary
 *  itself as the post-write echo. */
export interface EventSummaryState {
  public_set: boolean;
  public_filled_at: string | null;
  public_locked: boolean;
  internal_set: boolean;
  /** True iff the caller's role allows writing summaries (owner/assistant
   *  per api-v1's edit_course permission). */
  writable_by_caller: boolean;
}

/** Per-field write outcome inside sessions_add_summary's response. */
export type AddSessionSummaryFieldStatus = "ok" | "error" | "skipped";

export interface AddSessionSummaryFieldResult {
  status: AddSessionSummaryFieldStatus;
  error_code?: string;
  error_message?: string;
  reason?: string;
  /** Set on a successful public write — count of attendees whose
   *  Person_Feed will receive the SUMMARY_PUBLIC item. */
  delivered_to_attendees?: number;
}

export interface AddSessionSummaryResult {
  // JSON-object DTO returned as structuredContent; index signature makes it
  // assignable to the MCP SDK's `Record<string, unknown>`.
  [key: string]: unknown;
  event_id: number;
  results: {
    internal_summary: AddSessionSummaryFieldResult;
    public_summary: AddSessionSummaryFieldResult;
  };
  summary_state_after: EventSummaryState;
}

/** Raw event row from api-v1 /v1/events?filter=filter — the modern
 *  collection path. Only fields sessions_find_events consumes are typed; everything
 *  else is intentionally untyped (read-and-discard at projection). */
export interface RawEventRecord {
  id: number;
  company_id?: number;
  course_id?: number;
  schedule_id?: number;
  trainer_id?: number;
  place_id?: number;
  room_id?: number;
  name?: string;
  date?: string;
  duration?: number | string;
  status?: string;
  is_custom_replacement_event?: boolean | number;
  substituted?: boolean | number;
  summary_public?: string | null;
  summary_public_locked?: boolean | number;
  cancellation_reasoning_public?: string | null;
  // Materialised display + counter fields
  __calc__event_number?: string | number;
  __calc__event_trainer?: string;
  __calc__event_place?: string;
  __calc__attendance__going?: number | string;
  __calc__attendance__attended?: number | string;
  __calc__attendance__noshow?: number | string;
  __calc__attendance__canceled?: number | string;
  __calc__attendance__canceled_late?: number | string;
  __calc__attendance__waitlist?: number | string;
  __schedule_segments__id?: string;
  __schedule_segments__name?: string;
  // Embedded sub-resources (read for denormalised hints, then discarded)
  course?: {
    id?: number;
    name?: string;
    registration_type?: string;
  };
  schedule?: {
    id?: number;
    capacity?: number | string;
    duration?: number | string;
  };
  segments?: Array<{ id?: number; name?: string }>;
}
