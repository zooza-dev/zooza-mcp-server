import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type { ApiListResponse, BillingPeriodMatch, RawBillingPeriodRecord } from "./types.js";

// Spec ZMCP-20261121-001. Single-phase by design: `add` is a simple-write verb in
// the taxonomy (precedents classes_add_course, todos_add). The duplicate risk is
// handled by a mandatory pre-flight instead of a preview/confirm round trip: an
// exact-name match is returned without writing, which also makes a retry after a
// timeout safe. Research: sdd-workflow/research/billing_periods.md.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const addBillingPeriodTitle = "Create a billing period (term)";

export const addBillingPeriodDescription =
  "Creates a BILLING PERIOD: a named date range of the company's calendar that classes belong to " +
  '(e.g. "Spring 2027", "2026/2027"). Operators often call it a term, semester, season or school year. Use it ' +
  "when the operator starts a new term or season and the period does not exist yet. It is NOT a block (a label " +
  "grouping sessions inside one class) and NOT a programme (use classes_add_course for a new offering). If a " +
  "period with the same name already exists, it is returned instead of creating a duplicate (created: false). " +
  "Ask for the start and end dates: the start date also becomes the opening anchor for programmes that use " +
  "priority registration, and a date cannot be removed once set.";

export const addBillingPeriodInputSchema = {
  company_id: companyIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe(
      "What to call the billing period, in the business's own words, e.g. 'Spring 2027', '2026/2027'. If one with " +
        "this exact name exists, it is returned instead.",
    ),
  period_start: z
    .string()
    .regex(DATE, "expected YYYY-MM-DD")
    .optional()
    .describe(
      "First day, YYYY-MM-DD. Also the anchor that priority and public registration opening dates count back from, " +
        "for programmes that use priority registration. Cannot be removed later, only changed.",
    ),
  period_end: z
    .string()
    .regex(DATE, "expected YYYY-MM-DD")
    .optional()
    .describe("Last day (inclusive), YYYY-MM-DD. Not earlier than period_start."),
};

const inputSchema = z.object(addBillingPeriodInputSchema);

export type AddBillingPeriodResult = {
  created: boolean;
  billing_period: BillingPeriodMatch;
  warnings: string[];
};

export async function runAddBillingPeriod(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: AddBillingPeriodResult;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const { name, period_start: start, period_end: end } = input;

  // Mirrors api-v1 Billing_Period::validate_range() (class/Billing_Period.php:149-166),
  // with a message that says which dates were wrong. ISO dates compare as strings.
  if (start && end && end < start) {
    return errorResult(
      `period_end (${end}) is before period_start (${start}). Ask the operator for the correct dates.`,
    );
  }

  const callAuth = withCompany(auth, input.company_id!);

  // Step 1 — pre-flight. Mandatory: names are not unique in api-v1 (no index, no
  // guard — research §7.1), so without this read a retry could create a duplicate.
  // Never send page/page_size: api-v1 used to apply them as column filters and 500
  // (research §2.5); filter=filter alone returns the default page of 1000.
  let existing: RawBillingPeriodRecord[];
  try {
    const raw = await zoozaFetch<ApiListResponse<RawBillingPeriodRecord> | RawBillingPeriodRecord[]>(
      "/billing_periods",
      { query: { filter: "filter" } },
      callAuth,
    );
    existing = unwrapList<RawBillingPeriodRecord>(raw).records;
  } catch {
    return errorResult(
      "Could not read existing billing periods, so nothing was created (a duplicate check is required first). " +
        "Try again shortly.",
    );
  }

  // Step 2 — exact-name reuse.
  const wanted = name.toLowerCase();
  const match = existing.find((r) => (r.name ?? "").trim().toLowerCase() === wanted);
  if (match) {
    const result: AddBillingPeriodResult = {
      created: false,
      billing_period: project(match),
      warnings: [
        `A billing period named "${match.name}" already exists (id ${match.id}), so nothing was created. Use this ` +
          "one. If its dates are not what the operator said, tell them: changing dates is done in the Zooza app " +
          "for now.",
      ],
    };
    return ok(result);
  }

  // Step 3 — POST. Unset dates are omitted, never sent as null (PUT treats null as a
  // silent no-op, research §8.1; keep the two symmetric).
  const body: Record<string, unknown> = { name };
  if (start) body.period_start = start;
  if (end) body.period_end = end;

  let created: RawBillingPeriodRecord;
  try {
    const raw = await zoozaFetch<{ data?: RawBillingPeriodRecord } | RawBillingPeriodRecord>(
      "/billing_periods",
      { method: "POST", body },
      callAuth,
    );
    created = (raw as { data?: RawBillingPeriodRecord })?.data ?? (raw as RawBillingPeriodRecord);
    if (!created || !created.id) {
      throw new ZoozaApiError(0, "/billing_periods", "insert_failed: no id in response");
    }
  } catch (error) {
    return errorResult(postErrorMessage(error, name));
  }

  const warnings: string[] = [];
  if (start) {
    warnings.push(
      "period_start also anchors priority-registration opening dates for programmes in this period that use " +
        "priority registration.",
    );
  }
  if ((start && !end) || (!start && end)) {
    warnings.push(
      "Only one end of the range is set. Class creation pre-fills dates from a billing period only when both are " +
        "set.",
    );
  }
  for (const other of overlapping(existing, start, end)) {
    warnings.push(
      `Overlaps with existing billing period "${other.name}" (${other.period_start} – ${other.period_end}).`,
    );
  }

  return ok({ created: true, billing_period: project(created, body), warnings });
}

