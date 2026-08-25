import { describe, expect, it } from "vitest";
import {
  buildSettingsPlan,
  duplicateNameWarning,
  valuesEqual,
} from "./prepare-course-settings.js";
import type { CourseSettingsRecord } from "./types.js";

/** Baseline full2 programme with api-v1's mixed value representations
 *  (flags as 0/1, money as decimal strings) so the diff normalisation is
 *  exercised by every test that uses it. */
function course(overrides: Partial<CourseSettingsRecord> = {}): CourseSettingsRecord {
  return {
    id: 1019,
    name: "Ballet Beginners",
    registration_type: "full2",
    archive: 0,
    course_type: "course",
    target_audience: "groups",
    price: "120.00",
    unit_price: "12.00",
    registration_fee: "0.00",
    price_type: "course_fee",
    money_collection: "one_off",
    late_registrations: "auto_approve",
    fees_included_in_price: 1,
    public: 1,
    online_registration: 1,
    hide_if_full: 0,
    allow_guest_registrations: 0,
    registration_slots_min: "1",
    registration_slots_max: "1",
    allow_replacements: 0,
    track_attendance: 1,
    feedback_during_course: 1,
    feedback_after_course: 0,
    __calc__registrations_count: 0,
    ...overrides,
  };
}

function expectError(build: ReturnType<typeof buildSettingsPlan>): string {
  if (build.ok) throw new Error("expected an abort, got a plan");
  return build.error;
}

function expectPlan(build: ReturnType<typeof buildSettingsPlan>) {
  if (!build.ok) throw new Error(`expected a plan, got abort: ${build.error}`);
  return build;
}

describe("validation aborts (error catalog)", () => {
  it("renders the section-gate message with label and available-sections list", () => {
    const c = course({ name: "Drop-in Salsa", registration_type: "single" });
    expect(expectError(buildSettingsPlan(c, "trial", { trial_type: "free_trial" }))).toBe(
      "Section 'trial' only applies to 'booking for full programme duration' programmes. " +
        "'Drop-in Salsa' is a drop-in / per-session booking programme (single). " +
        "Available sections for it: basic_info, price_and_payment, online_booking, booking_form_labels, attendance, feedback.",
    );
  });

  it("renders the † field-gate with the section-gate error (spec footnote)", () => {
    const c = course({ name: "Open Gym", registration_type: "open" });
    expect(
      expectError(buildSettingsPlan(c, "price_and_payment", { price_type: "membership" })),
    ).toBe(
      "Field 'price_type' only applies to 'booking for full programme duration' programmes. " +
        "'Open Gym' is a pay-as-you-go / open-ended programme (open). " +
        "Available sections for it: basic_info, price_and_payment, online_booking, booking_form_labels, attendance, feedback.",
    );
  });

  it("renders the unknown-field message with the allowed list and the payment-methods boundary", () => {
    const error = expectError(buildSettingsPlan(course(), "price_and_payment", { cash: true }));
    expect(error).toBe(
      "Field 'cash' is not part of section 'price_and_payment'. Allowed fields: price, unit_price, " +
        "registration_fee, money_collection, price_type, billable_events, aliquot_settings, " +
        "force_full_first_installment, late_registrations, payments_managed_by_buyer, downpayment, " +
        "downpayment_value, downpayment_cap, downpayment_due_type, downpayment_due_days. " +
        "If you need payment methods (cash/card/transfer), that is not yet supported via MCP.",
    );
  });

  it("renders a teaching error for invalid enum values", () => {
    expect(
      expectError(buildSettingsPlan(course(), "price_and_payment", { price_type: "monthly" })),
    ).toBe("Invalid value \"monthly\" for field 'price_type'. Allowed values: course_fee, membership.");
  });

  it("rejects slots inconsistency partial-aware — lone max against current min", () => {
    const c = course({ registration_slots_min: "2", registration_slots_max: "5" });
    expect(
      expectError(buildSettingsPlan(c, "online_booking", { registration_slots_max: 1 })),
    ).toBe(
      "registration_slots_max (1) must be ≥ registration_slots_min (2) — api-v1 rejects the whole update otherwise.",
    );
  });

  it("rejects slots inconsistency partial-aware — lone min against current max", () => {
    const c = course({ registration_slots_min: "1", registration_slots_max: "3" });
    expect(
      expectError(buildSettingsPlan(c, "online_booking", { registration_slots_min: 9 })),
    ).toBe(
      "registration_slots_max (3) must be ≥ registration_slots_min (9) — api-v1 rejects the whole update otherwise.",
    );
  });

  it("accepts a consistent slot pair changed together", () => {
    const c = course({ registration_slots_min: "1", registration_slots_max: "1" });
    const plan = expectPlan(
      buildSettingsPlan(c, "online_booking", {
        registration_slots_min: 1,
        registration_slots_max: 3,
      }),
    );
    expect(plan.put_body.registration_slots_max).toBe(3);
  });

  it("aborts on an empty diff with the exact catalog message", () => {
    // Values match after normalisation: 12 == "12.00", true == 1.
    expect(
      expectError(
        buildSettingsPlan(course(), "price_and_payment", { unit_price: 12 }),
      ),
    ).toBe("All proposed values already match the current settings — nothing to change.");
    expect(
      expectError(buildSettingsPlan(course(), "online_booking", { online_registration: true })),
    ).toBe("All proposed values already match the current settings — nothing to change.");
    expect(expectError(buildSettingsPlan(course(), "basic_info", {}))).toBe(
      "All proposed values already match the current settings — nothing to change.",
    );
  });
});

