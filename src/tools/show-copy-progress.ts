import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type { ApiListResponse, RawBillingPeriodRecord } from "./types.js";
import { isTemporaryStepError, noteTemporaryFailure } from "./copy-retry-ledger.js";

// Spec ZMCP-20261122-002, coverage mode. A rollover of ~300 classes is done in chunks
// over days, by different operators, in different conversations, so its progress must
// come from Zooza's data. "Copied" is decided ONLY by class lineage — `schedules.previous`
// (api-v1 API-20261121-002) — never by name or date matching, and never by job rows,
// which api-v1 deletes 7 days after they finish.
//
// Jobs (api-v1 API-20261121-004, live on local 2026-11-22) add two things on top:
// - `in_progress`: source classes inside a queued or running `schedule_copy` job into the
//   target period. Lineage still wins: a class with a copy is `copied` whatever the jobs say.
// - job mode (`job_id`): one copy job's status per class, for "is my copy done".

/** classes_copy_class's per-call cap (spec ZMCP-20261122-001). */
export const CHUNK_MAX = 25;
const PAGE_SIZE = 200;
/** 20 × 200 = 4 000 classes per period; far above any real company, a guard against a loop. */
const MAX_PAGES = 20;
/** Copied rows are listed up to this many; totals always count them all. */
const COPIED_LIST_MAX = 50;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const showCopyProgressTitle = "Show billing-period rollover progress";

export const showCopyProgressDescription =
  'Shows how far a billing-period rollover ("start new term") has got. Give the source and the target billing ' +
  "period: it lists how many of the source period's classes are already copied into the target, which are being " +
  "copied right now, and groups " +
  "the ones left by venue, instructor, programme or weekday, in suggested chunks of at most 25 to pass to " +
  "classes_copy_class. Works across conversations and operators, because it reads which class each copy came " +
  "from. Lead pipelines, archived classes, classes of archived programmes and classes with no sessions are listed " +
  "apart, never copied. With job_id instead (from classes_copy_class), shows that one copy job's status per " +
  "class: new class id, clients copied, amount charged, error. Read-only.";

export const showCopyProgressInputSchema = {
  company_id: companyIdSchema,
  source_billing_period_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The billing period being copied FROM (e.g. Winter 2026). Resolve via classes_find_resource kind:billing_period."),
  target_billing_period_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The billing period being copied INTO (e.g. Spring 2027)."),
  group_by: z
    .enum(["venue", "instructor", "programme", "weekday"])
    .optional()
    .describe("How to group the classes left to copy into chunks. Default venue."),
  job_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Instead of the two periods: one copy job's id (job_id from classes_copy_class), to see if it is done."),
};

const inputSchema = z.object(showCopyProgressInputSchema);

interface RawSchedule {
  id: number;
  name?: string | null;
  course_id?: number;
  place_id?: number;
  trainer_id?: number;
  start?: string;
  total_events?: number | string;
  schedule_type?: string;
  previous?: number | string | null;
  trainer?: { first_name?: string; last_name?: string };
}

interface Named {
  id: number;
  name?: string | null;
  /** Courses only. */
  archive?: boolean | number | string;
}

export type ExcludedReason = "lead_pipeline" | "archived" | "programme_archived" | "no_sessions";

export type CopyProgressResult = {
  source: { id: number; name: string };
  target: { id: number; name: string };
  totals: { source_classes: number; copied: number; in_progress: number; remaining: number; excluded: number };
  group_by: "venue" | "instructor" | "programme" | "weekday";
  remaining_chunks: Array<{ group: string; count: number; schedule_ids: number[] }>;
  copied: Array<{ source_schedule_id: number; new_schedule_ids: number[] }>;
  copied_truncated: boolean;
  in_progress: Array<{ source_schedule_id: number; job_id: number; status: "queued" | "running" }>;
  excluded: Array<{ schedule_id: number; name: string; reason: ExcludedReason }>;
  flags: Array<{ source_schedule_id: number; flag: "copied_twice" }>;
  warnings: string[];
  next: string;
};

