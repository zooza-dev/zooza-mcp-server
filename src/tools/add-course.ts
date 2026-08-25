import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type { AddCourseResult, ApiListResponse, RawCourseRecord } from "./types.js";

const PROGRAMME_KINDS = ["one_off_event", "full_duration", "pay_as_you_go"] as const;
type ProgrammeKind = (typeof PROGRAMME_KINDS)[number];

const AUDIENCES = ["groups", "individuals"] as const;
const PAYMENT_COLLECTIONS = ["one_off", "installments"] as const;
const PRICE_TYPES = ["course_fee", "membership"] as const;

const REGISTRATION_TYPE_BY_KIND: Record<ProgrammeKind, string> = {
  one_off_event: "single",
  full_duration: "full2",
  pay_as_you_go: "open",
};

// Reverse lookup for the duplicate-name error — labels the found programme's
// kind back in the user-facing vocabulary this tool speaks.
const KIND_BY_REGISTRATION_TYPE: Record<string, string> = {
  single: "one_off_event",
  full2: "full_duration",
  open: "pay_as_you_go",
};

export const addCourseTitle = "Create a new programme (course)";

export const addCourseDescription =
  "Create a new programme (course) — the top-level container in Zooza that holds pricing, payment settings, and " +
  "booking-form configuration. Classes and sessions are added inside it afterwards; a programme cannot accept " +
  "bookings until it has at least one class. IMPORTANT routing rule: only create a programme for a genuinely NEW " +
  "product or offering. If the user is re-running an existing programme — new term, new time slot, new venue, new " +
  "instructor — do NOT create a programme; create a class inside the existing programme instead " +
  "(classes_preview_schedule → classes_commit_class; the class inherits all programme settings). This tool asks " +
  "only the essentials; Zooza defaults everything else, and settings can be changed later with " +
  "classes_update_course_settings. The new programme is created public with online booking enabled. Summarise " +
  "name, kind, and price to the user and get their OK before calling.";

export const addCourseInputSchema = {
  company_id: companyIdSchema,
  name: z.string().min(1).describe("Programme name as clients will see it. Required, non-empty."),
  programme_kind: z
    .enum(PROGRAMME_KINDS)
    .optional()
    .describe(
      "Default 'full_duration'. 'one_off_event' = single occurrence — lecture, workshop, open day. " +
        "'full_duration' = clients book all sessions for the whole period (terms). 'pay_as_you_go' = enrol once, " +
        "book sessions individually (drop-in).",
    ),
  audience: z
    .enum(AUDIENCES)
    .optional()
    .describe(
      "Default 'groups'. 'individuals' = 1-to-1 programme. Capacity is a class-level concern; nothing is " +
        "auto-set to 1 here.",
    ),
  for_children: z
    .boolean()
    .optional()
    .describe(
      "Default false (deliberate deviation from the app's default of true). true adds a child profile to the " +
        "booking form (auto-activates date-of-birth + child-name fields). Ask the user when the vertical suggests " +
        "kids (baby swim, kids dance, …).",
    ),
  payment_collection: z
    .enum(PAYMENT_COLLECTIONS)
    .optional()
    .describe("full_duration only. Default 'one_off'."),
  price_type: z
    .enum(PRICE_TYPES)
    .optional()
    .describe("full_duration + installments only. Default 'course_fee'."),
  total_price: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "The whole price the client pays for the run — what operators normally quote (\"300 for the term\"). " +
        "REQUIRED for one_off_event and for full_duration with one_off collection, and the RECOMMENDED input for " +
        "full_duration with installments too. For instalments Zooza charges per session, so this total is stored " +
        "on the programme and classes_commit_class divides it by the sessions you create — you do NOT need to " +
        "know the session count now. Never send both this and unit_price.",
    ),
  unit_price: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Price PER SESSION. Only use this when the operator quoted a per-session figure — for a price covering the " +
        "whole run use total_price instead, which works for instalment programmes too and is the usual case. " +
        "REQUIRED for pay_as_you_go. Never send both this and total_price.",
    ),
  unit_price_is_per_session: z
    .boolean()
    .optional()
    .describe(
      "Only for instalment programmes, and only alongside unit_price. Asserts you ASKED the operator whether " +
        "their figure is per session or for the whole run, and they said PER SESSION. \"Unit price\" / " +
        "\"jednotkova cena\" is ambiguous in everyday speech — never assume it means per session.",
    ),
  registration_fee: z.number().nonnegative().optional().describe("Default 0."),
  color: z.string().optional().describe("Optional admin/calendar colour."),
  allow_duplicate_name: z
    .boolean()
    .optional()
    .describe(
      "Default false. Set true ONLY after the user confirms they want a second programme with the same name.",
    ),
};

const inputSchema = z.object(addCourseInputSchema);

