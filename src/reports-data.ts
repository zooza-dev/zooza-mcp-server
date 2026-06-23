import type { ZoozaAuth } from "./auth/types.js";
import { zoozaFetch } from "./zooza.js";

/**
 * Report data layer (spec ZMCP-20260612-003 — LLM-composed reports).
 *
 * The single source of REAL numbers for client reports. The LLM never invents data:
 * it calls reports_get_data, which fetches the api-v1 business_dashboard payload and
 * returns a FOCUSED, pre-aggregated slice for the asked question — headline figures
 * computed here (server-side), plus chart-ready rows and a data-aware caption. The LLM
 * only composes presentation around these values. Aggregation mirrors the artifact's
 * AGG config (docs/business-dashboard-api-contract.md): SUM for flow, LAST for stock.
 */

export interface MonthRange {
  from: string;
  to: string;
}

interface RawRow {
  period: string;
  [k: string]: unknown;
}

interface NamesMap {
  companies?: Record<string, string>;
  courses?: Record<string, string>;
  places?: Record<string, string>;
  schedules?: Record<string, string>;
  instructors?: Record<string, string>;
  currency?: string | null;
}

interface DashboardPayload {
  periods?: string[];
  companyAll?: RawRow[];
  coursesAll?: RawRow[];
  locationsAll?: RawRow[];
  schedulesAll?: RawRow[];
  instructorsAll?: RawRow[];
  trialsAll?: RawRow[];
  retentionAll?: RawRow[];
  registrationsAll?: Array<{ user_id: number; created: string; course_id: number }>;
  names?: NamesMap;
}

export interface FocusResult {
  view: string;
  question: string;
  period: MonthRange;
  currency: string;
  /** Computed headline figures — render these verbatim, never recompute. */
  headline: Record<string, number | string>;
  /** Chart/table-ready rows (named, capped). */
  rows: Array<Record<string, number | string>>;
  /** Data-aware caption computed server-side (safe to show as-is). */
  note: string;
  /** True when `rows` was capped — tell the user there are more. */
  truncated: boolean;
}

const ROW_CAP = 25;
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€", CZK: "Kč", GBP: "£", HUF: "Ft", RON: "lei", PLN: "zł", USD: "$",
};

// ── AGG config — verbatim from artifacts/business-dashboard.html (keep in sync) ──
const AGG = {
  company: {
    sum: ["received_payments", "net_revenue", "new_enrollments", "active_schedules", "cash_payments_sum", "cash_payments_count", "card_payments_sum", "card_payments_count", "transfer_payments_sum", "transfer_payments_count", "direct_debit_sum", "direct_debit_count", "refunds", "discounts"],
    last: ["current_enrollments", "enrollments", "cancellations", "unpaid_enrollments", "unpaid_debt"],
  },
  course: {
    sum: ["new_enrollments", "sessions", "sessions_with_attendance", "received_payments", "net_revenue", "active_schedules", "active_locations", "instructors"],
    last: ["current_enrollments", "enrollments", "cancellations", "churn_rate", "capacity"],
  },
  location: {
    sum: ["received_payments", "net_revenue", "new_enrollments", "sessions", "instructors"],
    last: ["enrollments", "cancellations", "current_enrollments", "active_courses", "churn_rate"],
  },
  schedule: {
    sum: ["new_enrollments", "sessions", "sessions_with_attendance", "received_payments", "net_revenue", "instructors"],
    last: ["current_enrollments", "enrollments", "cancellations", "unpaid_enrollments", "churn_rate", "capacity"],
  },
  instructor: {
    sum: ["new_enrollments", "sessions", "sessions_with_attendance", "received_payments", "net_revenue", "active_schedules"],
    last: ["current_enrollments", "enrollments", "cancellations", "churn_rate"],
  },
  trial: { sum: ["trial_started", "trial_ended", "trial_won", "trial_lost"], last: [] },
} as const;

// ── upstream fetch ──────────────────────────────────────────────────────────

export function defaultRange(): MonthRange {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return { from: fmt(from), to: fmt(to) };
}

export async function fetchBusinessDashboard(
  auth: ZoozaAuth,
  range: MonthRange,
): Promise<DashboardPayload> {
  return zoozaFetch<DashboardPayload>(
    "/reports/business_dashboard",
    { query: { from: range.from, to: range.to } },
    auth,
  );
}

// ── replacements (make-up credit demand vs supply) ────────────────────────────
// Separate api-v1 endpoint (GET /credits?action=demand_supply): a live,
// point-in-time picture — NOT month-ranged like business_dashboard. Demand =
// unused, non-expired make-up/free credits per programme; supply = available
// slots in that programme's eligible upcoming events. Spec SDD-20260520-001.

