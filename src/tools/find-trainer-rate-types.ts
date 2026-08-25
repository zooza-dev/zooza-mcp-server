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
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
