import { describe, expect, it } from "vitest";
import {
  allowedFields,
  availableSections,
  firstViolation,
  isVirtualField,
  SECTION_NAMES,
  type SectionName,
  SECTIONS,
  sectionAvailable,
} from "./course-settings-model.js";

describe("section model shape", () => {
  it("encodes exactly the nine spec sections", () => {
    expect(SECTION_NAMES).toEqual([
      "basic_info",
      "price_and_payment",
      "online_booking",
      "booking_form_labels",
      "makeup_sessions",
      "trial",
      "auto_enrolment",
      "attendance",
      "feedback",
    ]);
    expect(Object.keys(SECTIONS)).toEqual([...SECTION_NAMES]);
  });

  it("matches the spec's field whitelist table verbatim", () => {
    expect(Object.keys(SECTIONS.basic_info.fields)).toEqual([
      "name", "description", "url", "color", "course_type", "target_audience", "for_children", "archive",
    ]);
    expect(Object.keys(SECTIONS.price_and_payment.fields)).toEqual([
      "price", "unit_price", "registration_fee", "money_collection", "price_type", "billable_events",
      "aliquot_settings", "force_full_first_installment", "late_registrations", "payments_managed_by_buyer",
      "downpayment", "downpayment_value", "downpayment_cap", "downpayment_due_type", "downpayment_due_days",
    ]);
    expect(Object.keys(SECTIONS.online_booking.fields)).toEqual([
      "public", "online_registration", "priority", "registration_display_mode", "allow_guest_registrations",
      "hide_if_full", "hide_before", "allow_multiple_registrations", "registration_slots_min",
      "registration_slots_max", "get_basic_fields_from", "get_extra_fields_from",
    ]);
    expect(Object.keys(SECTIONS.booking_form_labels.fields)).toEqual([
      "custom_label_note", "custom_label_first_name", "custom_label_last_name",
      "custom_label_email", "custom_label_phone",
    ]);
    expect(Object.keys(SECTIONS.makeup_sessions.fields)).toEqual([
      "allow_replacements", "allow_replacements_waitlist", "allow_custom_replacements",
      "auto_approve_custom_replacements", "allow_replacement_cancellation", "allow_reschedule_of_replacements",
      "allow_using_replacement_credits_as_discount", "allow_replacements_from_other_companies",
      "replacements_limit", "replacements_limit_per_events", "flexible_replacements_limit",
      "replacement_time_limit", "replacement_time_limit_type",
    ]);
    expect(Object.keys(SECTIONS.trial.fields)).toEqual([
      "trial_type", "trial_events_limit_type", "trial_events_limit", "trial_events_capacity",
      "trial_length", "trial_length_type", "unit_price_trial", "reserve_seat_for_trial_attendees",
      "automatically_add_schedules_to_trial",
    ]);
    expect(Object.keys(SECTIONS.auto_enrolment.fields)).toEqual([
      "retention_type", "retention_days", "retention_notify_days_before", "retention_message",
    ]);
    expect(Object.keys(SECTIONS.attendance.fields)).toEqual([
      "track_attendance", "allow_rescheduling_of_events", "auto_approve_rescheduled_events",
      "limit_reschedule_to_once", "auto_waitlist_notification", "require_valid_entrance_voucher",
    ]);
    expect(Object.keys(SECTIONS.feedback.fields)).toEqual([
      "feedback_during_course", "feedback_after_course", "collect_feedback_start",
      "reviews_after_registration", "reviews_after_first_session", "reviews_after_class_ended",
      "collect_reviews_start",
    ]);
  });

  it("flags allow_multiple_registrations as virtual and nothing else", () => {
    expect(isVirtualField("online_booking", "allow_multiple_registrations")).toBe(true);
    for (const section of SECTION_NAMES) {
      for (const field of Object.keys(SECTIONS[section].fields)) {
        if (field === "allow_multiple_registrations") continue;
        expect(isVirtualField(section, field), `${section}.${field}`).toBe(false);
      }
    }
  });
});