export type CopyJobResult = {
  job_id: number;
  status: string;
  created_at: string | null;
  finished_at: string | null;
  totals: { classes: number; completed: number; failed: number; waiting: number };
  classes: Array<{
    source_schedule_id: number | null;
    status: string;
    new_schedule_id: number | null;
    bookings_copied: number;
    bookings_skipped: number;
    amount_charged: number;
    error: string | null;
    /** Failed classes only: true = a temporary error, re-preview and apply once without asking again. */
    retryable?: boolean;
  }>;
  next: string;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: CopyProgressResult | CopyJobResult;
};

/** api-v1 job type of a class copy (class/Enums/Job_Type.php). */
const COPY_JOB_TYPE = "schedule_copy";

interface RawJob {
  id: number | string;
  status?: string;
  source_schedule_id?: number | string | null;
  created_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
  payload?: {
    source_schedule_id?: number | string | null;
    overrides?: { billing_period_id?: number | string };
    classes?: Record<string, { overrides?: { billing_period_id?: number | string } }>;
  };
}

interface RawJobStep {
  status?: string;
  input?: { source_schedule_id?: number | string };
  result?: {
    schedule_id?: number | string | null;
    bookings?: Array<{ new_registration_id?: number | null; amount_charged?: number | string; skipped?: boolean }>;
  } | null;
  error_key?: string | null;
  error_data?: unknown;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Every page of a list endpoint. Throws on a failed page: a partial list would mark
 *  classes "remaining" that are already copied, which invites a second copy. */
async function allPages<T>(path: string, query: Record<string, string | number>, auth: ZoozaAuth): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await zoozaFetch<ApiListResponse<T> | T[]>(
      path,
      { query: { ...query, filter: "filter", page, page_size: PAGE_SIZE } },
      auth,
    );
    const { records, total } = unwrapList<T>(raw);
    out.push(...records);
    // Stop on `total`, not on a short page: an endpoint that caps page_size below what
    // we asked would otherwise end the walk after page one, silently.
    if (records.length === 0 || out.length >= total) return out;
  }
  throw new Error(`${path}: more than ${MAX_PAGES * PAGE_SIZE} rows; refusing to report a partial list.`);
}

export const MODE_ERROR = "Give source_billing_period_id and target_billing_period_id, or job_id.";

