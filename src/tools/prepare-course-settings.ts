import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import {
  availableSections,
  type ChangesViolation,
  firstViolation,
  isVirtualField,
  type RegistrationType,
  SECTION_NAMES,
  type SectionName,
} from "./course-settings-model.js";
import { savePlan, type SettingsDiffEntry } from "./course-settings-plan-store.js";
import type { ApiListResponse, CourseSettingsRecord, RawCourseRecord } from "./types.js";

export const prepareCourseSettingsInputSchema = {
  company_id: companyIdSchema,
  course_id: z
    .number()
    .int()
    .positive()
    .describe("Programme (course) id. Resolve names with classes_find_courses first — never guess ids."),
  section: z
    .enum(SECTION_NAMES)
    .describe(
      "Which settings tile to change — one section per call, mirroring the Zooza app's settings dashboard. " +
        "'trial', 'makeup_sessions', and 'auto_enrolment' only exist for 'booking for full programme duration' " +
        "(full2) programmes.",
    ),
  changes: z
    .record(z.unknown())
    .describe(
      "Field → new value, keys limited to the chosen section's whitelist (an invalid field returns the allowed " +
        'list). Booleans as true/false, enums as their string value. Example: {"online_registration": false}.',
    ),
};

const inputSchema = z.object(prepareCourseSettingsInputSchema);