interface DemandSupplyCourse {
  course_id: number;
  course_name: string;
  scope_type: string | null;
  flags: { waitlist_enabled: boolean; custom_replacements_enabled: boolean };
  demand: { total_credits: number; expiring_7d: number; expiring_30d: number };
  supply: { total_available_slots: number; events_with_slots: number };
  ratio: number | null;
  status: string;
  hotspot_count: number;
}

interface DemandSupplyPayload {
  company_id: number;
  calculated_at?: string;
  is_live?: boolean;
  summary: {
    total_unused_credits: number;
    total_available_slots: number;
    overall_ratio: number;
    overall_status: string;
    expiring_7d: number;
    expiring_30d: number;
  };
  courses: DemandSupplyCourse[];
}

export async function fetchDemandSupply(auth: ZoozaAuth): Promise<DemandSupplyPayload> {
  return zoozaFetch<DemandSupplyPayload>(
    "/credits",
    { query: { action: "demand_supply" } },
    auth,
  );
}

/**
 * Focus the make-up demand/supply payload into the standard report shape.
 * Point-in-time (live), so `period` is carried only for shape compatibility —
 * the note states it is "as of now".
 */
export function focusReplacements(payload: DemandSupplyPayload, range: MonthRange): FocusResult {
  const s = payload.summary ?? {
    total_unused_credits: 0, total_available_slots: 0, overall_ratio: 0,
    overall_status: "no_demand", expiring_7d: 0, expiring_30d: 0,
  };
  const courses = payload.courses ?? [];
  const ranked = [...courses].sort((a, b) => (n(b.ratio) - n(a.ratio)));
  const allRows = ranked.map((c) => ({
    programme: c.course_name || `#${c.course_id}`,
    unused_credits: n(c.demand?.total_credits),
    available_slots: n(c.supply?.total_available_slots),
    ratio: n(c.ratio),
    status: c.status,
    expiring_7d: n(c.demand?.expiring_7d),
    hotspots: n(c.hotspot_count),
  }));
  const tight = courses.filter((c) => c.status === "oversaturated" || c.status === "tight").length;

  return {
    view: "replacements",
    question: QUESTIONS.replacements,
    period: range,
    currency: "",
    headline: {
      total_unused_credits: s.total_unused_credits,
      total_available_slots: s.total_available_slots,
      overall_ratio: s.overall_ratio,
      overall_status: s.overall_status,
      expiring_7d: s.expiring_7d,
      tight_or_oversaturated_programmes: tight,
    },
    rows: allRows.slice(0, ROW_CAP),
    note: courses.length
      ? `As of now (live): ${s.total_unused_credits} unused make-up credits vs ${s.total_available_slots} available slots — ratio ${s.overall_ratio} (${s.overall_status}). ${s.expiring_7d} expire within 7 days; ${tight} programme(s) tight or oversaturated.`
      : "No outstanding make-up credits — clients have nothing pending to redeem.",
    truncated: allRows.length > ROW_CAP,
  };
}

// ── aggregation (mirrors the artifact) ────────────────────────────────────────

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function inRange(rows: RawRow[], r: MonthRange): RawRow[] {
  return (rows || []).filter((x) => x.period >= r.from && x.period <= r.to);
}

/** Group by id; SUM flow keys across the range, take LAST (max-period) row for stock keys. */
function aggregateGrouped(
  rows: RawRow[],
  idKey: string,
  sumKeys: readonly string[],
  lastKeys: readonly string[],
): Array<Record<string, number | string>> {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const id = String(row[idKey]);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(row);
  }
  const out: Array<Record<string, number | string>> = [];
  for (const [id, grp] of groups) {
    grp.sort((a, b) => (a.period < b.period ? -1 : 1));
    const last = grp[grp.length - 1];
    const agg: Record<string, number | string> = { [idKey]: id };
    for (const k of sumKeys) agg[k] = grp.reduce((s, x) => s + n(x[k]), 0);
    for (const k of lastKeys) agg[k] = n(last[k]);
    out.push(agg);
  }
  return out;
}

function aggregateCompany(
  rows: RawRow[],
  sumKeys: readonly string[],
  lastKeys: readonly string[],
): Record<string, number> {
  const sorted = [...rows].sort((a, b) => (a.period < b.period ? -1 : 1));
  const last = sorted[sorted.length - 1] ?? {};
  const agg: Record<string, number> = {};
  for (const k of sumKeys) agg[k] = sorted.reduce((s, x) => s + n(x[k]), 0);
  for (const k of lastKeys) agg[k] = n(last[k]);
  return agg;
}

// ── focused builders — one per client question ────────────────────────────────

const QUESTIONS: Record<string, string> = {
  occupancy: "Which classes have empty seats?",
  unpaid: "Where is money outstanding?",
  churn: "Where are members leaving?",
  attendance: "Which classes have the lowest attendance?",
  trials: "How are trials converting?",
  retention: "Are my clients coming back?",
  clients_by_location: "How many clients do I have at each venue?",
  replacements: "Can clients use their make-up credits, or are we overloaded?",
  summary: "How is my business doing overall?",
};

