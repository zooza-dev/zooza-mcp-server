/**
 * Declarative model of the nine programme-settings sections served by
 * classes_update_course_settings / classes_update_course_settings
 * (ZMCP-20260805-001).
 *
 * Each section mirrors one card of the app's tile-based settings dashboard
 * (app/pages/courses/course_settings.js) — the tile saves its own partial
 * PUT /v1/courses/{id}, and the field whitelist here is that tile's PUT
 * subset, verbatim from the spec table. Enum value sets are copied from the
 * app's option lists (course_settings.js) because api-v1 silently coerces
 * some invalid values instead of rejecting them (e.g. bad price_type →
 * course_fee) — validating up front keeps the coercion path unexercised.
 *
 * Pure data + pure functions. Fetching the course, building the diff, and
 * rendering the error-catalog messages are the prepare tool's job.
 */

/** Programme type ("registration_type") — gates whole sections and single fields. */
export type RegistrationType = "single" | "full2" | "open";

export const SECTION_NAMES = [
  "basic_info",
  "price_and_payment",
  "online_booking",
  "booking_form_labels",
  "makeup_sessions",
  "trial",
  "auto_enrolment",
  "attendance",
  "feedback",
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

interface FieldRule {
  /** Closed value set — prepare rejects anything outside it (invalid_enum). */
  enum?: readonly string[];
  /**
   * Spec's † marker: field lives in an ungated section but only applies to
   * full2 ("booking for full programme duration") programmes. Prepare rejects
   * it for single/open with the SECTION-GATE error, not the unknown-field one
   * (spec footnote †).
   */
  full2Only?: true;
  /**
   * Per-type variant scoping (attendance section): the field is part of the
   * section only for these programme types. A mismatch is an unknown-field
   * violation — the field simply isn't in the section for that programme.
   */
  types?: readonly RegistrationType[];
  /**
   * Spec's ‡ marker: virtual input, NOT an api-v1 column (the API silently
   * drops it). Prepare translates it (allow_multiple_registrations → slot
   * fields) and never puts the key in put_body. Translation is the prepare
   * tool's job — the model only flags it.
   */
  virtual?: true;
}

interface SectionRule {
  /** Section-level gate — section exists only for these programme types. Absent = all. */
  types?: readonly RegistrationType[];
  /** Allowed `changes` keys, in the spec table's order. */
  fields: Record<string, FieldRule>;
}

// Enum value sets (source: app option lists, course_settings.js line refs).
const PRICE_TYPES = ["course_fee", "membership"] as const;
const MONEY_COLLECTIONS = ["one_off", "installments"] as const; // course_create.js:168-176
const LATE_REGISTRATIONS = ["disabled", "confirmation_required", "auto_approve"] as const; // :1858-1870
const ALIQUOT_SETTINGS = ["automatic", "automatic_days", "no_value", "full_price"] as const; // :1893-1908
const DOWNPAYMENT_MODES = ["none", "absolute", "relative"] as const; // :1915-1924
const DOWNPAYMENT_DUE_TYPES = ["before_course", "after_registration"] as const; // :1925-1931
const REGISTRATION_DISPLAY_MODES = [
  "default",
  "full_course_only",
  "trials_only",
  "segments_only",
  "trials_and_segments_only",
] as const; // :258-273
const FIELD_SOURCES_BASIC = ["all", "registrant"] as const; // :362-370
const FIELD_SOURCES_EXTRA = ["all", "other"] as const; // :371-379
const REPLACEMENT_TIME_LIMIT_TYPES = ["before", "after"] as const; // :1690-1696
const TRIAL_TYPES = [
  "none",
  "free_trial",
  "free_time_trial",
  "paid_trial",
  "paid_time_trial",
  "lead_collection",
] as const; // :828-851
const TRIAL_EVENTS_LIMIT_TYPES = ["none", "date", "count"] as const; // :854-862
const TRIAL_EVENTS_CAPACITIES = ["all", "extra_capacity"] as const; // :890-898
const TRIAL_LENGTH_TYPES = ["days", "events"] as const; // :878-883
const RETENTION_TYPES = ["none", "suggest_schedules", "duplicate_schedule"] as const; // :1068-1079
const COURSE_TYPES = ["course", "event", "online_event", "photography"] as const; // moduleconfig.js:2167-2184
const TARGET_AUDIENCES = ["groups", "individuals"] as const;

export const SECTIONS: Record<SectionName, SectionRule> = {
  basic_info: {
    fields: {
      name: {},
      description: {},
      url: {},
      color: {},
      course_type: { enum: COURSE_TYPES },
      target_audience: { enum: TARGET_AUDIENCES },
      for_children: {},
      archive: {},
    },
  },
  price_and_payment: {
    fields: {
      price: {},
      unit_price: {},
      registration_fee: {},
      money_collection: { full2Only: true, enum: MONEY_COLLECTIONS },
      price_type: { full2Only: true, enum: PRICE_TYPES },
      billable_events: {},
      aliquot_settings: { full2Only: true, enum: ALIQUOT_SETTINGS },
      force_full_first_installment: { full2Only: true },
      late_registrations: { full2Only: true, enum: LATE_REGISTRATIONS },
      payments_managed_by_buyer: {},
      downpayment: { enum: DOWNPAYMENT_MODES },
      downpayment_value: {},
      downpayment_cap: {},
      downpayment_due_type: { enum: DOWNPAYMENT_DUE_TYPES },
      downpayment_due_days: {},
    },
  },
  online_booking: {
    fields: {
      public: {},
      online_registration: {},
      priority: {},
      registration_display_mode: { full2Only: true, enum: REGISTRATION_DISPLAY_MODES },
      allow_guest_registrations: {},
      hide_if_full: {},
      hide_before: {},
      allow_multiple_registrations: { virtual: true },
      registration_slots_min: {},
      registration_slots_max: {},
      get_basic_fields_from: { enum: FIELD_SOURCES_BASIC },
      get_extra_fields_from: { enum: FIELD_SOURCES_EXTRA },
    },
  },
  booking_form_labels: {
    fields: {
      custom_label_note: {},
      custom_label_first_name: {},
      custom_label_last_name: {},
      custom_label_email: {},
      custom_label_phone: {},
    },
  },
  makeup_sessions: {
    types: ["full2"],
    fields: {
      allow_replacements: {},
      allow_replacements_waitlist: {},
      allow_custom_replacements: {},
      auto_approve_custom_replacements: {},
      allow_replacement_cancellation: {},
      allow_reschedule_of_replacements: {},
      allow_using_replacement_credits_as_discount: {},
      allow_replacements_from_other_companies: {},
      replacements_limit: {},
      replacements_limit_per_events: {},
      flexible_replacements_limit: {},
      replacement_time_limit: {},
      replacement_time_limit_type: { enum: REPLACEMENT_TIME_LIMIT_TYPES },
    },
  },
  trial: {
    types: ["full2"],
    fields: {
      trial_type: { enum: TRIAL_TYPES },
      trial_events_limit_type: { enum: TRIAL_EVENTS_LIMIT_TYPES },
      trial_events_limit: {},
      trial_events_capacity: { enum: TRIAL_EVENTS_CAPACITIES },
      trial_length: {},
      trial_length_type: { enum: TRIAL_LENGTH_TYPES },
      unit_price_trial: {},
      reserve_seat_for_trial_attendees: {},
      automatically_add_schedules_to_trial: {},
    },
  },
  auto_enrolment: {
    types: ["full2"],
    fields: {
      retention_type: { enum: RETENTION_TYPES },
      retention_days: {},
      retention_notify_days_before: {},
      retention_message: {},
    },
  },
  attendance: {
    fields: {
      track_attendance: { types: ["full2"] },
      allow_rescheduling_of_events: { types: ["full2"] },
      auto_approve_rescheduled_events: { types: ["full2"] },
      limit_reschedule_to_once: { types: ["full2"] },
      auto_waitlist_notification: { types: ["single"] },
      require_valid_entrance_voucher: { types: ["open"] },
    },
  },
  feedback: {
    fields: {
      feedback_during_course: {},
      feedback_after_course: {},
      collect_feedback_start: {},
      reviews_after_registration: {},
      reviews_after_first_session: {},
      reviews_after_class_ended: {},
      collect_reviews_start: {},
    },
  },
};

/** True when the whole section applies to the given programme type. */
export function sectionAvailable(section: SectionName, rt: RegistrationType): boolean {
  const gate = SECTIONS[section].types;
  return !gate || gate.includes(rt);
}

/** Sections a programme of this type can edit — feeds the section-gate error's "Available sections" list. */
export function availableSections(rt: RegistrationType): SectionName[] {
  return SECTION_NAMES.filter((s) => sectionAvailable(s, rt));
}

/** Allowed `changes` keys for this section AND programme type — feeds the unknown-field error's "Allowed fields" list. */
export function allowedFields(section: SectionName, rt: RegistrationType): string[] {
  return Object.entries(SECTIONS[section].fields)
    .filter(([, rule]) => (!rule.types || rule.types.includes(rt)) && (!rule.full2Only || rt === "full2"))
    .map(([field]) => field);
}

/**
 * Own-property field lookup. `changes` keys are client-controlled JSON, so a
 * plain `fields[field]` read would resolve Object.prototype keys
 * ("constructor", "toString", "__proto__") to inherited values and let them
 * bypass the whitelist — and later flow into put_body as a prototype-pollution
 * hazard. Guarding with Object.hasOwn keeps the whitelist exact.
 */
function fieldRule(fields: Record<string, FieldRule>, field: string): FieldRule | undefined {
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}

/** True for spec-‡ virtual inputs (allow_multiple_registrations) — prepare translates, never sends upstream. */
export function isVirtualField(section: SectionName, field: string): boolean {
  return fieldRule(SECTIONS[section].fields, field)?.virtual === true;
}

/**
 * First whitelist/gate/enum violation in the spec's validation order
 * (section gate → field whitelist → enum values), or null when the changes
 * are structurally valid. Cross-field checks (slots, virtual-field
 * translation) and message rendering live in the prepare tool.
 */
export type ChangesViolation =
  | { kind: "section_gated"; section: SectionName }
  /** † field for a non-full2 programme — prepare renders this with the section-gate error message. */
  | { kind: "field_gated"; section: SectionName; field: string }
  | { kind: "unknown_field"; section: SectionName; field: string; allowed_fields: string[] }
  | { kind: "invalid_enum"; field: string; value: unknown; allowed_values: readonly string[] };

export function firstViolation(
  section: SectionName,
  rt: RegistrationType,
  changes: Record<string, unknown>,
): ChangesViolation | null {
  if (!sectionAvailable(section, rt)) return { kind: "section_gated", section };

  const rules = SECTIONS[section].fields;
  for (const field of Object.keys(changes)) {
    const rule = fieldRule(rules, field);
    // Per-type variant mismatch (attendance) = the field isn't in the section
    // for this programme — same violation as a completely unknown key.
    if (!rule || (rule.types && !rule.types.includes(rt))) {
      return { kind: "unknown_field", section, field, allowed_fields: allowedFields(section, rt) };
    }
    if (rule.full2Only && rt !== "full2") {
      return { kind: "field_gated", section, field };
    }
  }
  for (const [field, value] of Object.entries(changes)) {
    const allowed = fieldRule(rules, field)?.enum;
    if (allowed && !(typeof value === "string" && allowed.includes(value))) {
      return { kind: "invalid_enum", field, value, allowed_values: allowed };
    }
  }
  return null;
}
