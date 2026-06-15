import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import type {
  ApiListResponse,
  FindMatchesEnvelope,
  RawScheduleRecord,
  ScheduleMatch,
} from "./types.js";

const REGISTRATION_TYPES = ["single", "full2", "open"] as const;

export const findClassesTitle = "Find classes (schedules) by name";

export const findClassesDescription =
  "Search this company's CLASSES — the scheduled groups inside a programme (a \"class\" / \"group\" / \"skupina\"; internally a *schedule*) — by name (substring) and resolve them to a `schedule_id`. Reach for this whenever the user names a specific group rather than a whole programme (\"the Nejaké class\", \"the Monday 5pm group\", \"her Wednesday ballet class\"), or whenever a downstream tool needs a `schedule_id` — most importantly `comms_prepare_message` targeting everyone in one class (`audience.schedule_id`). This is the missing middle rung between `classes_find_courses` (finds the PROGRAMME → `course_id`) and `sessions_find_events` (finds individual dated SESSIONS → `event_id`): a class is one recurring group within a programme, made of many sessions. Optionally narrow by `course_id` (classes inside one programme), `trainer_id`, `place_id`, `day` of week, or `registration_type`. Returns a slim list — `{schedule_id, name, course_id, start, end, time, trainer_id, trainer_name, place_id, place_name, capacity, registrations_count, status}` — enough to disambiguate when several classes share a name, never enough to mutate. `course_id` is returned but not the course name (resolve it with `classes_find_courses` if you need it). By default returns active + paused (inactive) classes; pass `include_archived: true` to search archived classes instead. Does NOT create or change classes (that is `classes_preview_schedule` → `classes_commit_class`) and does NOT list a class's sessions (use `sessions_find_events` with the `schedule_id`).";

export const findClassesInputSchema = {
  company_id: companyIdSchema,
  name: z
    .string()
    .optional()
    .describe(
      'Substring match on the class (schedule) name, e.g. "Nejaké". Case- and accent-insensitive (DB collation utf8mb4_unicode_ci) — "nejake" matches "Nejaké", so you need not reproduce diacritics.',
    ),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only classes inside this programme. Resolve the course_id first with classes_find_courses; never guess it."),
  trainer_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only classes this trainer is assigned to. Resolve with trainers_find."),
  place_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only classes at this venue. Resolve with classes_find_places."),
  day: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe("Day-of-week the class falls on (its start day): 1=Sunday, 2=Monday, … 7=Saturday (MySQL DAYOFWEEK convention)."),
  registration_type: z
    .enum(REGISTRATION_TYPES)
    .optional()
    .describe(
      "Filter by the parent course's registration model: 'single' = drop-in / per-session, 'full2' = full-course enrollment, 'open' = open-ended / membership.",
    ),
  include_archived: z
    .boolean()
    .optional()
    .describe(
      "Default false → returns active + paused (inactive) classes. Set true to search ARCHIVED (retired) classes instead.",
    ),
  page: z.number().int().min(0).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
};

const inputSchema = z.object(findClassesInputSchema);

export async function runFindClasses(
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
    // Denormalise the trainer in the same call. The /schedules collection path
    // honors load_trainer (but NOT load_course — hence no course_name) and never
    // touches the events table, so this stays one cheap query, no session fan-out.
    load_trainer: 1,
  };
  if (input.name) query.name = input.name;
  if (input.course_id !== undefined) query.course_id = input.course_id;
  if (input.trainer_id !== undefined) query.trainer_id = input.trainer_id;
  if (input.place_id !== undefined) query.place_id = input.place_id;
  if (input.day !== undefined) query.day = input.day;
  if (input.registration_type) query.registration_type = input.registration_type;
  // Status model: the collection defaults to active+inactive when `status` is
  // unset. The api accepts only a scalar status over the query string (piped
  // values don't split), so archived is an explicit either/or search rather
  // than additive. See spec ZMCP-20260615-001 Notes.
  if (includeArchived) query.status = "archive";

  try {
    // company_id is guaranteed by the resolveCompanyId wrapper in index.ts —
    // the schema declares it optional so the wrapper can default from session.
    const raw = await zoozaFetch<
      ApiListResponse<RawScheduleRecord> | RawScheduleRecord[]
    >("/schedules", { query }, withCompany(auth, input.company_id!));
    const { records, total, settings: echo } = unwrapList<RawScheduleRecord>(raw);
    const matches: ScheduleMatch[] = records.map(projectSchedule);
    const truncated = total > (page + 1) * pageSize;

    const result: FindMatchesEnvelope<ScheduleMatch> = {
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
        `Could not search classes (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectSchedule(s: RawScheduleRecord): ScheduleMatch {
  const trainerName = s.trainer
    ? [pickStr(s.trainer.first_name), pickStr(s.trainer.last_name)].filter(Boolean).join(" ")
    : "";
  return {
    schedule_id: s.id,
    name: pickStr(s.name) ?? "",
    course_id: s.course_id ?? 0,
    start: pickStr(s.start) ?? "",
    end: pickStr(s.end) ?? "",
    time: pickStr(s.time) ?? "",
    trainer_id: s.trainer_id ?? 0,
    trainer_name: trainerName,
    place_id: s.place_id ?? 0,
    place_name: pickStr(s.__calc__course_place) ?? "",
    capacity: toInt(s.capacity),
    registrations_count: toInt(s.__calc__registered),
    status: pickStr(s.status) ?? "",
  };
}

function toInt(v: number | string | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