export function focusReport(
  payload: DashboardPayload,
  view: string,
  range: MonthRange,
): FocusResult {
  const names = payload.names ?? {};
  const currency = CURRENCY_SYMBOLS[names.currency ?? "EUR"] ?? names.currency ?? "€";
  const nm = (map: Record<string, string> | undefined, id: unknown) =>
    (map && map[String(id)]) || `#${id}`;
  const courseName = (id: unknown) => nm(names.courses, id);
  const placeName = (id: unknown) => nm(names.places, id);
  const schedName = (id: unknown) => nm(names.schedules, id);

  const base = { view, question: QUESTIONS[view] ?? QUESTIONS.summary, period: range, currency };
  const cap = <T,>(arr: T[]): { rows: T[]; truncated: boolean } => ({
    rows: arr.slice(0, ROW_CAP),
    truncated: arr.length > ROW_CAP,
  });

  const schedules = aggregateGrouped(inRange(payload.schedulesAll ?? [], range), "schedule_id", AGG.schedule.sum, AGG.schedule.last);
  // carry course_id (it's stable per schedule) for labels
  const schedCourse = new Map<string, unknown>();
  for (const r of payload.schedulesAll ?? []) schedCourse.set(String(r.schedule_id), r.course_id);

  if (view === "occupancy") {
    const withCap = schedules.filter((s) => n(s.capacity) > 0);
    const totEnr = withCap.reduce((s, r) => s + n(r.current_enrollments), 0);
    const totCap = withCap.reduce((s, r) => s + n(r.capacity), 0);
    const occ = totCap ? totEnr / totCap : 0;
    const rows = withCap
      .map((r) => ({
        name: schedName(r.schedule_id),
        programme: courseName(schedCourse.get(String(r.schedule_id))),
        filled: n(r.current_enrollments),
        capacity: n(r.capacity),
        occupancy_pct: n(r.capacity) ? Math.round((n(r.current_enrollments) / n(r.capacity)) * 100) : 0,
      }))
      .sort((a, b) => a.occupancy_pct - b.occupancy_pct);
    const under70 = rows.filter((r) => r.occupancy_pct < 70).length;
    const c = cap(rows);
    return {
      ...base,
      headline: {
        overall_occupancy_pct: Math.round(occ * 100),
        total_filled: totEnr,
        total_capacity: totCap,
        classes_under_70pct: under70,
        class_count: rows.length,
      },
      rows: c.rows,
      note: rows.length
        ? `Overall occupancy is ${Math.round(occ * 100)}% — ${totEnr} of ${totCap} seats filled. ${under70} of ${rows.length} classes are under 70% full.`
        : "No class capacity data for this period.",
      truncated: c.truncated,
    };
  }

  if (view === "unpaid") {
    const rows = schedules
      .filter((r) => n(r.unpaid_enrollments) > 0)
      .map((r) => ({
        name: schedName(r.schedule_id),
        programme: courseName(schedCourse.get(String(r.schedule_id))),
        enrollments: n(r.enrollments),
        unpaid: n(r.unpaid_enrollments),
      }))
      .sort((a, b) => b.unpaid - a.unpaid);
    const total = rows.reduce((s, r) => s + r.unpaid, 0);
    const c = cap(rows);
    return {
      ...base,
      headline: { total_unpaid_enrollments: total, classes_with_unpaid: rows.length },
      rows: c.rows,
      note: total
        ? `${total} unpaid bookings across ${rows.length} classes. Start at the top of the list.`
        : "Every booking is paid — nothing outstanding.",
      truncated: c.truncated,
    };
  }

  if (view === "churn") {
    const rows = schedules
      .filter((r) => n(r.churn_rate) > 0)
      .map((r) => ({
        name: schedName(r.schedule_id),
        programme: courseName(schedCourse.get(String(r.schedule_id))),
        enrollments: n(r.enrollments),
        cancellations: n(r.cancellations),
        churn_pct: Math.round(n(r.churn_rate) * 1000) / 10,
      }))
      .sort((a, b) => b.churn_pct - a.churn_pct);
    const high = rows.filter((r) => r.churn_pct > 25).length;
    const c = cap(rows);
    return {
      ...base,
      headline: { classes_with_churn: rows.length, classes_over_25pct: high },
      rows: c.rows,
      note: rows.length
        ? `${high} classes are losing members faster than 25%. Focus retention there.`
        : "No cancellations this period — retention looks solid.",
      truncated: c.truncated,
    };
  }

  if (view === "attendance") {
    const rows = schedules
      .filter((r) => n(r.sessions) > 0)
      .map((r) => ({
        name: schedName(r.schedule_id),
        programme: courseName(schedCourse.get(String(r.schedule_id))),
        sessions: n(r.sessions),
        attendance_pct: Math.round((n(r.sessions_with_attendance) / n(r.sessions)) * 100),
      }))
      .sort((a, b) => a.attendance_pct - b.attendance_pct);
    const low = rows.filter((r) => r.attendance_pct < 60).length;
    const c = cap(rows);
    return {
      ...base,
      headline: { classes_with_sessions: rows.length, classes_under_60pct: low },
      rows: c.rows,
      note: rows.length
        ? `${low} classes are below 60% attendance — that's where people stop showing up.`
        : "No sessions with attendance recorded yet.",
      truncated: c.truncated,
    };
  }

  if (view === "clients_by_location") {
    const locs = aggregateGrouped(inRange(payload.locationsAll ?? [], range), "place_id", AGG.location.sum, AGG.location.last);
    const rows = locs
      .filter((r) => n(r.current_enrollments) > 0)
      .map((r) => ({
        name: placeName(r.place_id),
        clients: n(r.current_enrollments),
        programmes: n(r.active_courses),
      }))
      .sort((a, b) => b.clients - a.clients);
    const total = rows.reduce((s, r) => s + r.clients, 0);
    const c = cap(rows);
    return {
      ...base,
      headline: { total_clients: total, venue_count: rows.length },
      rows: c.rows,
      note: rows.length
        ? `${total} active enrollments across ${rows.length} venues.`
        : "No active clients at any venue this period.",
      truncated: c.truncated,
    };
  }

  if (view === "trials") {
    const trials = aggregateGrouped(inRange(payload.trialsAll ?? [], range), "course_id", AGG.trial.sum, AGG.trial.last);
    const started = trials.reduce((s, r) => s + n(r.trial_started), 0);
    const won = trials.reduce((s, r) => s + n(r.trial_won), 0);
    const lost = trials.reduce((s, r) => s + n(r.trial_lost), 0);
    const rows = trials
      .filter((r) => n(r.trial_started) > 0)
      .map((r) => ({
        programme: courseName(r.course_id),
        started: n(r.trial_started),
        won: n(r.trial_won),
        conversion_pct: n(r.trial_started) ? Math.round((n(r.trial_won) / n(r.trial_started)) * 100) : 0,
      }))
      .sort((a, b) => a.conversion_pct - b.conversion_pct);
    const c = cap(rows);
    return {
      ...base,
      headline: {
        trials_started: started,
        trials_won: won,
        trials_lost: lost,
        conversion_pct: started ? Math.round((won / started) * 100) : 0,
      },
      rows: c.rows,
      note: started
        ? `Of ${started} trials, ${won} converted — a ${Math.round((won / started) * 100)}% success rate.`
        : "No trials ran in this period.",
      truncated: c.truncated,
    };
  }

  if (view === "retention") {
    const series = inRange(payload.retentionAll ?? [], range);
    const sum = (k: string) => series.reduce((s, r) => s + n(r[k]), 0);
    const ret = sum("returning"), lost = sum("lost"), neu = sum("new"), re = sum("reactivated");
    const rate = ret + lost > 0 ? Math.round((ret / (ret + lost)) * 100) : 0;
    const rows = series.map((r) => ({
      month: String(r.period),
      returning: n(r.returning),
      reactivated: n(r.reactivated),
      new: n(r.new),
      lost: n(r.lost),
    }));
    return {
      ...base,
      headline: { retention_pct: rate, returning: ret, reactivated: re, new: neu, lost },
      rows,
      note: series.length
        ? `Period-over-period you kept ${rate}% — ${ret} continued, ${lost} lost.`
        : "No retention data for this period.",
      truncated: false,
    };
  }

  // summary / fallback — company-level KPIs
  const company = aggregateCompany(inRange(payload.companyAll ?? [], range), AGG.company.sum, AGG.company.last);
  return {
    ...base,
    view: "summary",
    question: QUESTIONS.summary,
    headline: {
      current_enrollments: company.current_enrollments ?? 0,
      new_enrollments: company.new_enrollments ?? 0,
      net_revenue: Math.round(company.net_revenue ?? 0),
      received_payments: Math.round(company.received_payments ?? 0),
      unpaid_enrollments: company.unpaid_enrollments ?? 0,
      unpaid_debt: Math.round(company.unpaid_debt ?? 0),
    },
    rows: [],
    note: `Over the selected period: ${company.new_enrollments ?? 0} new enrollments, ${currency}${Math.round(company.net_revenue ?? 0)} net revenue, ${company.unpaid_enrollments ?? 0} unpaid.`,
    truncated: false,
  };
}

export const REPORT_VIEWS = Object.keys(QUESTIONS);