describe("virtual allow_multiple_registrations", () => {
  it("false → forces both slots to 1, overriding explicit slot values (app parity)", () => {
    const c = course({ registration_slots_min: "1", registration_slots_max: "4" });
    const plan = expectPlan(
      buildSettingsPlan(c, "online_booking", {
        allow_multiple_registrations: false,
        registration_slots_max: 6, // app force-sets to 1 when unchecked — explicit value loses
      }),
    );
    expect(plan.put_body.registration_slots_max).toBe(1);
    expect(plan.put_body).not.toHaveProperty("allow_multiple_registrations");
    expect(plan.diff.map((d) => d.field)).toEqual(["registration_slots_max"]);
  });

  it("true with both explicit slot values → slots pass through, virtual key dropped", () => {
    const plan = expectPlan(
      buildSettingsPlan(course(), "online_booking", {
        allow_multiple_registrations: true,
        registration_slots_min: 1,
        registration_slots_max: 3,
      }),
    );
    expect(plan.put_body.registration_slots_max).toBe(3);
    expect(plan.put_body).not.toHaveProperty("allow_multiple_registrations");
    expect(plan.diff.map((d) => d.field)).toEqual(["registration_slots_max"]);
  });

  it("true without both explicit slot values → teaching abort", () => {
    const expected =
      "allow_multiple_registrations: true requires explicit registration_slots_min and " +
      "registration_slots_max in the same changes — Zooza stores this toggle as the two slot values " +
      "(e.g. min 1, max 3 lets one booking cover up to 3 people). Add both and prepare again.";
    expect(
      expectError(buildSettingsPlan(course(), "online_booking", { allow_multiple_registrations: true })),
    ).toBe(expected);
    expect(
      expectError(
        buildSettingsPlan(course(), "online_booking", {
          allow_multiple_registrations: true,
          registration_slots_max: 3,
        }),
      ),
    ).toBe(expected);
  });

  it("non-boolean value → teaching abort", () => {
    expect(
      expectError(
        buildSettingsPlan(course(), "online_booking", { allow_multiple_registrations: "yes" }),
      ),
    ).toBe(
      "allow_multiple_registrations must be true or false — it is a virtual toggle Zooza stores as " +
        "registration_slots_min/registration_slots_max.",
    );
  });
});

