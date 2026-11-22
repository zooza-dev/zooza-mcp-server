/**
 * Session planner for classes_copy_class (spec ZMCP-20261122-001, "Planner rules").
 *
 * Pure: no I/O. Turns a source class's sessions plus the operator's choices into the
 * explicit `events[]` api-v1's copy job takes. Kept separate so the date logic is tested
 * on its own, and so it exists before api-v1's copy endpoint does.
 *
 * Why the MCP plans the dates instead of api-v1's `events_generator`: the generator can
 * only skip whole categories of holidays. The owner's rule is a decision per holiday —
 * skip, run as normal, or exchange for another date (owner, 2026-11-21).
 *
 * Why not shift dates by a fixed offset (what the app and `Schedule::duplicate` do):
 * a shift replays last term's holiday gaps onto the wrong weeks of the new term.
 */

export type HolidayAction = "skip" | "run" | "exchange";

export interface SourceSession {
  /** "YYYY-MM-DD HH:MM[:SS]" as api-v1 returns `events.date`. */
  date: string;
  duration: number;
  /** `status = unplanned`. */
  cancelled: boolean;
  /** `is_custom_replacement_event` — stands in for a cancelled session, not a term slot of its own. */
  replacement: boolean;
  /** Block names, in api-v1 order. */
  blocks: string[];
  /** `events.billable`. Optional: absent reads as false, as api-v1 stores it. */
  billable?: boolean;
}

export interface Holiday {
  id: number;
  name: string;
  /** YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
}

export interface HolidayDecision {
  holiday_id: number;
  action: HolidayAction;
  exchange_date?: string;
}

export interface PlanInput {
  sessions: SourceSession[];
  session_count: number | "same_as_source";
  /** Target billing period range; start anchors the default first session. */
  period_start: string;
  period_end: string | null;
  /** YYYY-MM-DD: this class's exact first session; moves its weekday. */
  first_session_on?: string;
  /** YYYY-MM-DD: no session before this date; the class keeps its weekday. Default period_start.
   *  The chunk-wide date is this, not first_session_on: "the term starts in the first week of
   *  February" moved every class to Monday when it was read as an exact date (live, 2026-11-22). */
  not_before?: string;
  /** HH:MM applied to every session. */
  time?: string;
  holidays: Holiday[];
  decisions: HolidayDecision[];
}

export interface PlannedEvent {
  date: string;
  time: string;
  duration: number;
  blocks: string[];
  /** Taken by position from the source, like blocks (api-v1 owner ruling, 2026-11-22). */
  billable: boolean;
  /** By position too: a session cancelled in the source stays cancelled (api-v1 owner ruling,
   *  2026-11-22, events[].status). Sessions past the source's count are scheduled. */
  status: "scheduled" | "unplanned";
}

export interface HolidayHit {
  holiday_id: number;
  name: string;
  start: string;
  end: string;
  single_day: boolean;
  dates: string[];
  decision: HolidayAction | null;
}

export type PlanFlag =
  | "irregular_pattern"
  | "ends_after_period"
  | "blocks_extended"
  | "block_weekday_mix"
  /** A block has fewer sessions than in the source (a smaller session_count cuts the last ones). */
  | "blocks_shortened"
  /** No weekly pattern, and a fixed session_count: run weekly from the first source session. */
  | "irregular_made_weekly"
  /** No weekly pattern: dates added a week apart after the last shifted one, to keep the count. */
  | "irregular_extended_weekly"
  | "no_source_sessions";