export async function runShowCopyProgress(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const sourceId = input.source_billing_period_id;
  const targetId = input.target_billing_period_id;
  const hasPeriods = sourceId !== undefined || targetId !== undefined;
  if (input.job_id !== undefined) {
    if (hasPeriods) return errorResult(MODE_ERROR);
    return runJobMode(input.job_id, withCompany(auth, input.company_id!));
  }
  if (sourceId === undefined || targetId === undefined) return errorResult(MODE_ERROR);
  const groupBy = input.group_by ?? "venue";
  if (sourceId === targetId) {
    return errorResult("The source and target billing period are the same. Give the period copied FROM and the one copied INTO.");
  }
  const callAuth = withCompany(auth, input.company_id!);

  let periods: RawBillingPeriodRecord[];
  let sourceRows: RawSchedule[];
  let archivedRows: RawSchedule[];
  let targetRows: RawSchedule[];
  let places: Named[];
  let courses: Named[];
  try {
    [periods, sourceRows, archivedRows, targetRows, places, courses] = await Promise.all([
      // Never page billing_periods (research §2.5): filter=filter alone returns them all.
      zoozaFetch<ApiListResponse<RawBillingPeriodRecord> | RawBillingPeriodRecord[]>(
        "/billing_periods",
        { query: { filter: "filter" } },
        callAuth,
      ).then((raw) => unwrapList<RawBillingPeriodRecord>(raw).records),
      // include_archived=1: GET schedules hides classes of ARCHIVED PROGRAMMES by default
      // (api-v1 schedules.php:764-766). Without it they vanished from the count silently
      // (live, local period 310: 19 of 244). They are listed as excluded instead.
      allPages<RawSchedule>("/schedules", { billing_period_id: sourceId, load_trainer: 1, include_archived: 1 }, callAuth),
      // Archived CLASSES are a separate status the collection also hides unless asked.
      allPages<RawSchedule>("/schedules", { billing_period_id: sourceId, status: "archive", include_archived: 1 }, callAuth),
      // A copy counts as copied even if its programme was archived since.
      allPages<RawSchedule>("/schedules", { billing_period_id: targetId, include_archived: 1 }, callAuth),
      groupBy === "venue" ? allPages<Named>("/places", {}, callAuth) : Promise.resolve([]),
      // Always: programme names for grouping, and the archive flag for exclusion.
      // Unfiltered, /courses returns live and archived programmes alike.
      allPages<Named>("/courses", {}, callAuth),
    ]);
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status >= 500) {
      return errorResult("Zooza did not answer; try again.");
    }
    return errorResult(
      `Could not read the classes of both billing periods (${error instanceof ZoozaApiError ? `api-v1 ${error.status}: ${error.humanMessage}` : String(error)}).`,
    );
  }

  const source = periods.find((p) => toInt(p.id) === sourceId);
  const target = periods.find((p) => toInt(p.id) === targetId);
  if (!source) return errorResult(`Billing period ${sourceId} not found. Resolve it via classes_find_resource kind:billing_period.`);
  if (!target) return errorResult(`Billing period ${targetId} not found. Resolve it via classes_find_resource kind:billing_period.`);

  // In flight: classes inside a queued or running copy job into THIS target period.
  // Best effort: lineage is authoritative, so a jobs failure only costs the in_progress
  // marks. api-v1 matches `status` by equality (Collection/Jobs.php:108-110), hence two
  // reads. A batch job has source_schedule_id null at job level (live, local job 500):
  // its classes are the keys of payload.classes, each with its own target period.
  const warnings: string[] = [];
  const inFlight = new Map<number, { job_id: number; status: "queued" | "running" }>();
  try {
    const [queued, running] = await Promise.all(
      (["queued", "running"] as const).map((status) => allPages<RawJob>("/jobs", { type: COPY_JOB_TYPE, status }, callAuth)),
    );
    for (const [status, jobs] of [["queued", queued], ["running", running]] as const) {
      for (const job of jobs) {
        for (const id of jobSourcesInto(job, targetId)) {
          if (!inFlight.has(id)) inFlight.set(id, { job_id: toInt(job.id), status });
        }
      }
    }
  } catch (error) {
    // A missing jobs resource (404, not deployed yet) is not worth a warning.
    if (!(error instanceof ZoozaApiError && error.status === 404)) {
      warnings.push("Could not read the copy jobs, so classes being copied right now show as remaining. Do not copy them again before checking.");
    }
  }

  // Lineage: new class → the class it was copied from.
  const copiesOf = new Map<number, number[]>();
  for (const t of targetRows) {
    const prev = toInt(t.previous);
    if (prev > 0) copiesOf.set(prev, [...(copiesOf.get(prev) ?? []), t.id]);
  }

  const archivedCourses = new Set(
    courses.filter((c) => c.archive === true || c.archive === 1 || c.archive === "1" || c.archive === "true").map((c) => toInt(c.id)),
  );
  const excluded: CopyProgressResult["excluded"] = archivedRows.map((s) => ({
    schedule_id: s.id,
    name: s.name ?? "",
    reason: "archived" as const,
  }));
  const copied: CopyProgressResult["copied"] = [];
  const flags: CopyProgressResult["flags"] = [];
  const remaining: RawSchedule[] = [];
  const in_progress: CopyProgressResult["in_progress"] = [];

  for (const s of sourceRows) {
    const copies = copiesOf.get(s.id);
    if (copies) {
      // A copied class counts as copied whatever its shape; its exclusion no longer matters.
      copied.push({ source_schedule_id: s.id, new_schedule_ids: copies });
      if (copies.length > 1) flags.push({ source_schedule_id: s.id, flag: "copied_twice" });
    } else if (inFlight.has(s.id)) {
      in_progress.push({ source_schedule_id: s.id, ...inFlight.get(s.id)! });
    } else if (archivedCourses.has(toInt(s.course_id))) {
      excluded.push({ schedule_id: s.id, name: s.name ?? "", reason: "programme_archived" });
    } else if (s.schedule_type === "lead_collection") {
      excluded.push({ schedule_id: s.id, name: s.name ?? "", reason: "lead_pipeline" });
    } else if (toInt(s.total_events) === 0) {
      excluded.push({ schedule_id: s.id, name: s.name ?? "", reason: "no_sessions" });
    } else {
      remaining.push(s);
    }
  }

  const placeName = new Map(places.map((p) => [toInt(p.id), p.name ?? ""]));
  const courseName = new Map(courses.map((c) => [toInt(c.id), c.name ?? ""]));
  const label = (s: RawSchedule): string => {
    switch (groupBy) {
      case "venue":
        return placeName.get(toInt(s.place_id)) || `venue ${toInt(s.place_id)}`;
      case "programme":
        return courseName.get(toInt(s.course_id)) || `programme ${toInt(s.course_id)}`;
      case "instructor": {
        const n = [s.trainer?.first_name, s.trainer?.last_name].filter(Boolean).join(" ");
        return n || (toInt(s.trainer_id) ? `instructor ${toInt(s.trainer_id)}` : "no instructor");
      }
      case "weekday": {
        const d = s.start ? new Date(`${s.start.slice(0, 10)}T00:00:00Z`) : null;
        return d && !Number.isNaN(d.getTime()) ? WEEKDAYS[d.getUTCDay()] : "unknown weekday";
      }
    }
  };

  const groups = new Map<string, number[]>();
  for (const s of remaining) {
    const key = label(s);
    groups.set(key, [...(groups.get(key) ?? []), s.id]);
  }
  const remaining_chunks: CopyProgressResult["remaining_chunks"] = [];
  for (const [group, ids] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const parts = Math.ceil(ids.length / CHUNK_MAX);
    for (let i = 0; i < parts; i++) {
      const chunk = ids.slice(i * CHUNK_MAX, (i + 1) * CHUNK_MAX);
      remaining_chunks.push({ group: parts > 1 ? `${group} (${i + 1}/${parts})` : group, count: chunk.length, schedule_ids: chunk });
    }
  }

  const result: CopyProgressResult = {
    source: { id: sourceId, name: source.name ?? "" },
    target: { id: targetId, name: target.name ?? "" },
    totals: {
      source_classes: sourceRows.length + archivedRows.length,
      copied: copied.length,
      in_progress: in_progress.length,
      remaining: remaining.length,
      excluded: excluded.length,
    },
    group_by: groupBy,
    remaining_chunks,
    copied: copied.slice(0, COPIED_LIST_MAX),
    copied_truncated: copied.length > COPIED_LIST_MAX,
    in_progress,
    excluded,
    flags,
    warnings,
    next:
      remaining.length === 0 && in_progress.length === 0
        ? "Every class of the source period that can be copied has a copy in the target period."
        : remaining.length === 0
          ? "Nothing is left to start; the classes in in_progress are still being copied. Check again in a minute."
          : `Offer the operator the next chunk from remaining_chunks, then preview it with classes_copy_class.` +
            (in_progress.length > 0 ? " Leave the classes in in_progress out: they are being copied now." : ""),
  };

  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

