import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type {
  ApiListResponse,
  FindMatchesEnvelope,
  RawTrainerRateTypeRecord,
  TrainerRateTypeMatch,
} from "./types.js";

export const findTrainerRateTypesInputSchema = {
  company_id: companyIdSchema,
  name: z
    .string()
    .optional()
    .describe(
      "Partial (substring) match on the rate type name, filtered MCP-side and case-insensitive. E.g. \"hourly\".",
    ),
};

const inputSchema = z.object(findTrainerRateTypesInputSchema);

export async function runFindTrainerRateTypes(
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
  const nameFilter = input.name?.trim().toLowerCase();

  try {
    // GET /v1/trainer_rates/types → company's rate types (company_id is a system
    // search param, applied by withCompany). Volume is tiny; fetch all and filter
    // MCP-side by name, mirroring classes_find_resource (kind:'billing_period').
    // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
    const raw = await zoozaFetch<
      ApiListResponse<RawTrainerRateTypeRecord> | RawTrainerRateTypeRecord[]
    >("/trainer_rates/types", {}, withCompany(auth, input.company_id!));
    const { records } = unwrapList<RawTrainerRateTypeRecord>(raw);

    const filtered = records.filter((r) => {
      if (nameFilter && !(r.name ?? "").toLowerCase().includes(nameFilter)) return false;
      return true;
    });

    const matches: TrainerRateTypeMatch[] = filtered.map(projectRateType);
    const total = matches.length;

    const result: FindMatchesEnvelope<TrainerRateTypeMatch> = {
      matches,
      total,
      page: 0,
      page_size: total,
      truncated: false,
      echo: {
        ...(input.name ? { name: input.name } : {}),
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not list trainer rate types (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Write-path guard for `trainer_rate_type_id` (spec ZMCP-20261009-007, issue #3).
 * The app pairs a class with its pay rate by strict id match against this same
 * GET /trainer_rates/types list (app pages/courses/schedules_detail.js:284-287,
 * 993-1001), so an id outside the list saves fine but shows as "no rate" in the app.
 * `0` / omitted = no rate and is always valid. A failed lookup never blocks the
 * write — it comes back as a warning instead.
 */
export async function checkTrainerRateTypeId(
  id: number | undefined,
  auth: ZoozaAuth,
): Promise<{ error?: string; warning?: string }> {
  if (id === undefined || id === 0) return {};
  let records: RawTrainerRateTypeRecord[];
  try {
    const raw = await zoozaFetch<
      ApiListResponse<RawTrainerRateTypeRecord> | RawTrainerRateTypeRecord[]
    >("/trainer_rates/types", {}, auth);
    records = unwrapList<RawTrainerRateTypeRecord>(raw).records;
  } catch (error) {
    const why = error instanceof ZoozaApiError ? `api-v1 ${error.status}` : "lookup failed";
    return {
      warning: `Could not verify trainer_rate_type_id ${id} against the company's pay rates (${why}).`,
    };
  }
  if (records.some((r) => Number(r.id) === id)) return {};
  const valid = records.map((r) => `${r.id} (${r.name})`).join(", ");
  return {
    error:
      `trainer_rate_type_id ${id} is not one of this company's trainer pay rates, so the app would show the ` +
      `class with no rate. ${valid ? `Valid ids: ${valid}.` : "The company has no pay rates — use 0 (none)."} ` +
      `Resolve it with classes_find_resource kind:"trainer_rate_type".`,
  };
}

function projectRateType(r: RawTrainerRateTypeRecord): TrainerRateTypeMatch {
  return {
    id: r.id,
    name: r.name,
    minutes: r.minutes ?? null,
    type: r.type ?? null,
  };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
