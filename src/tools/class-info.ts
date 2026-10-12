import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { zoozaFetch } from "../zooza.js";
import { scheduleTimeHHMM, unwrapList } from "./common.js";
import type { ApiListResponse, RawScheduleRecord } from "./types.js";

// When a class meets — joined onto booking rows so the model can tell "his Tuesday
// 17:00 class" from the rest without a classes_find_classes call per programme
// (evals 2026-10-12: 14–29 such calls to find one Tuesday class). advanced_search
// selects no schedule time (api-v1 common.php:8070-8140), hence the extra fetch.

export interface ClassInfo {
  class_name?: string;
  /** Weekday of the class's first session (the same "start day" classes_find_classes'
   *  `day` filter matches) — a class running on several weekdays shows the first. */
  class_weekday?: string;
  /** Start time, HH:MM. */
  class_time?: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function projectClassInfo(s: RawScheduleRecord): ClassInfo {
  const out: ClassInfo = {};
  if (s.name) out.class_name = s.name;
  // start is YYYY-MM-DD; lead pipelines carry 0000-00-00 → no weekday.
  if (typeof s.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.start) && !s.start.startsWith("0000")) {
    const day = new Date(`${s.start}T00:00:00Z`).getUTCDay();
    if (!Number.isNaN(day)) out.class_weekday = WEEKDAYS[day];
  }
  // No valid start date (lead pipelines, unscheduled shells) means time is unset
  // too — api-v1 leaves it 0, which would read as a real "00:00".
  const time = out.class_weekday ? scheduleTimeHHMM(s.time) : undefined;
  if (time) out.class_time = time;
  return out;
}

async function fetchSchedules(
  ids: number[],
  extra: Record<string, string>,
  auth: ZoozaAuth,
  companyId: number,
): Promise<RawScheduleRecord[]> {
  const raw = await zoozaFetch<ApiListResponse<RawScheduleRecord> | RawScheduleRecord[]>(
    "/schedules",
    // ids filter: Collection/Schedules.php:710-729 (pipe-separated).
    { query: { ids: ids.join("|"), page_size: ids.length, ...extra } },
    withCompany(auth, companyId),
  );
  return unwrapList(raw).records;
}

/** One GET /schedules for the page's classes; a second, archive-scoped one only
 *  for ids the first did not return (old bookings point at archived classes). */
export async function fetchClassInfo(
  scheduleIds: number[],
  auth: ZoozaAuth,
  companyId: number,
): Promise<Map<number, ClassInfo>> {
  const ids = [...new Set(scheduleIds.filter((id) => id > 0))];
  const out = new Map<number, ClassInfo>();
  if (ids.length === 0) return out;
  for (const s of await fetchSchedules(ids, {}, auth, companyId)) out.set(Number(s.id), projectClassInfo(s));
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    for (const s of await fetchSchedules(missing, { status: "archive" }, auth, companyId)) {
      out.set(Number(s.id), projectClassInfo(s));
    }
  }
  return out;
}