export async function runPrepareCourseSettings(
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

  let course: CourseSettingsRecord;
  try {
    course = await fetchCourse(input.course_id, callAuth);
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status === 404) {
      return errorResult(
        `Programme ${input.course_id} not found for this company. Use classes_find_courses to resolve the programme by name first.`,
      );
    }
    return errorResult(
      error instanceof ZoozaApiError
        ? `Could not load programme ${input.course_id} (api-v1 ${error.status}: ${error.humanMessage}).`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  const build = buildSettingsPlan(course, input.section, input.changes);
  if (!build.ok) return errorResult(build.error);

  // Rename → duplicate-name check. Warning-only lookup: a failure must never
  // block the rename (spec composition step 4), so errors degrade silently.
  const rename = build.diff.find((d) => d.field === "name");
  if (rename && typeof rename.proposed === "string") {
    try {
      const raw = await zoozaFetch<ApiListResponse<RawCourseRecord> | RawCourseRecord[]>(
        "/courses",
        { query: { name: rename.proposed, filter: "filter" } },
        callAuth,
      );
      const { records } = unwrapList<RawCourseRecord>(raw);
      const warning = duplicateNameWarning(records, rename.proposed, course.id);
      if (warning) build.warnings.push(warning);
    } catch {
      // Non-blocking by design.
    }
  }

  const { token, expires_in_seconds } = savePlan({
    company_id: input.company_id!,
    course_id: course.id,
    section: input.section,
    put_body: build.put_body,
    diff: build.diff,
    warnings: build.warnings,
  });

  const result = {
    token,
    expires_in_seconds,
    course: {
      id: course.id,
      name: course.name,
      registration_type: course.registration_type ?? "",
      archive: toBool(course.archive),
    },
    section: input.section,
    diff: build.diff,
    warnings: build.warnings,
    next_step:
      "Show this diff to the user. After they confirm, call classes_update_course_settings again with `token` and " +
      "`confirmed: true` — and nothing else. To change anything instead, call it again WITHOUT a token.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

async function fetchCourse(id: number, auth: ZoozaAuth): Promise<CourseSettingsRecord> {
  const raw = await zoozaFetch<{ data?: CourseSettingsRecord } | CourseSettingsRecord>(
    `/courses/${id}`,
    {},
    auth,
  );
  const course = (raw as { data?: CourseSettingsRecord })?.data ?? (raw as CourseSettingsRecord);
  if (!course || !course.id) {
    throw new ZoozaApiError(404, `/courses/${id}`, "Course not found");
  }
  return course;
}

// ─── Pure plan builder (exported for unit tests) ─────────────────────────────

export type SettingsPlanBuild =
  | { ok: true; diff: SettingsDiffEntry[]; put_body: Record<string, unknown>; warnings: string[] }
  | { ok: false; error: string };

/**
 * The local half of prepare: validation (section gate → field whitelist →
 * enum values → cross-field), virtual-field translation, diff, guard echoes,
 * and the warning catalog. Everything except the two fetches, so the whole
 * decision surface is unit-testable against a plain course record.
 */
export function buildSettingsPlan(
  course: CourseSettingsRecord,
  section: SectionName,
  changes: Record<string, unknown>,
): SettingsPlanBuild {
  const rt = (course.registration_type ?? "") as RegistrationType;

  const violation = firstViolation(section, rt, changes);
  if (violation) return { ok: false, error: renderViolation(violation, course, rt) };

  const translated = translateVirtualFields(section, changes);
  if (!translated.ok) return translated;
  const effective = translated.changes;

  const slotsError = slotsViolation(course, effective);
  if (slotsError) return { ok: false, error: slotsError };

  const diff: SettingsDiffEntry[] = [];
  for (const [field, proposed] of Object.entries(effective)) {
    const current = Object.hasOwn(course, field) ? course[field] : null;
    if (!valuesEqual(current, proposed)) {
      diff.push({ field, label: fieldLabel(field), current: current ?? null, proposed });
    }
  }
  if (diff.length === 0) {
    return {
      ok: false,
      error: "All proposed values already match the current settings — nothing to change.",
    };
  }

  return {
    ok: true,
    diff,
    put_body: buildPutBody(diff, course),
    warnings: buildWarnings(course, rt, diff),
  };
}

const REGISTRATION_TYPE_LABELS: Record<string, string> = {
  single: "drop-in / per-session booking",
  full2: "booking for full programme duration",
  open: "pay-as-you-go / open-ended",
};

function typeLabel(rt: string): string {
  return Object.hasOwn(REGISTRATION_TYPE_LABELS, rt) ? REGISTRATION_TYPE_LABELS[rt] : rt;
}

function renderViolation(
  v: ChangesViolation,
  course: CourseSettingsRecord,
  rt: RegistrationType,
): string {
  const gateTail =
    `'${course.name}' is a ${typeLabel(rt)} programme (${course.registration_type}). ` +
    `Available sections for it: ${availableSections(rt).join(", ")}.`;
  switch (v.kind) {
    case "section_gated":
      return `Section '${v.section}' only applies to 'booking for full programme duration' programmes. ${gateTail}`;
    case "field_gated":
      // Spec footnote †: a full2-only field inside an ungated section rejects
      // with the section-gate error, scoped to the field so the message stays true.
      return `Field '${v.field}' only applies to 'booking for full programme duration' programmes. ${gateTail}`;
    case "unknown_field":
      return (
        `Field '${v.field}' is not part of section '${v.section}'. Allowed fields: ${v.allowed_fields.join(", ")}. ` +
        "If you need payment methods (cash/card/transfer), that is not yet supported via MCP."
      );
    case "invalid_enum":
      return `Invalid value ${JSON.stringify(v.value)} for field '${v.field}'. Allowed values: ${v.allowed_values.join(", ")}.`;
  }
}

type TranslateResult =
  | { ok: true; changes: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Spec ‡: allow_multiple_registrations is app-side only — not a courses column,
 * silently dropped by api-v1. false → force both slots to 1 (app parity,
 * course_settings.js:237-241 — overrides explicit slot values in the same call);
 * true → the caller must spell out both slot values, because they ARE the
 * setting. The virtual key itself never reaches put_body.
 */
function translateVirtualFields(
  section: SectionName,
  changes: Record<string, unknown>,
): TranslateResult {
  const out: Record<string, unknown> = {};
  let forceSingleSlot = false;
  for (const [field, value] of Object.entries(changes)) {
    if (!isVirtualField(section, field)) {
      out[field] = value;
      continue;
    }
    if (value === false) {
      forceSingleSlot = true;
    } else if (value === true) {
      if (
        !Object.hasOwn(changes, "registration_slots_min") ||
        !Object.hasOwn(changes, "registration_slots_max")
      ) {
        return {
          ok: false,
          error:
            "allow_multiple_registrations: true requires explicit registration_slots_min and " +
            "registration_slots_max in the same changes — Zooza stores this toggle as the two slot values " +
            "(e.g. min 1, max 3 lets one booking cover up to 3 people). Add both and prepare again.",
        };
      }
      // The explicit slot values carry the whole meaning — drop the virtual key.
    } else {
      return {
        ok: false,
        error:
          "allow_multiple_registrations must be true or false — it is a virtual toggle Zooza stores as " +
          "registration_slots_min/registration_slots_max.",
      };
    }
  }
  if (forceSingleSlot) {
    out.registration_slots_min = 1;
    out.registration_slots_max = 1;
  }
  return { ok: true, changes: out };
}

/**
 * Partial-aware mirror of api-v1's slots guard (ZOOZA-4825, Course.php:637-663):
 * the check runs against current values merged with the proposed ones, so a
 * lone `registration_slots_min: 3` against a current max of 1 fails at prepare
 * instead of bouncing the whole PUT at commit.
 */
function slotsViolation(
  course: CourseSettingsRecord,
  effective: Record<string, unknown>,
): string | null {
  if (
    !Object.hasOwn(effective, "registration_slots_min") &&
    !Object.hasOwn(effective, "registration_slots_max")
  ) {
    return null;
  }
  const min = mergedNumber(effective, course, "registration_slots_min");
  const max = mergedNumber(effective, course, "registration_slots_max");
  if (min === undefined || max === undefined) return null; // nothing to compare against — api-v1 decides
  if (max < min) {
    return `registration_slots_max (${max}) must be ≥ registration_slots_min (${min}) — api-v1 rejects the whole update otherwise.`;
  }
  return null;
}

function mergedNumber(
  effective: Record<string, unknown>,
  course: CourseSettingsRecord,
  field: string,
): number | undefined {
  const v = Object.hasOwn(effective, field)
    ? effective[field]
    : Object.hasOwn(course, field)
      ? course[field]
      : undefined;
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function buildPutBody(
  diff: SettingsDiffEntry[],
  course: CourseSettingsRecord,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  // Guard echo 1 (EVERY commit): api-v1 deletes ALL feedback_questions rows when
  // a course PUT omits these two flags (courses.php:398-413, bool_to_int(null) →
  // 0 → delete_questions_from_course). Echo current values; the enable path is
  // idempotent so the echo is safe. Diffed fields overlay the echo below.
  body.feedback_during_course = course.feedback_during_course ?? 0;
  body.feedback_after_course = course.feedback_after_course ?? 0;
  const fields = new Set(diff.map((d) => d.field));
  if (fields.has("price")) {
    // Guard echo 2: Course::update recomputes __calc__fee_* from the posted body
    // and reads null when the flag is absent (Course.php:867-894). The app's
    // price card has this quirk; the MCP shouldn't.
    body.fees_included_in_price = course.fees_included_in_price ?? 0;
  }
  for (const d of diff) body[d.field] = d.proposed;
  return body;
}

// ─── Warning catalog ─────────────────────────────────────────────────────────

function buildWarnings(
  course: CourseSettingsRecord,
  rt: RegistrationType,
  diff: SettingsDiffEntry[],
): string[] {
  const fields = new Set(diff.map((d) => d.field));
  const proposed = new Map(diff.map((d) => [d.field, d.proposed]));
  const warnings: string[] = [];

  if (["price", "unit_price", "registration_fee"].some((f) => fields.has(f))) {
    warnings.push(
      "Price changes never reprice existing bookings — only new bookings use the new price.",
    );
  }
  if (fields.has("price_type") || fields.has("money_collection")) {
    warnings.push(
      "Changing this deletes ALL payment-plan templates attached to the programme and its classes, then " +
        "auto-attaches every company template matching the new setting — possibly ones the operator doesn't want " +
        "here. Review the programme's payment templates after committing. The app asks for explicit confirmation " +
        "here — make sure the user understands before committing.",
    );
  }
  if (fields.has("course_type") || fields.has("target_audience")) {
    // "on a programme with registrations" — the single-record GET does not always
    // materialise __calc__registrations_count, so warn unless the count is known
    // zero: over-warning is the safe side for a migration recommendation.
    const count = course.__calc__registrations_count;
    if (count === undefined || count === null || toInt(count) > 0) {
      warnings.push(
        "Zooza recommends creating a new programme and migrating clients instead of changing the type of a live programme.",
      );
    }
  }
  if (fields.has("track_attendance") && !toBool(proposed.get("track_attendance"))) {
    warnings.push(
      "Disabling attendance removes make-up session availability and cancels session notifications.",
    );
  }
  if (
    fields.has("allow_rescheduling_of_events") &&
    toBool(proposed.get("allow_rescheduling_of_events")) &&
    toBool(course.allow_replacements)
  ) {
    warnings.push(
      "Rescheduling and make-up sessions both on can confuse clients — the app recommends turning make-ups off.",
    );
  }
  if (fields.has("archive") && toBool(proposed.get("archive"))) {
    warnings.push(
      "Archived programmes are hidden from active lists but keep all data and bookings; reversible by setting archive back to false.",
    );
  }
  if (fields.has("hide_if_full") && rt === "open") {
    warnings.push("Pay-as-you-go programmes ignore hide-if-full — api-v1 forces it to 0.");
  }
  if (fields.has("allow_guest_registrations") && toBool(proposed.get("allow_guest_registrations"))) {
    // late_registrations lives in another section, so within one call it can only
    // come from the course row — merged anyway for robustness.
    const late = fields.has("late_registrations")
      ? proposed.get("late_registrations")
      : course.late_registrations;
    if (late === "disabled") {
      warnings.push("Guest bookings with late bookings disabled — the app flags this combination.");
    }
  }
  return warnings;
}

/**
 * Narrows the substring + accent/case-insensitive api name search
 * (utf8mb4_unicode_ci) down to exact-name matches on another programme.
 * Returns the duplicate-name warning text, or null.
 */
export function duplicateNameWarning(
  records: Array<{ id: number; name?: string }>,
  proposedName: string,
  courseId: number,
): string | null {
  const wanted = proposedName.trim().toLowerCase();
  const match = records.find(
    (r) => r.id !== courseId && (r.name ?? "").trim().toLowerCase() === wanted,
  );
  if (!match) return null;
  return `Another programme is already named '${match.name}' (id ${match.id}). Zooza does not enforce unique names — duplicates will be confusing in listings.`;
}

// ─── Value plumbing ──────────────────────────────────────────────────────────

/**
 * api-v1 course rows mix representations — flags as 0/1 or "0"/"1", money as
 * "12.00" strings — while MCP callers send real booleans and numbers. Normalise
 * both sides so the diff only shows real changes (booleans → 1/0, numeric
 * strings → numbers, ""/null → null).
 */
function normalizeValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    if (t === "true") return 1;
    if (t === "false") return 0;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number.parseFloat(t);
    return t;
  }
  return JSON.stringify(v) ?? null;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return normalizeValue(a) === normalizeValue(b);
}

function toBool(v: unknown): boolean {
  const n = normalizeValue(v);
  if (n === null) return false;
  return typeof n === "number" ? n !== 0 : true;
}

function toInt(v: unknown): number {
  const n = normalizeValue(v);
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** App-language labels where the api-v1 field name is misleading ("replacements"
 *  = make-up sessions, "registrations" = bookings); humanised snake_case otherwise. */
const FIELD_LABELS: Record<string, string> = {
  url: "URL",
  archive: "Archived",
  online_registration: "Online booking",
  public: "Publicly listed",
  hide_if_full: "Hide when full",
  hide_before: "Hide before date",
  registration_slots_min: "Booking slots minimum",
  registration_slots_max: "Booking slots maximum",
  get_basic_fields_from: "Collect basic fields from",
  get_extra_fields_from: "Collect extra fields from",
  allow_guest_registrations: "Allow guest bookings",
  late_registrations: "Late bookings policy",
  registration_fee: "Booking fee",
  registration_display_mode: "Booking display mode",
  allow_replacements: "Allow make-up sessions",
  allow_replacements_waitlist: "Make-up sessions can join waitlists",
  allow_custom_replacements: "Allow custom make-up requests",
  auto_approve_custom_replacements: "Auto-approve custom make-up requests",
  allow_replacement_cancellation: "Allow cancelling make-up sessions",
  allow_reschedule_of_replacements: "Allow rescheduling make-up sessions",
  allow_using_replacement_credits_as_discount: "Use make-up credits as discount",
  allow_replacements_from_other_companies: "Accept make-ups from other companies",
  replacements_limit: "Make-up sessions limit",
  replacements_limit_per_events: "Make-up limit per number of sessions",
  flexible_replacements_limit: "Flexible make-up limit",
  replacement_time_limit: "Make-up booking time limit",
  replacement_time_limit_type: "Make-up time limit direction",
  allow_rescheduling_of_events: "Allow clients to reschedule sessions",
  auto_approve_rescheduled_events: "Auto-approve rescheduled sessions",
  unit_price_trial: "Trial unit price",
  feedback_during_course: "Feedback during the programme",
  feedback_after_course: "Feedback after the programme",
};

function fieldLabel(field: string): string {
  if (Object.hasOwn(FIELD_LABELS, field)) return FIELD_LABELS[field];
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
