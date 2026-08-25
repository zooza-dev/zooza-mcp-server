import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type {
  ApiListResponse,
  FindMatchesEnvelope,
  PlaceMatch,
  RawPlaceRecord,
} from "./types.js";

export const findPlacesInputSchema = {
  company_id: companyIdSchema,
  name: z
    .string()
    .optional()
    .describe(
      "Partial (substring) match on the venue name, filtered MCP-side and case-insensitive. E.g. \"main\" matches \"Main Hall\".",
    ),
  city: z
    .string()
    .optional()
    .describe(
      "Partial (substring) match on the venue's city, filtered MCP-side and case-insensitive.",
    ),
  page: z.number().int().min(0).optional().describe("0-based page index (default 0)."),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Number of results per page (max 200)."),
};

const inputSchema = z.object(findPlacesInputSchema);

export async function runFindPlaces(
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
  const nameFilter = input.name?.trim().toLowerCase();
  const cityFilter = input.city?.trim().toLowerCase();

  try {
    // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
    const raw = await zoozaFetch<
      ApiListResponse<RawPlaceRecord> | RawPlaceRecord[]
    >(
      "/places",
      { query: { page: 0, page_size: 1000, filter: "filter" } },
      withCompany(auth, input.company_id!),
    );
    const { records } = unwrapList<RawPlaceRecord>(raw);

    const filtered = records.filter((r) => {
      if (r.status === "deleted") return false;
      if (nameFilter) {
        const name = (r.name ?? "").toLowerCase();
        if (!name.includes(nameFilter)) return false;
      }
      if (cityFilter) {
        const city = (r.city ?? "").toLowerCase();
        if (!city.includes(cityFilter)) return false;
      }
      return true;
    });

    const total = filtered.length;
    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    const matches: PlaceMatch[] = slice.map(projectPlace);
    const truncated = total > (page + 1) * pageSize;

    const result: FindMatchesEnvelope<PlaceMatch> = {
      matches,
      total,
      page,
      page_size: pageSize,
      truncated,
      echo: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.city ? { city: input.city } : {}),
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not search venues (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectPlace(p: RawPlaceRecord): PlaceMatch {
  return {
    id: p.id,
    name: p.name ?? "",
    city: p.city ?? "",
    street: p.street ?? "",
    rooms: (p.rooms ?? [])
      .filter((r) => r.status !== "deleted")
      .map((r) => ({
        id: r.id,
        name: r.name ?? "",
        capacity: r.capacity ?? 0,
      })),
  };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
