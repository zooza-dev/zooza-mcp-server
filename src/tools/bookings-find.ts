import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr } from "./common.js";
import type { ClientMatch, RawRegistrationRecord, RegistrationMatch } from "./types.js";

// Caller-facing status groups. Each expands server-side (build_advanced_query,
// common.php:7186) to raw db statuses — `registered` → registered +
// pre_registered. Never surface the raw `pre_*` values. `auto_unenrolled` is
// synthetic (canceled by the unpaid automation, common.php:7208).
const STATUS_VALUES = [
  "registered",
  "guest",
  "waitlist",
  "canceled",
  "late",
  "trial_not_started",
  "trial_started",
  "trial_ended",
  "trial_won",
  "trial_lost",
  "auto_unenrolled",
] as const;

const PAYMENT_STATUS_VALUES = ["paid", "unpaid", "partially_paid", "overpaid"] as const;

// Default roster when `status` is omitted: confirmed enrolments only. api-v1's
// own default would SHOW canceled — it only drops `deleted` (common.php:7236) —
// so we pass this explicit active set instead. guest, waitlist, canceled and
// deleted require an explicit `status` from the caller. See spec Notes.
const DEFAULT_STATUS_GROUPS = [
  "registered",
  "late",
  "trial_not_started",
  "trial_started",
  "trial_ended",
  "trial_won",
  "trial_lost",
] as const;

const MAX_PAGE_SIZE = 200;

export const bookingsFindTitle = "Find bookings (registrations) and clients";

// Kept deliberately tight — this ships in the schema loaded every session.
// Boundary/behaviour detail lives in the field describes and the spec, not here.
export const bookingsFindDescription =
  'Find this company\'s bookings — a client\'s enrolment in a class (registration; "prihláška"/"Buchung") — ' +
  "and resolve them to a `registration_id`, or a client to a `user_id`. Use for \"is X enrolled?\", \"who's in " +
  'this class?", "who hasn\'t paid?" (set `payment_status:["unpaid","partially_paid"]`), and "find client X". ' +
  "Filter by `search` (loose: name/email/phone) or `name`, by `course_id`/`schedule_id` (resolve via " +
  "classes_find_courses / classes_find_classes), `user_id`, `status`, `payment_status`. `distinct:true` returns " +
  "one row per client (→ `user_id`) for person lookups. Chain a result's `registration_id` or `user_id` straight " +
  "into comms_prepare_message (`audience.registration_id` / `audience.user_id`). Class/programme NAMES aren't " +
  "returned — resolve the ids via classes_find_* if you need them. Defaults to active enrolments; guest, waitlist, " +
  "canceled and deleted are excluded unless you pass `status`. Read-only — does not create or change bookings.";

export const bookingsFindInputSchema = {
  company_id: companyIdSchema,
  search: z
    .string()
    .optional()
    .describe(
      "Broad freetext: matches the enrolled person's or account holder's name, email, phone, or id (substring, " +
        "accent-insensitive). Best for a loose term. Use `name` instead to match only the enrolled person's name.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Enrolled person's name (substring, accent-insensitive). If it draws a blank for a kids' class, try `search` " +
        "(also matches the account-holder parent).",
    ),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Bookings in this programme. Resolve the id with classes_find_courses; never guess it."),
  schedule_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Bookings in this class (schedule). Resolve the id with classes_find_classes; never guess it."),
  user_id: z.number().int().positive().optional().describe("All bookings of one client, by their user id."),
  status: z
    .array(z.enum(STATUS_VALUES))
    .optional()
    .describe(
      "Enrolment statuses to include (piped to the api). Omit → confirmed enrolments only (registered, late, " +
        "trial_*); guest, waitlist, canceled and deleted are excluded — pass them to widen. `auto_unenrolled` = " +
        "canceled by the unpaid automation.",
    ),
  payment_status: z
    .array(z.enum(PAYMENT_STATUS_VALUES))
    .optional()
    .describe('Payment state — the "who hasn\'t paid" lever, e.g. ["unpaid","partially_paid"].'),
  distinct: z
    .boolean()
    .optional()
    .describe(
      "true → one row per CLIENT (deduped by account-holder user_id), person fields only — use to find a person or " +
        "resolve a name to a single user_id. Default false → one row per booking.",
    ),
  include_inactive: z
    .boolean()
    .optional()
    .describe("Default false. Set true to also include inactive customers."),
  page: z.number().int().min(0).optional(),
  page_size: z.number().int().min(1).optional(),
};

const inputSchema = z.object(bookingsFindInputSchema);

/** Envelope returned by GET /registrations?advanced_search (common.php:5204-5208). */
interface AdvancedSearchEnvelope {
  total?: number;
  total_capped?: boolean;
  page?: number | null;
  results?: RawRegistrationRecord[];
}

