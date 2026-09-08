import type { ZoozaAuth } from "../auth/types.js";
import { config } from "../config.js";
import { zoozaFetch } from "../zooza.js";
import { unwrapList } from "./common.js";
import type { AdditionalTrainer, ApiListResponse, RawUserRecord } from "./types.js";

/**
 * id → display-name map for resolving `trainers_events` / `trainers_schedules`
 * rows, which carry only `trainer_id` and `role` (spec ZMCP-20260908-002).
 *
 * Deliberately fetches the WHOLE roster in one call rather than querying the
 * distinct ids on a page. Trainers are administrative users and there are few
 * of them — 55 active / 56 including inactive on the reference instance, and
 * api-v1 honours a large `page_size` on /v1/users — so one request covers a
 * company and there is no distinct-id bookkeeping, no per-page query building,
 * and no N+1.
 *
 * NOT cached. One call per invocation is always correct; a TTL cache would need
 * a company-keyed store and would go stale exactly when an operator has just
 * added a trainer. Revisit only if this shows up in latency.
 */

/** Same role set find-trainers.ts treats as trainers, plus `inactive`.
 *
 *  Inactive is ALWAYS included here, unlike in find-trainers where it is opt-in.
 *  A lecturer who has since been deactivated still has live `trainers_events`
 *  rows, and rendering their numeric id instead of their name is precisely the
 *  failure this resolver exists to prevent. */
const ROSTER_ROLES = [
  "owner",
  "member",
  "external_member",
  "assistant",
  "main_member",
  "inactive",
].join("|");

/** One request must cover a company's whole roster. Far above any plausible
 *  real count (reference instance: 56); if a company ever exceeds it,
 *  `complete` goes false rather than the map silently lying. */
const ROSTER_PAGE_SIZE = 1000;

export interface TrainerDirectory {
  /** Resolve one trainer id to a display name, or null when unknown. */
  name(trainerId: number): string | null;
  /** False when the roster fetch failed or came back truncated — names may be
   *  null even for trainers that do exist. Callers should not treat a null name
   *  as proof of a missing trainer. */
  complete: boolean;
}

/**
 * Build the directory. Never throws: on any upstream failure it returns an
 * empty, `complete: false` directory so a read degrades to ids-without-names
 * rather than failing outright.
 */
export async function loadTrainerDirectory(auth: ZoozaAuth): Promise<TrainerDirectory> {
  const byId = new Map<number, string>();

  // Virtual placeholder trainers ("To be decided", "Guest trainer") have no
  // users row and /v1/users never returns them, but api-v1 accepts them as
  // trainer_id and Event::get_additional_trainers() echoes the raw id for them
  // — so without this they surface as a bare 13-digit number.
  for (const vt of config.trainers.virtual) {
    byId.set(vt.id, vt.name);
  }

  let complete = true;
  try {
    const raw = await zoozaFetch<ApiListResponse<RawUserRecord> | RawUserRecord[]>(
      "/users",
      { query: { filter: "filter", roles: ROSTER_ROLES, page: 0, page_size: ROSTER_PAGE_SIZE } },
      auth,
    );
    const { records, total } = unwrapList<RawUserRecord>(raw);
    for (const u of records) {
      const name = [u.first_name ?? "", u.last_name ?? ""]
        .map((p) => p.trim())
        .filter(Boolean)
        .join(" ");
      byId.set(u.id, name || (u.email ?? "").trim() || `#${u.id}`);
    }
    // Truncated page: resolve what came back, but stop claiming authority.
    if (total > records.length) complete = false;
  } catch {
    complete = false;
  }

  return {
    name: (trainerId: number) => byId.get(trainerId) ?? null,
    complete,
  };
}

/** A directory that resolves nothing — for callers that skip the fetch because
 *  the page contains no additional trainers at all. */
export const EMPTY_TRAINER_DIRECTORY: TrainerDirectory = {
  name: () => null,
  complete: true,
};

/** Raw `trainers_events` / `trainers_schedules` sub-collection row. */
export interface RawTrainerLink {
  trainer_id?: number;
  role?: string;
}

/**
 * Project a raw sub-collection into the LLM-facing shape.
 *
 * Returns `[]` for absent/empty input — api-v1 OMITS the key entirely on rows
 * with no additional trainers (standard add_sub_collection_item behaviour, same
 * as load_labels / load_segments), and an LLM must be able to tell "nobody is
 * assigned" from "the field wasn't loaded". Normalising here is deliberate and
 * was confirmed with api-v1 as intended upstream behaviour, not a defect
 * (handoff zooza-mcp-to-api-v1-20260908-001).
 *
 * `role` is passed through as the RAW enum (secondary | assistant | helper |
 * trainer); the tool descriptions carry the operator-facing labels.
 */
export function projectAdditionalTrainers(
  rows: RawTrainerLink[] | undefined | null,
  dir: TrainerDirectory,
): AdditionalTrainer[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out: AdditionalTrainer[] = [];
  for (const r of rows) {
    const trainer_id = r?.trainer_id ?? 0;
    if (!trainer_id) continue;
    out.push({
      trainer_id,
      trainer_name: dir.name(trainer_id),
      role: typeof r.role === "string" && r.role.length > 0 ? r.role : null,
    });
  }
  return out;
}

/** True when any row on the page carries additional trainers — lets a caller
 *  skip the roster fetch entirely for the common empty case. */
export function hasAnyTrainerLinks(
  rowSets: Array<RawTrainerLink[] | undefined | null>,
): boolean {
  return rowSets.some((rows) => Array.isArray(rows) && rows.length > 0);
}