/** Existing periods whose [start, end] overlaps the requested range. A side with no
 *  date is open-ended; a period with neither date never overlaps anything. */
export function overlapping(
  records: RawBillingPeriodRecord[],
  start: string | undefined,
  end: string | undefined,
): Array<{ name: string; period_start: string; period_end: string }> {
  if (!start && !end) return [];
  const lo = start ?? "0000-00-00";
  const hi = end ?? "9999-12-31";
  const out: Array<{ name: string; period_start: string; period_end: string }> = [];
  for (const r of records) {
    const rs = r.period_start || null;
    const re = r.period_end || null;
    if (!rs && !re) continue;
    if ((rs ?? "0000-00-00") <= hi && (re ?? "9999-12-31") >= lo) {
      out.push({ name: r.name, period_start: rs ?? "open", period_end: re ?? "open" });
    }
  }
  return out;
}

function project(r: RawBillingPeriodRecord, sent?: Record<string, unknown>): BillingPeriodMatch {
  return {
    id: r.id,
    name: r.name ?? String(sent?.name ?? ""),
    active: r.active ?? true,
    period_start: r.period_start ?? (sent?.period_start as string | undefined) ?? null,
    period_end: r.period_end ?? (sent?.period_end as string | undefined) ?? null,
  };
}

function postErrorMessage(error: unknown, name: string): string {
  if (!(error instanceof ZoozaApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.status === 403) {
    return `Zooza rejected the create: ${error.humanMessage}. This role cannot create billing periods; do not retry.`;
  }
  if (error.status >= 500 || error.status === 0) {
    // research §8.5: a 500 can arrive after the row was committed.
    return (
      `The request to create "${name}" did not complete, so it may or may not exist. Call this tool again with the ` +
      "same name: it returns the period if it was created."
    );
  }
  if (/invalid_value|period_end/i.test(error.responseText)) {
    return "Zooza rejected the dates: the end date is before the start date.";
  }
  // api-v1 collapses missing name and malformed date into one key (research §2.1).
  return (
    "Zooza could not create the billing period. Check that the name is not empty and the dates are YYYY-MM-DD. " +
    `(${error.humanMessage})`
  );
}

function ok(result: AddBillingPeriodResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