describe("diff", () => {
  it("contains only fields whose value actually changes", () => {
    const plan = expectPlan(
      buildSettingsPlan(course(), "price_and_payment", {
        unit_price: 12, // equals current "12.00" — dropped
        price: 150, // real change
      }),
    );
    expect(plan.diff).toEqual([
      { field: "price", label: "Price", current: "120.00", proposed: 150 },
    ]);
  });

  it("archives via basic_info and shows the boolean flip", () => {
    const plan = expectPlan(buildSettingsPlan(course(), "basic_info", { archive: true }));
    expect(plan.diff).toEqual([
      { field: "archive", label: "Archived", current: 0, proposed: true },
    ]);
    expect(plan.put_body.archive).toBe(true);
  });

  it("unarchives via basic_info with no archive warning", () => {
    const plan = expectPlan(
      buildSettingsPlan(course({ archive: 1 }), "basic_info", { archive: false }),
    );
    expect(plan.put_body.archive).toBe(false);
    expect(plan.warnings).toEqual([]);
  });
});

describe("put_body guard echoes", () => {
  it("always echoes current feedback flags (feedback-wipe trap)", () => {
    const plan = expectPlan(buildSettingsPlan(course(), "basic_info", { name: "New Name" }));
    expect(plan.put_body).toEqual({
      feedback_during_course: 1,
      feedback_after_course: 0,
      name: "New Name",
    });
  });

  it("echoes current fees_included_in_price when price is in the body — and only then", () => {
    const withPrice = expectPlan(
      buildSettingsPlan(course(), "price_and_payment", { price: 150 }),
    );
    expect(withPrice.put_body.fees_included_in_price).toBe(1);

    const withoutPrice = expectPlan(
      buildSettingsPlan(course(), "price_and_payment", { unit_price: 15 }),
    );
    expect(withoutPrice.put_body).not.toHaveProperty("fees_included_in_price");
  });

  it("lets a diffed feedback flag override its own echo", () => {
    const plan = expectPlan(
      buildSettingsPlan(course(), "feedback", { feedback_after_course: true }),
    );
    expect(plan.put_body.feedback_after_course).toBe(true);
    expect(plan.put_body.feedback_during_course).toBe(1); // untouched flag still echoed
  });
});

