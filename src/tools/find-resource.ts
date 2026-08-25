import { z } from "zod";
import type { ZoozaAuth } from "../auth/types.js";
import { companyIdSchema } from "./common.js";
import { runFindBillingPeriods } from "./find-billing-periods.js";
import { runFindPlaces } from "./find-places.js";
import { runFindTrainerRateTypes } from "./find-trainer-rate-types.js";
import { runFindTrainers } from "./find-trainers.js";

/**
 * One `kind`-discriminated resolver replacing four thin name→id lookups
 * (spec ZMCP-20260824-002; admitted to the taxonomy by ZMCP-20260611-007
 * Amendment 1b, which allows a read-only resolver to cross buckets).
 *
 * Each kind keeps its own upstream call, projection and api-v1 workarounds — this
 * module only validates the filter matrix and delegates. The heavier finders
 * (classes_find_courses, classes_find_classes, bookings_find, sessions_find_events)
 * are deliberately NOT folded in: they carry rich domain filters and most of the
 * routing tree's disambiguation signal, so merging them would trade tool slots for a
 * worse chance of the model picking the right lookup.
 */

const KINDS = ["place", "billing_period", "trainer", "trainer_rate_type"] as const;
type Kind = (typeof KINDS)[number];

/** Filters each kind accepts, verified 2026-08-24 against the four input schemas. */
const FILTERS_BY_KIND: Record<Kind, readonly string[]> = {
  place: ["name", "city", "page", "page_size"],
  billing_period: ["name", "include_inactive"],
  trainer: ["name", "place_id", "course_id", "include_inactive", "page", "page_size"],
  trainer_rate_type: ["name"],
};

/** Never counted as a filter: the discriminator and the wrapper-injected company. */
const NON_FILTER_KEYS = new Set(["kind", "company_id"]);

export const findResourceTitle = "Find a venue, billing period, trainer, or pay rate";

export const findResourceDescription =
  "Resolve a NAME the operator said into an id, for four kinds of company-level records. Pick `kind`:\n\n" +
  "- `place` — venues. Returns `{id, name, city, street, rooms: [{id, name, capacity}]}`. Rooms are inlined " +
  "because picking a venue is usually followed by picking a room. Filters: name, city.\n" +
  "- `billing_period` — term blocks (e.g. \"Autumn 2026\"). Returns `{id, name, active, period_start, period_end}`; " +
  "either date may be null, an open-ended period is valid. Filter: name. Match on the DATES, not just the name — a " +
  "period covering the term you want may be named anything.\n" +
  "- `trainer` — team members assignable to classes. Returns `{id, full_name, email, active, virtual}`. Filters: " +
  "name, place_id, course_id. **Virtual trainers** are always included regardless of place/course filters — they " +
  "are system-wide placeholders with `virtual: true`, a synthetic id (>= 9000000000000) and no email. Pick one " +
  "when the operator says \"we'll decide later\", \"no trainer yet\", \"TBD\", \"unassigned\", \"guest\", " +
  "\"external speaker\". Three ship by default: 'To be decided', 'Trainer unassigned', 'Guest trainer'.\n" +
  "- `trainer_rate_type` — named pay rates (e.g. \"Hourly\", \"Per class\"). Returns `{id, name, minutes, type}`. " +
  "This is the ONLY way to turn a rate the operator names into the `trainer_rate_type_id` that classes_update and " +
  "sessions_update need — NEVER guess that id.\n\n" +
  "`include_inactive` (place: n/a) defaults false. Sending a filter that does not apply to the chosen kind returns " +
  "the list of filters that do. For PROGRAMMES use classes_find_courses, for CLASSES classes_find_classes, for " +
  "people enrolled use bookings_find — those are separate, richer tools.";

export const findResourceInputSchema = {
  company_id: companyIdSchema,
  kind: z
    .enum(KINDS)
    .describe(
      "Which kind of record to resolve. 'place' = venue, 'billing_period' = term block, 'trainer' = team member, " +
        "'trainer_rate_type' = named pay rate.",
    ),
  name: z.string().optional().describe("Substring match on the record's name. Applies to every kind."),
  city: z.string().optional().describe("kind=place only."),
  place_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("kind=trainer only — narrow to trainers associated with this venue."),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("kind=trainer only — narrow to trainers associated with this programme."),
  include_inactive: z
    .boolean()
    .optional()
    .describe("kind=trainer or billing_period. Default false — include former staff / deactivated periods."),
  page: z.number().int().min(0).optional().describe("kind=place or trainer. Default 0."),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "kind=place or trainer. Default 25, max 200. billing_period and trainer_rate_type are small bounded sets " +
        "and are returned in full.",
    ),
};

const inputSchema = z.object(findResourceInputSchema);

export async function runFindResource(
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
  const kind = input.kind;
  const allowed = FILTERS_BY_KIND[kind];

  // Reject rather than silently drop — same idiom as the section whitelist in
  // prepare-course-settings.ts and the price matrix in add-course.ts. A dropped
  // filter would return a wider result set than the caller believes it asked for.
  const stray = Object.keys(input)
    .filter((k) => !NON_FILTER_KEYS.has(k))
    .filter((k) => (input as Record<string, unknown>)[k] !== undefined)
    .filter((k) => !allowed.includes(k))
    .sort();
  if (stray.length > 0) {
    return errorResult(
      `${stray.map((s) => `\`${s}\``).join(", ")} ${stray.length === 1 ? "does" : "do"} not apply to ` +
        `kind='${kind}'. Filters for '${kind}': ${allowed.join(", ")}. Remove it, or change kind.`,
    );
  }

  // Delegate with only this kind's own fields, so each underlying tool sees exactly
  // the input shape its zod schema already validates.
  const sub: Record<string, unknown> = { company_id: input.company_id };
  for (const f of allowed) {
    const v = (input as Record<string, unknown>)[f];
    if (v !== undefined) sub[f] = v;
  }

  switch (kind) {
    case "place":
      return runFindPlaces(sub, auth);
    case "billing_period":
      return runFindBillingPeriods(sub, auth);
    case "trainer":
      return runFindTrainers(sub, auth);
    case "trainer_rate_type":
      return runFindTrainerRateTypes(sub, auth);
  }
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
