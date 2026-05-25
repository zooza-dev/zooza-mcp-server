import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { config } from "../config.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type {
  ApiListResponse,
  FindMatchesEnvelope,
  RawUserRecord,
  TrainerMatch,
} from "./types.js";

/**
 * Active "trainer" roles per app/main.js:3622. Zooza has no `role=trainer`;
 * any team member can be assigned `trainer_id` on a schedule.
 */
const ACTIVE_TRAINER_ROLES = [
  "owner",
  "member",
  "external_member",
  "assistant",
  "main_member",
];

export const findTrainersTitle = "Find trainers (team members)";

export const findTrainersDescription =
  "Search the company's team members eligible to be assigned as trainers on classes. Returns a slim `{id, full_name, email, active, virtual}` per match. By default only active team members (owner/member/external_member/assistant/main_member roles) are returned; pass `include_inactive: true` to include former staff. Optional `place_id` / `course_id` filters narrow to trainers associated with a specific venue or course. Used in `class-management` Step 1 to resolve a trainer from the operator's words.\n\n**Virtual trainers** are also included in results (always, regardless of place/course filters — they're system-wide placeholders, not tied to any real venue/course). They have `virtual: true`, a synthetic id (>= 9000000000000), and no email. Pick one whenever the operator says any of: 'we'll decide later', 'no trainer yet', 'TBD', 'unassigned', 'guest', 'external speaker', or similar. Three system virtual trainers ship by default: 'To be decided', 'Trainer unassigned', 'Guest trainer'.";

export const findTrainersInputSchema = {
  company_id: companyIdSchema,
  name: z.string().optional(),
  place_id: z.number().int().positive().optional(),
  course_id: z.number().int().positive().optional(),
  include_inactive: z.boolean().optional(),
  page: z.number().int().min(0).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
};

const inputSchema = z.object(findTrainersInputSchema);

export async function runFindTrainers(
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
  const includeInactive = input.include_inactive ?? false;

  const roles = includeInactive
    ? [...ACTIVE_TRAINER_ROLES, "inactive"].join("|")
    : ACTIVE_TRAINER_ROLES.join("|");

  const query: Record<string, string | number | undefined> = {
    roles,
    page,
    page_size: pageSize,
    filter: "filter",
  };
  if (input.name) query.name = input.name;
  if (input.place_id) query.place_id = input.place_id;
  if (input.course_id) query.course_id = input.course_id;

  try {
    // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
    const raw = await zoozaFetch<
      ApiListResponse<RawUserRecord> | RawUserRecord[]
    >("/users", { query }, withCompany(auth, input.company_id!));
    const isBare = Array.isArray(raw);
    const records: RawUserRecord[] = isBare ? raw : raw.data ?? [];
    const realMatches: TrainerMatch[] = records.map(projectTrainer);
    const realTotal = isBare ? records.length : raw.total ?? records.length;
    const virtualMatches = collectVirtualMatches(input.name, input.place_id, input.course_id);

    // Virtual trainers are always appended after the current page of real
    // trainers — they're a small, fixed set and operators expect them to be
    // discoverable regardless of pagination. They never count toward `total`
    // for `truncated` calculation (real-user page math stays honest).
    const matches: TrainerMatch[] = [...realMatches, ...virtualMatches];
    const total = realTotal + virtualMatches.length;
    const truncated = realTotal > (page + 1) * pageSize;
    const echo: Record<string, unknown> = isBare ? {} : raw.settings ?? {};

    const result: FindMatchesEnvelope<TrainerMatch> = {
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
        `Could not search trainers (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function collectVirtualMatches(
  nameFilter: string | undefined,
  placeId: number | undefined,
  courseId: number | undefined,
): TrainerMatch[] {
  // Virtual trainers are system-wide placeholders; they have no place/course
  // affinity, so when a venue/course filter is applied to a real-trainer
  // search the operator usually still wants them surfaced ("anyone who could
  // run this class") — keep them in regardless. If a future use case wants
  // them suppressed under place/course filters, gate here.
  void placeId;
  void courseId;
  const needle = nameFilter?.trim().toLowerCase();
  return config.trainers.virtual
    .filter((vt) => !needle || vt.name.toLowerCase().includes(needle))
    .map((vt) => ({
      id: vt.id,
      full_name: vt.name,
      email: "",
      active: true,
      virtual: true,
    }));
}

function projectTrainer(u: RawUserRecord): TrainerMatch {
  const first = (u.first_name ?? "").trim();
  const last = (u.last_name ?? "").trim();
  const composed = `${first} ${last}`.trim();
  const email = u.email ?? "";
  const fullName = composed.length > 0 ? composed : email;
  const roleString =
    typeof u.role === "string" ? u.role : u.role?.role ?? "";
  return {
    id: u.id,
    full_name: fullName,
    email,
    active: roleString !== "inactive",
    virtual: false,
  };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