export async function runAddCourse(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: AddCourseResult;
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
  const kind: ProgrammeKind = input.programme_kind ?? "full_duration";

  // Step 1 (local) — conditional price matrix + enum combination validation.
  const validation = validatePriceMatrix(kind, input);
  if (!validation.ok) return errorResult(validation.error);

  const callAuth = withCompany(auth, input.company_id!);
  const warnings: string[] = [];

  // Step 2 — duplicate-name pre-check. Non-blocking on lookup failure.
  if (!input.allow_duplicate_name) {
    try {
      const raw = await zoozaFetch<ApiListResponse<RawCourseRecord> | RawCourseRecord[]>(
        "/courses",
        { query: { name: input.name, filter: "filter" } },
        callAuth,
      );
      const { records } = unwrapList<RawCourseRecord>(raw);
      const dup = findExactNameMatch(records, input.name);
      if (dup) {
        const label = KIND_BY_REGISTRATION_TYPE[dup.registration_type ?? ""] ?? dup.registration_type ?? "unknown";
        return errorResult(
          `A programme named '${dup.name}' already exists (id ${dup.id}, ${label}, archived: ${!!dup.archive}). ` +
            "If the user is re-running it, create a CLASS inside it instead (classes_preview_schedule). To really " +
            "create a second programme with this name, confirm with the user and re-call with " +
            "allow_duplicate_name: true.",
        );
      }
    } catch {
      warnings.push("Could not check for a duplicate programme name — the lookup failed, so this check was skipped.");
    }
  }

  // Step 3 — POST /v1/courses.
  const audience = input.audience ?? "groups";
  const postBody: Record<string, unknown> = {
    name: input.name,
    registration_type: REGISTRATION_TYPE_BY_KIND[kind],
    // api-v1's Course::create whitelist-passes target_audience straight through
    // now (Course.php:160-163) — no follow-up PUT needed.
    target_audience: audience,
    for_children: input.for_children ?? false,
    money_collection: input.payment_collection ?? "one_off",
    price_type: input.price_type ?? "course_fee",
    // For instalment pricing the total is parked in `price` (which that branch of
    // api-v1's calculation ignores) and unit_price stays 0 until classes_commit_class
    // can divide by a real session count. For one-off, `price` IS the charged total.
    price: input.total_price ?? 0,
    unit_price: input.unit_price ?? 0,
    registration_fee: input.registration_fee ?? 0,
    public: true,
    online_registration: true,
    course_type: "course",
    payment_schedules: [],
  };
  if (input.color !== undefined) postBody.color = input.color;

  let created: RawCourseRecord;
  try {
    created = await postCourse(postBody, callAuth);
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      if (error.status === 403) {
        return errorResult(
          "api-v1 rejected the create: this account lacks the add_course permission (owner, assistant and " +
            "main_member roles can create programmes).",
        );
      }
      if (error.status >= 500 || error.status === 0) {
        return errorResult(
          `Zooza API error (${error.status}) — the programme may or may not have been created. Do NOT retry ` +
            `blindly: check with classes_find_courses (name: '${input.name}') first.`,
        );
      }
      return errorResult(`Zooza rejected the programme: ${error.humanMessage}.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  // Step 4 (local) — warnings + output projection.
  if (input.payment_collection === "installments") {
    warnings.push(
      "No payment plan template attached yet — instalment billing needs one. Create it with " +
        "setup_add_payment_template (pass this course_id to attach it in the same call).",
    );
    if (input.total_price !== undefined) {
      warnings.push(
        `The total ${input.total_price} is recorded on the programme but there is no per-session price yet — that ` +
          "is expected and correct. Zooza charges per session, so classes_commit_class will divide this total by " +
          "the sessions you create. Until a class exists the programme prices at 0; do not 'fix' that by putting " +
          "the total into unit_price.",
      );
    }
  }
  if (input.for_children === true) {
    warnings.push(
      "Child profile fields (date of birth, child name) were auto-activated on the booking form.",
    );
  }

  const result: AddCourseResult = {
    created: true,
    course: {
      id: created.id,
      name: created.name ?? input.name,
      registration_type: REGISTRATION_TYPE_BY_KIND[kind],
      programme_kind: kind,
      target_audience: audience,
      for_children: input.for_children ?? false,
      unit_price: toNumber(input.unit_price),
      price: toNumber(input.total_price),
      registration_fee: toNumber(input.registration_fee),
      public: true,
      online_registration: true,
    },
    auto_configured: [
      "Payment reminder automation created with Zooza defaults",
      "Trial automation created with Zooza defaults",
      "Payment methods copied from company defaults",
    ],
    warnings,
    next_steps:
      "The programme cannot accept bookings until it has a class — create one with classes_preview_schedule → " +
      "classes_commit_class. Review settings with classes_update_course_settings (trial, make-ups, booking form).",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

type PriceMatrixResult = { ok: true } | { ok: false; error: string };

function validatePriceMatrix(
  kind: ProgrammeKind,
  input: {
    payment_collection?: (typeof PAYMENT_COLLECTIONS)[number];
    price_type?: (typeof PRICE_TYPES)[number];
    total_price?: number;
    unit_price?: number;
    unit_price_is_per_session?: boolean;
  },
): PriceMatrixResult {
  const reject = (field: string, reason: string): PriceMatrixResult => ({
    ok: false,
    error: `${field} does not apply to ${kind} programmes — ${reason}. Remove it or change programme_kind.`,
  });
  const missing = (requiredField: "total_price" | "unit_price"): PriceMatrixResult => ({
    ok: false,
    error:
      requiredField === "unit_price"
        ? `A ${kind} programme needs unit_price — the price PER SESSION, not the course total. If the user gave you a total (e.g. 200 for the term), divide it by the number of sessions and confirm the result with them before creating.`
        : `A ${kind} programme needs total_price — the whole price the client pays. Ask the user for it before creating.`,
  });

  if (kind === "one_off_event") {
    if (input.payment_collection !== undefined) {
      return reject("payment_collection", "payment_collection is only asked for full_duration");
    }
    if (input.price_type !== undefined) {
      return reject("price_type", "price_type is only asked for full_duration");
    }
    if (input.unit_price !== undefined) {
      return reject("unit_price", "one_off_event programmes use total_price, not unit_price");
    }
    if (input.total_price === undefined) return missing("total_price");
    return { ok: true };
  }

  if (kind === "pay_as_you_go") {
    if (input.payment_collection !== undefined) {
      return reject("payment_collection", "payment_collection is only asked for full_duration");
    }
    if (input.price_type !== undefined) {
      return reject("price_type", "price_type is only asked for full_duration");
    }
    if (input.total_price !== undefined) {
      return reject("total_price", "pay_as_you_go programmes use unit_price, not total_price");
    }
    if (input.unit_price === undefined) return missing("unit_price");
    return { ok: true };
  }

  // full_duration
  const collection = input.payment_collection ?? "one_off";
  if (collection === "one_off") {
    if (input.unit_price !== undefined) {
      return reject("unit_price", "one_off collection uses total_price, not unit_price");
    }
    if (input.price_type !== undefined) {
      return reject("price_type", "price_type is only asked when payment_collection is installments");
    }
    if (input.total_price === undefined) return missing("total_price");
    return { ok: true };
  }
  // installments — the operator's total is the natural input here, but Zooza prices
  // per session, and the session count does not exist until the class is created.
  // So a total is recorded on the course and divided later by classes_commit_class.
  if (input.total_price !== undefined && input.unit_price !== undefined) {
    return {
      ok: false,
      error:
        "Send total_price OR unit_price, not both — they are different prices and Zooza would charge " +
        "unit_price x sessions, ignoring the total. Use total_price for a price covering the whole run " +
        "(the usual case), unit_price only if the operator quoted a per-session figure.",
    };
  }
  if (input.unit_price !== undefined && input.unit_price_is_per_session !== true) {
    return {
      ok: false,
      error:
        `Ambiguous price. You sent unit_price: ${input.unit_price} for an instalment programme, which Zooza would ` +
        `charge ${input.unit_price} PER SESSION — across a 20-session term that is ${input.unit_price * 20}. ` +
        "Operators saying \"unit price\" / \"jednotkova cena\" usually mean the price for the WHOLE run. Ask them " +
        'literally: "Is that per lesson, or for the whole course?" If they say for the whole course, send it as ' +
        "total_price instead. If they confirm per lesson, re-send unit_price with unit_price_is_per_session: true.",
    };
  }
  if (input.total_price === undefined && input.unit_price === undefined) {
    return {
      ok: false,
      error:
        "An instalment programme needs a price. Use total_price for what the client pays for the whole run " +
        "(e.g. 300 for the term) — that is what operators normally quote. Use unit_price only if they gave you a " +
        "per-session price.",
    };
  }
  return { ok: true };
}

/**
 * api name search is accent-insensitive (utf8mb4_unicode_ci) and substring —
 * narrow it down to an exact-name match, the same shape as the settings
 * pair's duplicateNameWarning.
 */
function findExactNameMatch(
  records: RawCourseRecord[],
  name: string,
): RawCourseRecord | undefined {
  const wanted = name.trim().toLowerCase();
  return records.find((r) => (r.name ?? "").trim().toLowerCase() === wanted);
}

async function postCourse(
  body: Record<string, unknown>,
  auth: ZoozaAuth,
): Promise<RawCourseRecord> {
  const raw = await zoozaFetch<{ data?: RawCourseRecord } | RawCourseRecord>(
    "/courses",
    { method: "POST", body },
    auth,
  );
  const course = (raw as { data?: RawCourseRecord })?.data ?? (raw as RawCourseRecord);
  if (!course || !course.id) {
    throw new ZoozaApiError(0, "/courses", "insert_failed: no course id in response");
  }
  return course;
}

function toNumber(v: number | undefined): number {
  return v ?? 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