export async function runBookingsFind(
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

  const page = input.page ?? 0;
  const pageSize = input.page_size ?? 25;
  // Explicit guard so the error matches the spec's error catalog verbatim
  // (zod's generic message would not). Upper bound only; min(1) catches 0 / negative.
  if (pageSize > MAX_PAGE_SIZE) {
    return errorResult(`page_size must be between 1 and 200. You asked for ${pageSize}.`);
  }

  const statusProvided = Boolean(input.status && input.status.length > 0);
  const statusGroups = statusProvided ? input.status! : DEFAULT_STATUS_GROUPS;

  const query: Record<string, string | number> = {
    advanced_search: 1,
    // count=exact disables the 500-row count cap (common.php:5726); total is
    // then exact and total_capped stays false.
    count: "exact",
    page,
    page_size: pageSize,
    status: statusGroups.join("|"),
  };
  if (input.search) query.user = input.search; // api `user` = freetext LIKE (common.php:6972)
  if (input.name) query.ef_full_name = input.name;
  if (input.course_id !== undefined) query.course_id = input.course_id;
  if (input.schedule_id !== undefined) query.schedule_id = input.schedule_id;
  if (input.user_id !== undefined) query.user_id = input.user_id;
  if (input.payment_status && input.payment_status.length > 0) {
    query.billing_status = input.payment_status.join("|");
  }
  if (input.include_inactive) query.inactive_customers = 1;
  // GROUP BY r.user_id server-side (common.php:7167); total becomes
  // COUNT(DISTINCT user_id) (common.php:7474). One row per client.
  if (input.distinct) query.distinct = 1;
  // NOTE: email_rejected intentionally NOT passed. comms_prepare_message forces
  // email_rejected=0 to drop unsubscribed clients from a SEND count; bookings_find
  // is a roster/resolve lookup, not a send — an unsubscribed client is still
  // enrolled, so we show everyone. The comms layer applies the unsubscribe filter
  // at send time. See spec Notes.

  try {
    // company_id is guaranteed by the resolveCompanyId wrapper in index.ts —
    // the schema declares it optional so the wrapper can default from session.
    const envelope = await zoozaFetch<AdvancedSearchEnvelope>(
      "/registrations",
      { query },
      withCompany(auth, input.company_id!),
    );
    const rows = envelope?.results ?? [];
    const matches: Array<RegistrationMatch | ClientMatch> = input.distinct
      ? rows.map(projectClient)
      : rows.map(projectBooking);
    const total = envelope?.total ?? matches.length;
    const totalIsCapped = Boolean(envelope?.total_capped);
    const truncated = total > (page + 1) * pageSize;

    const echo: Record<string, unknown> = {
      ...(input.search !== undefined ? { search: input.search } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.course_id !== undefined ? { course_id: input.course_id } : {}),
      ...(input.schedule_id !== undefined ? { schedule_id: input.schedule_id } : {}),
      ...(input.user_id !== undefined ? { user_id: input.user_id } : {}),
      // Echo the literal groups when the caller chose them; a compact marker
      // when we applied the default — avoids shipping the 7-element default array
      // on every call.
      status: statusProvided ? input.status : "default_active",
      ...(input.payment_status?.length ? { payment_status: input.payment_status } : {}),
      ...(input.include_inactive ? { include_inactive: true } : {}),
      ...(input.distinct ? { distinct: true } : {}),
    };

    const result = {
      matches,
      total,
      page,
      page_size: pageSize,
      truncated,
      // Always false under count=exact; surface only if it ever fires, rather
      // than shipping `false` on every call.
      ...(totalIsCapped ? { total_is_capped: true } : {}),
      echo,
    };
    // Compact JSON (no pretty-print) — this is a list tool returning up to 200
    // rows; the whitespace would be pure token overhead for the reading LLM.
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(`Could not search bookings (api-v1 ${error.status}: ${error.humanMessage}).`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/** Default mode: one row per booking. Display name is the ENROLLED person
 *  (ef_full_name — the child in a kids' class), falling back to the account
 *  holder; user_id stays the account holder (the comms/payment target). */
function projectBooking(r: RawRegistrationRecord): RegistrationMatch {
  return {
    registration_id: r.registration_id ?? 0,
    user_id: toInt(r.user_id),
    client_name: enrolledName(r),
    email: pickStr(r.email) ?? "",
    course_id: r.course_id ?? 0,
    schedule_id: r.schedule_id ?? 0,
    status: pickStr(r.status) ?? "",
    payment_status: pickStr(r.payment_status) ?? "",
    payment_debt: toNum(r.payment_debt),
  };
}

/** distinct mode: one row per account holder. Name is the account holder
 *  (full_name), since the row represents the person, not one child's booking. */
function projectClient(r: RawRegistrationRecord): ClientMatch {
  return {
    user_id: toInt(r.user_id),
    client_name: accountHolderName(r),
    email: pickStr(r.email) ?? "",
  };
}

function enrolledName(r: RawRegistrationRecord): string {
  return pickStr(r.ef_full_name) ?? accountHolderName(r);
}

function accountHolderName(r: RawRegistrationRecord): string {
  return pickStr(r.full_name) ?? [pickStr(r.first_name), pickStr(r.last_name)].filter(Boolean).join(" ");
}

function toInt(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function toNum(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
