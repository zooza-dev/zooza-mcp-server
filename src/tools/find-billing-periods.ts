import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type {
  ApiListResponse,
  BillingPeriodMatch,
  FindMatchesEnvelope,
  RawBillingPeriodRecord,
} from "./types.js";

export const findBillingPeriodsTitle = "Find billing periods";

export const findBillingPeriodsDescription =
  "List the company's billing periods, optionally filtered by name. Returns a slim list of `{id, name, active}`. Active periods only by default; pass `include_inactive: true` to see deactivated ones too. Used by the class-management flow when `classes_preview_schedule` warns about a missing `billing_period_id` — the user picks a period from the returned list. Volume is small (typically <30 per company); the tool fetches all and filters MCP-side. No pagination.";

export const findBillingPeriodsInputSchema = {
  company_id: companyIdSchema,
  name: z.string().optional(),
  include_inactive: z.boolean().optional(),
};

const inputSchema = z.object(findBillingPeriodsInputSchema);

export async function runFindBillingPeriods(
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
  const includeInactive = input.include_inactive ?? false;
  const nameFilter = input.name?.trim().toLowerCase();

  try {
    // api-v1 bug: /v1/billing_periods treats `page` / `page_size` query
    // params as SQL WHERE filters (`bp.page = :page`) and crashes on the
    // unknown column. Send only `filter=filter` until api-v1 fixes the
    // dispatch — server returns up to its default page_size (1000) which
    // covers the whole billing-period set for any realistic company.
    // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
    const raw = await zoozaFetch<
      ApiListResponse<RawBillingPeriodRecord> | RawBillingPeriodRecord[]
    >(
      "/billing_periods",
      { query: { filter: "filter" } },
      withCompany(auth, input.company_id!),
    );
    const { records } = unwrapList<RawBillingPeriodRecord>(raw);

    const filtered = records.filter((r) => {
      if (!includeInactive && r.active === false) return false;
      if (nameFilter && !r.name.toLowerCase().includes(nameFilter)) return false;
      return true;
    });

    const matches: BillingPeriodMatch[] = filtered.map(projectBillingPeriod);
    const total = matches.length;

    const result: FindMatchesEnvelope<BillingPeriodMatch> = {
      matches,
      total,
      page: 0,
      page_size: total,
      truncated: false,
      echo: {
        ...(input.name ? { name: input.name } : {}),
        include_inactive: includeInactive,
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not list billing periods (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectBillingPeriod(r: RawBillingPeriodRecord): BillingPeriodMatch {
  return {
    id: r.id,
    name: r.name,
    active: r.active === true,
  };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