describe("section gating by programme type", () => {
  it("gates makeup_sessions / trial / auto_enrolment to full2 only", () => {
    for (const section of ["makeup_sessions", "trial", "auto_enrolment"] as const) {
      expect(sectionAvailable(section, "full2")).toBe(true);
      expect(sectionAvailable(section, "single")).toBe(false);
      expect(sectionAvailable(section, "open")).toBe(false);
      expect(firstViolation(section, "single", {})).toEqual({ kind: "section_gated", section });
      expect(firstViolation(section, "open", {})).toEqual({ kind: "section_gated", section });
    }
  });

  it("lists available sections per programme type", () => {
    expect(availableSections("full2")).toEqual([...SECTION_NAMES]);
    const ungated = [
      "basic_info", "price_and_payment", "online_booking",
      "booking_form_labels", "attendance", "feedback",
    ];
    expect(availableSections("single")).toEqual(ungated);
    expect(availableSections("open")).toEqual(ungated);
  });

  it("rejects each full2-only field inside ungated sections for single/open (section-gate error)", () => {
    const daggered: Array<["price_and_payment" | "online_booking", string, unknown]> = [
      ["price_and_payment", "money_collection", "installments"],
      ["price_and_payment", "price_type", "membership"],
      ["price_and_payment", "aliquot_settings", "automatic"],
      ["price_and_payment", "force_full_first_installment", true],
      ["price_and_payment", "late_registrations", "disabled"],
      ["online_booking", "registration_display_mode", "trials_only"],
    ];
    for (const [section, field, value] of daggered) {
      expect(firstViolation(section, "full2", { [field]: value })).toBeNull();
      for (const rt of ["single", "open"] as const) {
        expect(firstViolation(section, rt, { [field]: value })).toEqual({
          kind: "field_gated",
          section,
          field,
        });
      }
    }
  });

  it("scopes attendance fields per programme type", () => {
    expect(firstViolation("attendance", "full2", { track_attendance: false })).toBeNull();
    expect(firstViolation("attendance", "single", { auto_waitlist_notification: true })).toBeNull();
    expect(firstViolation("attendance", "open", { require_valid_entrance_voucher: true })).toBeNull();

    // A field from another type's variant is not part of the section for this programme.
    expect(firstViolation("attendance", "single", { track_attendance: false })).toEqual({
      kind: "unknown_field",
      section: "attendance",
      field: "track_attendance",
      allowed_fields: ["auto_waitlist_notification"],
    });
    expect(firstViolation("attendance", "full2", { require_valid_entrance_voucher: true })).toEqual({
      kind: "unknown_field",
      section: "attendance",
      field: "require_valid_entrance_voucher",
      allowed_fields: [
        "track_attendance", "allow_rescheduling_of_events",
        "auto_approve_rescheduled_events", "limit_reschedule_to_once",
      ],
    });
    expect(allowedFields("attendance", "open")).toEqual(["require_valid_entrance_voucher"]);
  });
});

describe("field whitelist", () => {
  it("rejects unknown fields with the allowed list", () => {
    // cash belongs to the deferred payment_methods section, not price_and_payment.
    const v = firstViolation("price_and_payment", "full2", { cash: true });
    expect(v).toMatchObject({ kind: "unknown_field", section: "price_and_payment", field: "cash" });
    expect(v?.kind === "unknown_field" && v.allowed_fields).toContain("price");
    // code is saved by the app's basic-info card but deliberately out of the v1 whitelist.
    expect(firstViolation("basic_info", "full2", { code: "X1" })).toMatchObject({
      kind: "unknown_field",
      field: "code",
    });
  });

  it("filters † fields out of the allowed list for single/open", () => {
    expect(allowedFields("price_and_payment", "open")).not.toContain("price_type");
    expect(allowedFields("price_and_payment", "full2")).toContain("price_type");
    expect(allowedFields("online_booking", "single")).not.toContain("registration_display_mode");
  });

  it("accepts the virtual allow_multiple_registrations key", () => {
    expect(firstViolation("online_booking", "full2", { allow_multiple_registrations: false })).toBeNull();
  });

  it("rejects Object.prototype keys — inherited lookups must not bypass the whitelist", () => {
    for (const field of ["constructor", "toString", "hasOwnProperty"]) {
      expect(firstViolation("basic_info", "full2", { [field]: 1 })).toMatchObject({
        kind: "unknown_field",
        field,
      });
    }
    // JSON.parse makes __proto__ an own key (a literal would set the prototype instead).
    expect(firstViolation("basic_info", "full2", JSON.parse('{"__proto__": 1}'))).toMatchObject({
      kind: "unknown_field",
      field: "__proto__",
    });
  });
});