/** Source class ids a copy job is copying into `targetId`. */
function jobSourcesInto(job: RawJob, targetId: number): number[] {
  const p = job.payload ?? {};
  if (p.classes && typeof p.classes === "object") {
    return Object.entries(p.classes)
      .filter(([, c]) => toInt(c?.overrides?.billing_period_id) === targetId)
      .map(([id]) => toInt(id))
      .filter((id) => id > 0);
  }
  // Single-class route: the class is on the job, the target on its overrides.
  const id = toInt(job.source_schedule_id ?? p.source_schedule_id);
  return id > 0 && toInt(p.overrides?.billing_period_id) === targetId ? [id] : [];
}

/** A batch holds at most CHUNK_MAX classes, one step each; 50 leaves headroom. */
const STEPS_PAGE_SIZE = 50;

async function runJobMode(jobId: number, auth: ZoozaAuth): Promise<ToolResult> {
  let job: RawJob;
  let steps: RawJobStep[];
  try {
    const raw = await zoozaFetch<{ data?: RawJob } | RawJob>(`/jobs/${jobId}`, {}, auth);
    job = (raw as { data?: RawJob }).data ?? (raw as RawJob);
    const rawSteps = await zoozaFetch<ApiListResponse<RawJobStep> | RawJobStep[]>(
      `/jobs/${jobId}/steps`,
      { query: { filter: "filter", page: 0, page_size: STEPS_PAGE_SIZE } },
      auth,
    );
    steps = unwrapList<RawJobStep>(rawSteps).records;
  } catch (error) {
    // Unknown id: api-v1 answers 400 with 0065 resource_not_found (live, local), not 404.
    if (error instanceof ZoozaApiError && (error.status === 404 || error.responseText.includes("0065"))) {
      return errorResult(
        `No copy job ${jobId}. Finished jobs are kept for 7 days. Use coverage mode instead (source_billing_period_id + target_billing_period_id).`,
      );
    }
    if (error instanceof ZoozaApiError && error.status >= 500) return errorResult("Zooza did not answer; try again.");
    return errorResult(
      `Could not read copy job ${jobId} (${error instanceof ZoozaApiError ? `api-v1 ${error.status}: ${error.humanMessage}` : String(error)}).`,
    );
  }

  const classes: CopyJobResult["classes"] = steps.map((st) => {
    const bookings = st.result?.bookings ?? [];
    const copiedRows = bookings.filter((b) => !b.skipped && b.new_registration_id);
    const newId = toInt(st.result?.schedule_id);
    const source = toInt(st.input?.source_schedule_id);
    const failedStep = st.status === "failed";
    const temporary = failedStep && isTemporaryStepError(st.error_key, st.error_data);
    return {
      source_schedule_id: source || null,
      status: st.status ?? "unknown",
      new_schedule_id: newId > 0 ? newId : null,
      bookings_copied: copiedRows.length,
      bookings_skipped: bookings.length - copiedRows.length,
      amount_charged: Math.round(copiedRows.reduce((a, b) => a + (Number(b.amount_charged) || 0), 0) * 100) / 100,
      error: failedStep ? stepError(st) : null,
      ...(failedStep ? { retryable: temporary && noteTemporaryFailure(auth.company, source, toInt(job.id) || jobId) } : {}),
    };
  });
  const completed = classes.filter((c) => c.status === "completed").length;
  const failed = classes.filter((c) => c.status === "failed" || c.status === "cancelled").length;
  const waiting = classes.length - completed - failed;
  const status = job.status ?? "unknown";
  const result: CopyJobResult = {
    job_id: toInt(job.id) || jobId,
    status,
    created_at: job.created_at ?? null,
    finished_at: job.finished_at ?? null,
    totals: { classes: classes.length, completed, failed, waiting },
    classes,
    next:
      waiting > 0
        ? "Still copying. Do not start this copy again; check again in a minute."
        : failed > 0
          ? failedNext(classes.filter((c) => c.status === "failed" || c.status === "cancelled"))
          : "Done. classes_show_copy_progress with the two billing periods shows what is left to copy.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function stepError(st: RawJobStep): string {
  const key = st.error_key ?? "unknown_error";
  const data = st.error_data;
  if (data === null || data === undefined || data === "") return key;
  return `${key}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
}

/** Same rule as classes_copy_class's apply (copy-retry-ledger.ts, owner decision 2026-11-22). */
function failedNext(failed: CopyJobResult["classes"]): string {
  const again = failed.filter((c) => c.retryable).map((c) => c.source_schedule_id);
  const ask = failed.filter((c) => !c.retryable).map((c) => c.source_schedule_id);
  const parts = ["Each failed class has no half-made copy."];
  if (again.length > 0) {
    parts.push(
      `Class ${again.join(", ")} failed with a temporary error (retryable: true). The operator already approved this copy: ` +
        "preview exactly those classes again with classes_copy_class, same settings, and apply once more without asking again.",
    );
  }
  if (ask.length > 0) {
    parts.push(
      `Class ${ask.join(", ")}: tell the operator why it failed (error) and let them decide; do not repeat a retryable: false class unchanged.`,
    );
  }
  return parts.join(" ");
}