export interface PlanResult {
  events: PlannedEvent[];
  /** null when the source has no planned sessions. */
  pattern: { interval_days: number; slots: Array<{ weekday: string; time: string; duration: number }> } | null;
  hits: HolidayHit[];
  /** Holidays that hit a planned date and have no decision: no token until these are decided. */
  undecided: number[];
  flags: PlanFlag[];
  cancelled_in_source: number;
  block_counts: Array<{ name: string; source_count: number; new_count: number }>;
  /** Validation problems with the operator's input; the caller refuses to preview. */
  errors: string[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
/** Hard stop for the date walk, so a bad decision set can never loop forever. */
const MAX_WALK = 400;

function toDays(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDays(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function weekday(days: number): number {
  // 1970-01-01 (day 0) was a Thursday.
  return (((days + 4) % 7) + 7) % 7;
}

function hhmm(date: string): string {
  return date.length >= 16 ? date.slice(11, 16) : "00:00";
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

interface Slot {
  /** Days after the pattern's first weekday, 0..6. */
  offset: number;
  time: string;
  duration: number;
}

/**
 * Weekly (or fortnightly) slots, or null when the dates fit no such pattern.
 * Gaps that are whole multiples of the interval are fine: those are the source's own
 * holidays and cancellations, not a different pattern.
 */
function inferPattern(planned: SourceSession[]): { interval: number; slots: Slot[]; firstWeekday: number } | null {
  if (planned.length === 0) return null;
  const first = toDays(planned[0].date);
  const firstWeekday = weekday(first);
  const bySlot = new Map<string, { slot: Slot; days: number[] }>();
  for (const s of planned) {
    const d = toDays(s.date);
    const slot: Slot = { offset: (weekday(d) - firstWeekday + 7) % 7, time: hhmm(s.date), duration: s.duration };
    const key = `${slot.offset}|${slot.time}|${slot.duration}`;
    const entry = bySlot.get(key) ?? { slot, days: [] };
    entry.days.push(d);
    bySlot.set(key, entry);
  }
  let interval = 0;
  for (const { days } of bySlot.values()) {
    for (let i = 1; i < days.length; i++) interval = gcd(interval, days[i] - days[i - 1]);
  }
  // One session only: treat as weekly, there is nothing to contradict it.
  if (interval === 0) interval = 7;
  if (interval !== 7 && interval !== 14) return null;
  // A slot that occurs once while others repeat is an ad-hoc date, not part of a pattern.
  const counts = [...bySlot.values()].map((e) => e.days.length);
  if (counts.length > 1 && Math.min(...counts) === 1 && Math.max(...counts) > 2) return null;
  // Every slot must start within the first interval: one that first appears weeks later
  // (an added day mid-term, a string of one-off dates) is not a repeating week.
  for (const { days } of bySlot.values()) {
    if (days[0] - first >= interval) return null;
  }
  const slots = [...bySlot.values()]
    .map((e) => e.slot)
    .sort((a, b) => a.offset - b.offset || a.time.localeCompare(b.time));
  return { interval, slots, firstWeekday };
}

function holidaysOn(holidays: Holiday[], day: number): Holiday[] {
  return holidays.filter((h) => toDays(h.start) <= day && day <= toDays(h.end));
}

export function planSessions(input: PlanInput): PlanResult {
  const errors: string[] = [];
  const flags = new Set<PlanFlag>();
  const sorted = [...input.sessions].sort((a, b) => a.date.localeCompare(b.date));
  // Replacements stand in for a cancelled slot; the term's length is its planned slots.
  const planned = sorted.filter((s) => !s.replacement);
  const cancelled_in_source = planned.filter((s) => s.cancelled).length;

  const empty: PlanResult = {
    events: [], pattern: null, hits: [], undecided: [], flags: [], cancelled_in_source,
    block_counts: [], errors,
  };
  if (planned.length === 0) {
    empty.flags = ["no_source_sessions"];
    return empty;
  }

  const count = input.session_count === "same_as_source" ? planned.length : input.session_count;
  if (!Number.isInteger(count) || count < 1) {
    errors.push("session_count must be a whole number of at least 1, or same_as_source.");
    return empty;
  }
  if (input.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    errors.push(`time "${input.time}" is not HH:MM.`);
    return empty;
  }

  const decisions = new Map(input.decisions.map((d) => [d.holiday_id, d]));
  for (const d of input.decisions) {
    const h = input.holidays.find((x) => x.id === d.holiday_id);
    if (d.action === "exchange") {
      if (!d.exchange_date) errors.push(`Holiday ${d.holiday_id}: exchange needs an exchange_date.`);
      if (h && h.start !== h.end) {
        const days = toDays(h.end) - toDays(h.start) + 1;
        errors.push(`${h.name} lasts ${days} days: choose skip or run. Exchange is for a single-day holiday.`);
      }
    } else if (d.exchange_date) {
      errors.push(`Holiday ${d.holiday_id}: exchange_date is only used with action "exchange".`);
    }
  }
  if (errors.length > 0) return empty;

  const firstSourceDay = toDays(planned[0].date);
  let pattern = inferPattern(planned);
  if (!pattern && typeof input.session_count === "number") {
    // A fixed count means "this many sessions", not "this many of last term's odd dates":
    // shifting kept the source's gaps and spread 12 sessions over a year (live, local
    // class 6779, 2026-11-22). Run weekly on the first source session's weekday and time.
    pattern = {
      interval: 7,
      slots: [{ offset: 0, time: hhmm(planned[0].date), duration: planned[0].duration }],
      firstWeekday: weekday(firstSourceDay),
    };
    flags.add("irregular_made_weekly");
  }

  // Candidate dates in order, each with the time/duration it runs at.
  const candidates: Array<{ day: number; time: string; duration: number; extra?: boolean }> = [];
  let anchorWeekday = 0;
  if (pattern) {
    const from = Math.max(toDays(input.period_start), input.not_before ? toDays(input.not_before) : -Infinity);
    let anchor: number;
    if (input.first_session_on) {
      // An explicit first date moves the whole pattern to its weekday.
      anchor = toDays(input.first_session_on);
    } else {
      anchor = from + ((pattern.firstWeekday - weekday(from) + 7) % 7);
    }
    anchorWeekday = weekday(anchor);
    for (let week = 0; candidates.length < MAX_WALK; week++) {
      for (const slot of pattern.slots) {
        candidates.push({
          day: anchor + week * pattern.interval + slot.offset,
          time: input.time ?? slot.time,
          duration: slot.duration,
        });
      }
    }
  } else {
    flags.add("irregular_pattern");
    // No pattern: shift every source date by whole weeks, so weekdays are kept.
    const target = input.first_session_on
      ? toDays(input.first_session_on)
      : Math.max(toDays(input.period_start), input.not_before ? toDays(input.not_before) : -Infinity);
    const weeks = Math.ceil((target - firstSourceDay) / 7);
    for (const s of planned) {
      candidates.push({ day: toDays(s.date) + weeks * 7, time: input.time ?? hhmm(s.date), duration: s.duration });
    }
    // A skipped holiday must not cost the class a session (the skill promises "one is
    // added at the end"): continue a week apart after the last shifted date, at its time.
    const shifted = candidates.length;
    const last = candidates[shifted - 1];
    for (let k = 1; candidates.length < shifted + MAX_WALK; k++) {
      candidates.push({ day: last.day + 7 * k, time: last.time, duration: last.duration, extra: true });
    }
  }

  const hits = new Map<number, HolidayHit>();
  const undecided = new Set<number>();
  const chosen: Array<{ day: number; time: string; duration: number; exchanged?: boolean; extra?: boolean }> = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    // Holidays overlap (Good Friday inside the Easter break): the date is a hit for each,
    // and every one of them needs a decision.
    const covering = holidaysOn(input.holidays, c.day);
    if (covering.length === 0) {
      chosen.push(c);
      continue;
    }
    // Skip wins over every other decision, so a date another holiday already skips needs no
    // further decision: Good Friday inside an Easter break the operator skipped was asked
    // about separately (live, 2026-11-22), and the model answered it on their behalf.
    const skippedBy = covering.find((h) => decisions.get(h.id)?.action === "skip");
    let anyUndecided = false;
    for (const h of skippedBy ? covering.filter((x) => decisions.has(x.id)) : covering) {
      const decision = decisions.get(h.id);
      const hit = hits.get(h.id) ?? {
        holiday_id: h.id, name: h.name, start: h.start, end: h.end,
        single_day: h.start === h.end, dates: [], decision: decision?.action ?? null,
      };
      hit.dates.push(fromDays(c.day));
      hits.set(h.id, hit);
      if (!decision) {
        undecided.add(h.id);
        anyUndecided = true;
      }
    }
    if (anyUndecided) {
      // Hold the date for now so the walk is stable; no token is issued anyway.
      chosen.push(c);
      continue;
    }
    if (skippedBy) continue; // dropped; the walk keeps the count
    // Precedence when overlapping holidays disagree: skip > exchange > run.
    const actions = covering.map((h) => decisions.get(h.id)!);
    if (actions.some((d) => d.action === "skip")) continue; // dropped; the walk keeps the count
    const exchange = actions.find((d) => d.action === "exchange");
    chosen.push(exchange ? { ...c, day: toDays(exchange.exchange_date!), exchanged: true } : c);
  }

  if (chosen.some((c) => c.extra)) flags.add("irregular_extended_weekly");
  if (!pattern && chosen.length < count) {
    // Unreachable in practice since the weekly extension; kept as a guard for a decision
    // set that skips (almost) every date for MAX_WALK weeks.
    errors.push(
      `Only ${chosen.length} of ${count} sessions could be planned: the skipped holidays cover the rest. ` +
        "Run some of those holidays instead, or copy this class on its own with a smaller session_count.",
    );
  }

  // Exchange dates must not collide with another session or land in a holiday. Only an
  // exchanged date is checked: a source with two sessions on one day (live, local class
  // 6766) is copied as it is, and that is not the operator's mistake to fix.
  const reported = new Set<number>();
  for (const c of chosen) {
    if (!c.exchanged || reported.has(c.day)) continue;
    if (chosen.some((o) => o !== c && o.day === c.day)) {
      errors.push(`${fromDays(c.day)} would hold two sessions; pick another exchange date.`);
      reported.add(c.day);
    }
  }
  for (const d of input.decisions) {
    if (d.action !== "exchange" || !d.exchange_date || !hits.has(d.holiday_id)) continue;
    const other = holidaysOn(input.holidays, toDays(d.exchange_date))[0];
    if (other) errors.push(`${d.exchange_date} is inside ${other.name}; pick another exchange date.`);
  }

  // Blocks and billable by position: new session i takes source session i's (owner,
  // 2026-11-21; billable: api-v1 owner ruling 2026-11-22, events[].billable). Sessions
  // past the source's count take the last source session's.
  const events: PlannedEvent[] = chosen.map((c, i) => {
    const src = planned[Math.min(i, planned.length - 1)];
    if (i >= planned.length && src.blocks.length > 0) flags.add("blocks_extended");
    return {
      date: fromDays(c.day), time: c.time, duration: c.duration, blocks: [...src.blocks], billable: src.billable === true,
      status: i < planned.length && planned[i].cancelled ? ("unplanned" as const) : ("scheduled" as const),
    };
  });
  events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const lastDay = events.length ? toDays(events[events.length - 1].date) : null;
  if (input.period_end && lastDay !== null && lastDay > toDays(input.period_end)) flags.add("ends_after_period");

  const names = new Set([...planned.flatMap((s) => s.blocks), ...events.flatMap((e) => e.blocks)]);
  const block_counts = [...names].map((name) => ({
    name,
    source_count: planned.filter((s) => s.blocks.includes(name)).length,
    new_count: events.filter((e) => e.blocks.includes(name)).length,
  }));
  if (block_counts.some((b) => b.new_count < b.source_count)) flags.add("blocks_shortened");
  for (const name of names) {
    const before = new Set(planned.filter((s) => s.blocks.includes(name)).map((s) => weekday(toDays(s.date))));
    const after = new Set(events.filter((e) => e.blocks.includes(name)).map((e) => weekday(toDays(e.date))));
    if (before.size === 1 && after.size > 1) flags.add("block_weekday_mix");
  }

  return {
    events,
    pattern: pattern
      ? {
          interval_days: pattern.interval,
          slots: pattern.slots.map((s) => ({
            weekday: WEEKDAYS[(anchorWeekday + s.offset) % 7],
            time: input.time ?? s.time,
            duration: s.duration,
          })),
        }
      : null,
    hits: [...hits.values()],
    undecided: [...undecided],
    flags: [...flags],
    cancelled_in_source,
    block_counts,
    errors,
  };
}