describe("enum validation", () => {
  const cases: Array<[SectionName, string, string, readonly string[]]> = [
    ["price_and_payment", "price_type", "monthly", ["course_fee", "membership"]],
    ["price_and_payment", "money_collection", "weekly", ["one_off", "installments"]],
    ["price_and_payment", "late_registrations", "sometimes", ["disabled", "confirmation_required", "auto_approve"]],
    ["price_and_payment", "aliquot_settings", "manual", ["automatic", "automatic_days", "no_value", "full_price"]],
    ["price_and_payment", "downpayment", "percent", ["none", "absolute", "relative"]],
    ["price_and_payment", "downpayment_due_type", "on_start", ["before_course", "after_registration"]],
    ["online_booking", "registration_display_mode", "hidden", ["default", "full_course_only", "trials_only", "segments_only", "trials_and_segments_only"]],
    ["online_booking", "get_basic_fields_from", "buyer", ["all", "registrant"]],
    ["online_booking", "get_extra_fields_from", "registrant", ["all", "other"]],
    ["trial", "trial_type", "trial", ["none", "free_trial", "free_time_trial", "paid_trial", "paid_time_trial", "lead_collection"]],
    ["trial", "trial_events_limit_type", "weeks", ["none", "date", "count"]],
    ["trial", "trial_events_capacity", "none", ["all", "extra_capacity"]],
    ["trial", "trial_length_type", "months", ["days", "events"]],
    ["auto_enrolment", "retention_type", "auto", ["none", "suggest_schedules", "duplicate_schedule"]],
    ["makeup_sessions", "replacement_time_limit_type", "during", ["before", "after"]],
    ["basic_info", "course_type", "workshop", ["course", "event", "online_event", "photography"]],
    ["basic_info", "target_audience", "kids", ["groups", "individuals"]],
  ];

  it.each(cases)("rejects %s.%s = %j", (section, field, bad, allowed) => {
    expect(firstViolation(section, "full2", { [field]: bad })).toEqual({
      kind: "invalid_enum",
      field,
      value: bad,
      allowed_values: allowed,
    });
    // First allowed value passes.
    expect(firstViolation(section, "full2", { [field]: allowed[0] })).toBeNull();
  });

  it("rejects non-string values for enum fields", () => {
    expect(firstViolation("price_and_payment", "full2", { price_type: 2 })).toMatchObject({
      kind: "invalid_enum",
      field: "price_type",
    });
  });
});

describe("validation order (spec: section gate → field whitelist → enum values)", () => {
  it("section gate wins over field problems", () => {
    expect(firstViolation("trial", "open", { trial_type: "not_a_type", bogus: 1 })).toEqual({
      kind: "section_gated",
      section: "trial",
    });
  });

  it("field whitelist wins over enum problems", () => {
    expect(
      firstViolation("price_and_payment", "full2", { price_type: "monthly", bogus: 1 }),
    ).toMatchObject({ kind: "unknown_field", field: "bogus" });
  });

  it("returns null for a fully valid change set", () => {
    expect(
      firstViolation("price_and_payment", "full2", {
        unit_price: 12,
        price_type: "membership",
        late_registrations: "auto_approve",
      }),
    ).toBeNull();
  });
});
