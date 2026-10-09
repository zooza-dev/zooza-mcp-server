import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import type { ApiListResponse } from "./types.js";
import { zoozaFetch } from "../zooza.js";
import { pickStr, unwrapList } from "./common.js";

// Registration extra fields (custom booking-form questions) for bookings_find —
// issues #6, #16, #32.
//
// Values live PER REGISTRATION as ef_extra_field_1..15 in every advanced_search row
// (common.php:8174-8188). Labels and choice options live PER COURSE, not per
// company: the same slot means different things in different programmes, and
// choice option keys differ too (extra_fields_courses; served as `extra_fields[]`
// on GET /courses, Collection/Courses.php:90-150). A choice field's row value is
// the option KEY ("A"), so we map it to the option's text via field_options.items.
//
// Verified live on api-test 2026-10-09: course 1002 → extra_field_1
// {type:"choice", items:[{key:"A",value:"A value"},…]}; reg 51911 → ef_extra_field_1 "A".

const SLOTS = Array.from({ length: 15 }, (_, i) => `extra_field_${i + 1}`);

interface RawExtraFieldDef {
  column_name?: string;
  custom_label?: string | null;
  name?: string;
  /** null, "null", [] or {type:"text"|"choice", items:[{key,value}]} — all seen in prod. */
  field_options?: unknown;
}

interface RawCourseWithExtraFields {
  id?: number;
  extra_fields?: RawExtraFieldDef[];
}

interface FieldDef {
  label: string;
  /** choice key → option text; absent for text fields. */
  options?: Map<string, string>;
}

/** course_id → column_name → definition. */
export type ExtraFieldDefs = Map<number, Map<string, FieldDef>>;

export interface ExtraFieldValue {
  field: string;
  label: string;
  value: string;
}

export function buildExtraFieldDefs(courses: RawCourseWithExtraFields[]): ExtraFieldDefs {
  const defs: ExtraFieldDefs = new Map();
  for (const c of courses) {
    if (typeof c.id !== "number") continue;
    const byColumn = new Map<string, FieldDef>();
    for (const f of c.extra_fields ?? []) {
      const column = pickStr(f.column_name);
      if (!column || !SLOTS.includes(column)) continue;
      byColumn.set(column, {
        label: pickStr(f.custom_label) ?? pickStr(f.name) ?? column,
        options: choiceOptions(f.field_options),
      });
    }
    defs.set(c.id, byColumn);
  }
  return defs;
}

function choiceOptions(raw: unknown): Map<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fo = raw as { type?: unknown; items?: unknown };
  if (fo.type !== "choice" || !Array.isArray(fo.items)) return undefined;
  const map = new Map<string, string>();
  for (const item of fo.items as Array<{ key?: unknown; value?: unknown }>) {
    const key = item?.key === undefined || item?.key === null ? undefined : String(item.key);
    const text = pickStr(item?.value);
    // First match wins — mirrors api-v1's get_extra_field_value_by_key
    // (common.php:10471-10493) when a course defines duplicate keys.
    if (key !== undefined && text && !map.has(key)) map.set(key, text);
  }
  return map;
}

/** Filled extra fields of one registration row, labelled with its course's
 *  definitions. A slot with no definition (course not fetched, field since
 *  removed) still comes back, labelled by its column name. */
export function projectExtraFields(
  row: Record<string, unknown>,
  courseId: number,
  defs: ExtraFieldDefs,
): ExtraFieldValue[] {
  const courseDefs = defs.get(courseId);
  const out: ExtraFieldValue[] = [];
  for (const slot of SLOTS) {
    const raw = row[`ef_${slot}`];
    const value = typeof raw === "number" ? String(raw) : pickStr(raw);
    if (value === undefined) continue;
    const def = courseDefs?.get(slot);
    out.push({ field: slot, label: def?.label ?? slot, value: def?.options?.get(value) ?? value });
  }
  return out;
}

/** One GET /courses for every course in the page. No `archive` param: absent, the
 *  collection applies no archive filter (Courses.php:417-420 only adds one when
 *  sent), so archived programmes that old bookings point at are included. */
export async function fetchExtraFieldDefs(
  courseIds: number[],
  auth: ZoozaAuth,
  companyId: number,
): Promise<ExtraFieldDefs> {
  const ids = [...new Set(courseIds.filter((id) => id > 0))];
  if (ids.length === 0) return new Map();
  const raw = await zoozaFetch<ApiListResponse<RawCourseWithExtraFields> | RawCourseWithExtraFields[]>(
    "/courses",
    // ids filter: Collection/Courses.php:293-311 (pipe-separated).
    { query: { ids: ids.join("|"), page_size: ids.length } },
    withCompany(auth, companyId),
  );
  return buildExtraFieldDefs(unwrapList(raw).records);
}
