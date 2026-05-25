import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type {
  ApiListResponse,
  CourseMatch,
  FindMatchesEnvelope,
  RawCourseRecord,
} from "./types.js";

const REGISTRATION_TYPES = ["single", "full2", "open"] as const;

export const findCoursesTitle = "Find courses by name";

export const findCoursesDescription =
  "Search the company's courses by name (substring match) and optionally by registration_type / course_type. Returns a slim list of matches — `{id, name, registration_type, target_audience, price, schedules_count, ...}` — enough to disambiguate, not enough to act. Use this whenever the user names a course in natural language; never demand a raw course_id. Archived courses are excluded by default (pass `include_archived: true` to opt in). Pagination defaults to page 0, page_size 25 (max 200); `truncated: true` is returned when more matches exist than the current page reveals.\n\n`registration_type` business meanings (when filtering, AND when surfacing results to the user — always translate to these terms, never show the raw enum value):\n- `single` — drop-in / per-session: customer books one event at a time.\n- `full2` — full-course enrollment: customer signs up for the entire course/schedule in one go.\n- `open` — open-ended / membership: no fixed enrollment window; customer joins and stays.";

export const findCoursesInputSchema = {
  company_id: companyIdSchema,
  name: z.string().optional(),
  registration_type: z
    .enum(REGISTRATION_TYPES)
    .describe(
      "Registration model. 'single' = drop-in / per-session booking (customer books one event at a time). 'full2' = full-course enrollment (customer signs up for the entire course at once). 'open' = open-ended / membership (no fixed enrollment window).",
    )
    .optional(),
  course_type: z.string().optional(),
  include_archived: z.boolean().optional(),
  page: z.number().int().min(0).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
};

const inputSchema = z.object(findCoursesInputSchema);

export async function runFindCourses(
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
  const includeArchived = input.include_archived ?? false;

  const query: Record<string, string | number | undefined> = {
    page,
    page_size: pageSize,
    // api-v1 returns a bare array by default and only emits the wrapped
    // {total, page, page_size, settings, data} envelope when `filter` is
    // present in the query string. Value is treated as a sentinel.
    filter: "filter",
  };
  if (!includeArchived) query.archive = "false";
  if (input.name) query.name = input.name;
  if (input.registration_type) query.registration_type = input.registration_type;
  if (input.course_type) query.course_type = input.course_type;

  try {
    // company_id is guaranteed by the resolveCompanyId wrapper in index.ts —
    // the schema declares it optional so the wrapper can default from session.
    const raw = await zoozaFetch<
      ApiListResponse<RawCourseRecord> | RawCourseRecord[]
    >("/courses", { query }, withCompany(auth, input.company_id!));
    const isBare = Array.isArray(raw);
    const records: RawCourseRecord[] = isBare ? raw : raw.data ?? [];
    const matches: CourseMatch[] = records.map(projectCourse);
    const total = isBare ? records.length : raw.total ?? records.length;
    const truncated = total > (page + 1) * pageSize;
    const echo: Record<string, unknown> = isBare ? {} : raw.settings ?? {};

    const result: FindMatchesEnvelope<CourseMatch> = {
      matches,
      total,
      page,
      page_size: pageSize,
      truncated,
      echo,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not search courses (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectCourse(c: RawCourseRecord): CourseMatch {
  return {
    id: c.id,
    name: c.name,
    registration_type: c.registration_type ?? "",
    course_type: c.course_type ?? "",
    target_audience: c.target_audience ?? "",
    price: toNumber(c.price),
    unit_price: toNumber(c.unit_price),
    price_type: c.price_type ?? "",
    archive: !!c.archive,
    online_registration: !!c.online_registration,
    schedules_count: toInt(c.__calc__schedules_count),
    registrations_count: toInt(c.__calc__registrations_count),
  };
}

function toNumber(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