describe("warning catalog", () => {
  it("warns on price / unit_price / registration_fee changes (never reprices)", () => {
    const expected =
      "Price changes never reprice existing bookings — only new bookings use the new price.";
    for (const changes of [{ price: 150 }, { unit_price: 15 }, { registration_fee: 5 }]) {
      const plan = expectPlan(buildSettingsPlan(course(), "price_and_payment", changes));
      expect(plan.warnings).toContain(expected);
    }
  });

  it("warns loudly on price_type / money_collection (template delete + auto-attach)", () => {
    const expected =
      "Changing this deletes ALL payment-plan templates attached to the programme and its classes, then " +
      "auto-attaches every company template matching the new setting — possibly ones the operator doesn't want " +
      "here. Review the programme's payment templates after committing. The app asks for explicit confirmation " +
      "here — make sure the user understands before committing.";
    for (const changes of [{ price_type: "membership" }, { money_collection: "installments" }]) {
      const plan = expectPlan(buildSettingsPlan(course(), "price_and_payment", changes));
      expect(plan.warnings).toContain(expected);
    }
  });

  it("warns on course_type / target_audience change when the programme has registrations", () => {
    const expected =
      "Zooza recommends creating a new programme and migrating clients instead of changing the type of a live programme.";
    const live = course({ __calc__registrations_count: 7 });
    expect(
      expectPlan(buildSettingsPlan(live, "basic_info", { course_type: "event" })).warnings,
    ).toContain(expected);
    expect(
      expectPlan(buildSettingsPlan(live, "basic_info", { target_audience: "individuals" })).warnings,
    ).toContain(expected);
    // Known-zero registrations → no warning.
    expect(
      expectPlan(buildSettingsPlan(course(), "basic_info", { course_type: "event" })).warnings,
    ).toEqual([]);
    // Count not materialised on the detail path → warn anyway (safe side).
    const unknown = course();
    delete unknown.__calc__registrations_count;
    expect(
      expectPlan(buildSettingsPlan(unknown, "basic_info", { course_type: "event" })).warnings,
    ).toContain(expected);
  });

  it("warns when attendance tracking is turned off", () => {
    const plan = expectPlan(
      buildSettingsPlan(course(), "attendance", { track_attendance: false }),
    );
    expect(plan.warnings).toEqual([
      "Disabling attendance removes make-up session availability and cancels session notifications.",
    ]);
  });

  it("warns on rescheduling on while make-ups enabled — and only then", () => {
    const expected =
      "Rescheduling and make-up sessions both on can confuse clients — the app recommends turning make-ups off.";
    const withMakeups = course({ allow_replacements: 1 });
    expect(
      expectPlan(buildSettingsPlan(withMakeups, "attendance", { allow_rescheduling_of_events: true }))
        .warnings,
    ).toContain(expected);
    expect(
      expectPlan(buildSettingsPlan(course(), "attendance", { allow_rescheduling_of_events: true }))
        .warnings,
    ).toEqual([]);
  });

  it("warns on archive: true", () => {
    const plan = expectPlan(buildSettingsPlan(course(), "basic_info", { archive: true }));
    expect(plan.warnings).toEqual([
      "Archived programmes are hidden from active lists but keep all data and bookings; reversible by setting archive back to false.",
    ]);
  });

  it("warns on hide_if_full for open programmes only", () => {
    const open = course({ registration_type: "open" });
    expect(
      expectPlan(buildSettingsPlan(open, "online_booking", { hide_if_full: true })).warnings,
    ).toContain("Pay-as-you-go programmes ignore hide-if-full — api-v1 forces it to 0.");
    expect(
      expectPlan(buildSettingsPlan(course(), "online_booking", { hide_if_full: true })).warnings,
    ).toEqual([]);
  });

  it("warns on guest bookings while late bookings are disabled — and only then", () => {
    const lateDisabled = course({ late_registrations: "disabled" });
    expect(
      expectPlan(
        buildSettingsPlan(lateDisabled, "online_booking", { allow_guest_registrations: true }),
      ).warnings,
    ).toEqual(["Guest bookings with late bookings disabled — the app flags this combination."]);
    expect(
      expectPlan(buildSettingsPlan(course(), "online_booking", { allow_guest_registrations: true }))
        .warnings,
    ).toEqual([]);
  });
});

describe("duplicateNameWarning", () => {
  const records = [
    { id: 1019, name: "Ballet Beginners" },
    { id: 412, name: "Autumn Yoga" },
    { id: 511, name: "Autumn Yoga Advanced" }, // substring hit from the api, not an exact duplicate
  ];

  it("flags an exact-name match on another programme with the catalog text", () => {
    expect(duplicateNameWarning(records, "autumn yoga", 1019)).toBe(
      "Another programme is already named 'Autumn Yoga' (id 412). Zooza does not enforce unique names — duplicates will be confusing in listings.",
    );
  });

  it("ignores the programme being renamed and substring-only matches", () => {
    expect(duplicateNameWarning(records, "Ballet Beginners", 1019)).toBeNull();
    expect(duplicateNameWarning(records, "Autumn", 1019)).toBeNull();
    expect(duplicateNameWarning([], "Anything", 1019)).toBeNull();
  });
});

describe("valuesEqual normalisation", () => {
  it("matches api string representations against MCP-native values", () => {
    expect(valuesEqual("12.00", 12)).toBe(true);
    expect(valuesEqual(1, true)).toBe(true);
    expect(valuesEqual("0", false)).toBe(true);
    expect(valuesEqual("", null)).toBe(true);
    expect(valuesEqual("membership", "membership")).toBe(true);
    expect(valuesEqual("12.00", 13)).toBe(false);
    expect(valuesEqual(0, true)).toBe(false);
  });
});
