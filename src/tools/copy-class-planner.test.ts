import { describe, expect, it } from "vitest";
import { planSessions, type PlanInput, type SourceSession } from "./copy-class-planner.js";

/** Weekly sessions from `first` (YYYY-MM-DD), `n` of them, at `time`. */
function weekly(first: string, n: number, time = "16:00", blocks: (i: number) => string[] = () => []): SourceSession[] {
  const start = Date.parse(first + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10) + ` ${time}:00`,
    duration: 45,
    cancelled: false,
    replacement: false,
    blocks: blocks(i),
  }));
}

function base(over: Partial<PlanInput>): PlanInput {
  return {
    sessions: weekly("2026-09-07", 12), // Mondays
    session_count: "same_as_source",
    period_start: "2027-04-01", // a Thursday
    period_end: "2027-07-02",
    holidays: [],
    decisions: [],
    ...over,
  };
}

const dates = (r: ReturnType<typeof planSessions>) => r.events.map((e) => e.date);

describe("copy-class planner — pattern and walk", () => {
  it("weekly single slot: starts on the first matching weekday on/after the period start", () => {
    const r = planSessions(base({}));
    expect(r.errors).toEqual([]);
    expect(r.pattern).toEqual({ interval_days: 7, slots: [{ weekday: "Mon", time: "16:00", duration: 45 }] });
    expect(r.events).toHaveLength(12);
    expect(r.events[0]).toEqual({ date: "2027-04-05", time: "16:00", duration: 45, blocks: [], billable: false, status: "scheduled" });
    expect(r.events[11].date).toBe("2027-06-21");
  });

  it("two slots a week (Mon 16:00 + Wed 17:00) keep their order", () => {
    const mon = weekly("2026-09-07", 4, "16:00");
    const wed = weekly("2026-09-09", 4, "17:00");
    const r = planSessions(base({ sessions: [...mon, ...wed], session_count: 4 }));
    expect(r.pattern?.slots.map((s) => `${s.weekday} ${s.time}`)).toEqual(["Mon 16:00", "Wed 17:00"]);
    expect(r.events.map((e) => `${e.date} ${e.time}`)).toEqual([
      "2027-04-05 16:00", "2027-04-07 17:00", "2027-04-12 16:00", "2027-04-14 17:00",
    ]);
  });

  it("first_session_on moves the whole pattern to that weekday, and time overrides every session", () => {
    const r = planSessions(base({ first_session_on: "2027-04-06", time: "17:30", session_count: 3 }));
    expect(r.events.map((e) => `${e.date} ${e.time}`)).toEqual([
      "2027-04-06 17:30", "2027-04-13 17:30", "2027-04-20 17:30",
    ]);
    expect(r.pattern?.slots[0].weekday).toBe("Tue");
  });

  it("source gaps from its own holidays (a 14-day gap) still read as weekly", () => {
    const s = weekly("2026-09-07", 12);
    s.splice(5, 1); // one week missing in the source
    expect(planSessions(base({ sessions: s })).pattern?.interval_days).toBe(7);
  });

  it("fortnightly classes stay fortnightly", () => {
    const start = Date.parse("2026-09-07T00:00:00Z");
    const s = Array.from({ length: 6 }, (_, i) => ({
      date: new Date(start + i * 14 * 86_400_000).toISOString().slice(0, 10) + " 10:00:00",
      duration: 60, cancelled: false, replacement: false, blocks: [],
    }));
    const r = planSessions(base({ sessions: s }));
    expect(r.pattern?.interval_days).toBe(14);
    expect(dates(r).slice(0, 2)).toEqual(["2027-04-05", "2027-04-19"]);
  });

  it("an irregular class falls back to a whole-week shift and is flagged", () => {
    const s: SourceSession[] = ["2026-09-07", "2026-09-10", "2026-09-19", "2026-10-02"].map((d) => ({
      date: d + " 10:00:00", duration: 60, cancelled: false, replacement: false, blocks: [],
    }));
    const r = planSessions(base({ sessions: s }));
    expect(r.flags).toContain("irregular_pattern");
    expect(r.pattern).toBeNull();
    expect(r.events).toHaveLength(4);
    // weekdays kept: Mon, Thu, Sat, Fri
    expect(r.events.map((e) => new Date(e.date + "T00:00:00Z").getUTCDay())).toEqual([1, 4, 6, 5]);
  });

  it("a source with no sessions plans nothing and says so", () => {
    const r = planSessions(base({ sessions: [] }));
    expect(r.events).toEqual([]);
    expect(r.flags).toEqual(["no_source_sessions"]);
  });
});

describe("copy-class planner — session count", () => {
  it("same_as_source counts planned slots: a cancelled session counts, its replacement does not", () => {
    const s = weekly("2026-09-07", 12);
    s[3].cancelled = true;
    s.push({ date: "2026-12-01 16:00:00", duration: 45, cancelled: false, replacement: true, blocks: [] });
    const r = planSessions(base({ sessions: s }));
    expect(r.events).toHaveLength(12);
    expect(r.cancelled_in_source).toBe(1);
  });

  it("an explicit count wins over the source length", () => {
    expect(planSessions(base({ session_count: 10 })).events).toHaveLength(10);
  });

  it("rejects a count below 1 and a malformed time", () => {
    expect(planSessions(base({ session_count: 0 })).errors[0]).toMatch(/session_count/);
    expect(planSessions(base({ time: "4pm" })).errors[0]).toMatch(/HH:MM/);
  });
});

describe("copy-class planner — holidays", () => {
  const easter = { id: 9031, name: "Easter Monday", start: "2027-03-29", end: "2027-03-29" };
  const whit = { id: 9032, name: "Whit Monday", start: "2027-05-17", end: "2027-05-17" };
  const halfTerm = { id: 9040, name: "Half term", start: "2027-05-24", end: "2027-05-28" };

  it("an undecided hit is reported with its dates, and nothing is dropped", () => {
    const r = planSessions(base({ holidays: [easter, whit] }));
    expect(r.undecided).toEqual([9032]); // Easter is before the first session
    expect(r.hits).toEqual([
      { holiday_id: 9032, name: "Whit Monday", start: "2027-05-17", end: "2027-05-17", single_day: true, dates: ["2027-05-17"], decision: null },
    ]);
    expect(dates(r)).toContain("2027-05-17");
  });

  it("skip drops the date and adds one at the end, keeping the count", () => {
    const r = planSessions(base({ holidays: [whit], decisions: [{ holiday_id: 9032, action: "skip" }] }));
    expect(r.undecided).toEqual([]);
    expect(dates(r)).not.toContain("2027-05-17");
    expect(r.events).toHaveLength(12);
    expect(dates(r).at(-1)).toBe("2027-06-28");
  });

  it("run keeps the date", () => {
    const r = planSessions(base({ holidays: [whit], decisions: [{ holiday_id: 9032, action: "run" }] }));
    expect(dates(r)).toContain("2027-05-17");
    expect(r.hits[0].decision).toBe("run");
  });

  it("exchange moves the session to the given date, keeping its position", () => {
    const r = planSessions(base({
      holidays: [whit], decisions: [{ holiday_id: 9032, action: "exchange", exchange_date: "2027-05-18" }],
    }));
    expect(dates(r)).toContain("2027-05-18");
    expect(dates(r)).not.toContain("2027-05-17");
    expect(r.events).toHaveLength(12);
  });

  it("exchange is refused for a multi-day break", () => {
    const r = planSessions(base({
      holidays: [halfTerm], decisions: [{ holiday_id: 9040, action: "exchange", exchange_date: "2027-05-31" }],
    }));
    expect(r.errors).toEqual(["Half term lasts 5 days: choose skip or run. Exchange is for a single-day holiday."]);
  });

  it("an exchange date inside another holiday, or on an existing session, is refused", () => {
    const inside = planSessions(base({
      holidays: [whit, halfTerm],
      decisions: [
        { holiday_id: 9032, action: "exchange", exchange_date: "2027-05-25" },
        { holiday_id: 9040, action: "skip" },
      ],
    }));
    expect(inside.errors).toContain("2027-05-25 is inside Half term; pick another exchange date.");
    const clash = planSessions(base({
      holidays: [whit], decisions: [{ holiday_id: 9032, action: "exchange", exchange_date: "2027-05-24" }],
    }));
    expect(clash.errors).toContain("2027-05-24 would hold two sessions; pick another exchange date.");
  });

  it("exchange without a date, or a date without exchange, is a validation error", () => {
    expect(planSessions(base({ holidays: [whit], decisions: [{ holiday_id: 9032, action: "exchange" }] })).errors[0])
      .toMatch(/needs an exchange_date/);
    expect(planSessions(base({ holidays: [whit], decisions: [{ holiday_id: 9032, action: "skip", exchange_date: "2027-05-18" }] })).errors[0])
      .toMatch(/only used with action "exchange"/);
  });

  it("overlapping holidays: the date is a hit for each, all must be decided, and skip wins over run", () => {
    const easterBreak = { id: 1, name: "Easter break", start: "2027-04-02", end: "2027-04-07" };
    const easterMonday = { id: 2, name: "Easter Monday", start: "2027-04-05", end: "2027-04-05" };
    const partial = planSessions(base({ holidays: [easterBreak, easterMonday], decisions: [{ holiday_id: 1, action: "run" }] }));
    expect(partial.undecided).toEqual([2]);
    expect(partial.hits.map((h) => [h.holiday_id, h.dates])).toEqual([[1, ["2027-04-05"]], [2, ["2027-04-05"]]]);
    const decided = planSessions(base({
      holidays: [easterBreak, easterMonday],
      decisions: [{ holiday_id: 1, action: "run" }, { holiday_id: 2, action: "skip" }],
    }));
    expect(decided.undecided).toEqual([]);
    expect(dates(decided)[0]).toBe("2027-04-12");
  });

  it("a multi-day skip that pushes the run past the period end is flagged, not refused", () => {
    const r = planSessions(base({
      period_end: "2027-06-21",
      holidays: [halfTerm], decisions: [{ holiday_id: 9040, action: "skip" }],
    }));
    expect(r.errors).toEqual([]);
    expect(r.flags).toContain("ends_after_period");
  });
});

describe("copy-class planner — blocks by position", () => {
  it("the owner's example: monday/tuesday labels follow position when the class moves to Tue/Wed", () => {
    const mon = weekly("2026-09-07", 3, "16:00", () => ["monday"]);
    const tue = weekly("2026-09-08", 3, "16:00", () => ["tuesday"]);
    const r = planSessions(base({ sessions: [...mon, ...tue], first_session_on: "2027-04-06" }));
    expect(r.events.slice(0, 4).map((e) => `${new Date(e.date + "T00:00:00Z").getUTCDay()}:${e.blocks[0]}`)).toEqual([
      "2:monday", "3:tuesday", "2:monday", "3:tuesday",
    ]);
  });

  it("a session in two blocks keeps both", () => {
    const s = weekly("2026-09-07", 4, "16:00", (i) => (i === 0 ? ["A", "B"] : ["A"]));
    expect(planSessions(base({ sessions: s })).events[0].blocks).toEqual(["A", "B"]);
  });

  it("a longer run repeats the last block and is flagged; counts are reported per block", () => {
    const s = weekly("2026-09-07", 4, "16:00", (i) => [i < 2 ? "first" : "second"]);
    const r = planSessions(base({ sessions: s, session_count: 6 }));
    expect(r.flags).toContain("blocks_extended");
    expect(r.block_counts).toEqual([
      { name: "first", source_count: 2, new_count: 2 },
      { name: "second", source_count: 2, new_count: 4 },
    ]);
  });

  it("a single-weekday block that ends up on two weekdays is flagged", () => {
    // Mon "monday" / Wed "wednesday"; skipping the SECOND Monday shifts the alternation mid-run.
    const mon = weekly("2026-09-07", 3, "16:00", () => ["monday"]);
    const wed = weekly("2026-09-09", 3, "16:00", () => ["wednesday"]);
    const holiday = { id: 1, name: "Holiday", start: "2027-04-12", end: "2027-04-12" };
    const r = planSessions(base({
      sessions: [...mon, ...wed], holidays: [holiday], decisions: [{ holiday_id: 1, action: "skip" }],
    }));
    expect(r.flags).toContain("block_weekday_mix");
  });

  it("a source with two sessions on one day is copied as it is, without an exchange-date error", () => {
    // Live, local class 6766: 29 Aug and 5 Sep 2025 each hold two 12:30 sessions.
    const src = ["2025-08-28", "2025-08-29", "2025-08-29", "2025-08-30", "2025-09-05", "2025-09-05", "2025-09-12"].map((d) => ({
      date: `${d} 12:30:00`, duration: 60, cancelled: false, replacement: false, blocks: [],
    }));
    const r = planSessions(base({ sessions: src, period_start: "2026-09-01", period_end: "2026-12-31" }));
    expect(r.errors).toEqual([]);
    expect(r.events).toHaveLength(7);
    expect(r.events.filter((e) => e.date === r.events[1].date)).toHaveLength(2);
  });

  it("billable is taken by position like blocks; sessions past the source's count take the last one's", () => {
    // api-v1 owner ruling 2026-11-22: the caller sends events[].billable, mapped from the source.
    const src = weekly("2026-09-07", 4).map((s, i) => ({ ...s, billable: i !== 1 }));
    const r = planSessions(base({ sessions: src, session_count: 6 }));
    expect(r.events.map((e) => e.billable)).toEqual([true, false, true, true, true, true]);
  });

  // Live, local 2026-11-22 (JAR 2023 → Spring 2027): irregular classes lost a session per
  // skipped holiday, and a fixed count spread 12 sessions over a year.
  const odd = ["2025-08-28", "2025-09-02", "2025-09-03", "2025-09-12", "2025-09-26", "2025-10-29"].map((d) => ({
    date: `${d} 12:30:00`, duration: 60, cancelled: false, replacement: false, blocks: [],
  }));
  const breakOn = (start: string, end: string) => [{ id: 1, name: "Break", start, end }];

  it("an irregular class keeps its count on a skip: dates continue a week apart after the last", () => {
    const r = planSessions(base({
      sessions: odd, period_start: "2026-09-01", period_end: "2026-12-31",
      holidays: breakOn("2026-09-08", "2026-09-08"), decisions: [{ holiday_id: 1, action: "skip" }],
    }));
    expect(r.errors).toEqual([]);
    expect(r.events).toHaveLength(6);
    expect(r.flags).toEqual(expect.arrayContaining(["irregular_pattern", "irregular_extended_weekly"]));
    const last = r.events.at(-1)!;
    const shiftedLast = r.events.at(-2)!;
    expect((Date.parse(last.date) - Date.parse(shiftedLast.date)) / 86_400_000).toBe(7);
  });

  it("an irregular class with a fixed session_count runs weekly from its first session", () => {
    const r = planSessions(base({ sessions: odd, session_count: 4, period_start: "2026-09-01", period_end: "2026-12-31" }));
    expect(r.flags).toContain("irregular_made_weekly");
    expect(r.flags).not.toContain("irregular_pattern");
    // 2025-08-28 was a Thursday at 12:30.
    expect(r.events.map((e) => [e.date, e.time])).toEqual([
      ["2026-09-03", "12:30"], ["2026-09-10", "12:30"], ["2026-09-17", "12:30"], ["2026-09-24", "12:30"],
    ]);
  });

  it("a session cancelled in the source stays cancelled by position; added sessions are scheduled", () => {
    const src = weekly("2026-09-07", 3).map((s, i) => ({ ...s, cancelled: i === 1 }));
    const r = planSessions(base({ sessions: src, session_count: 4 }));
    expect(r.events.map((e) => e.status)).toEqual(["scheduled", "unplanned", "scheduled", "scheduled"]);
  });

  it("cutting the count flags blocks_shortened", () => {
    const src = weekly("2026-09-07", 6, "16:00", (i) => [i < 3 ? "A" : "B"]);
    const r = planSessions(base({ sessions: src, session_count: 4 }));
    expect(r.block_counts).toEqual([{ name: "A", source_count: 3, new_count: 3 }, { name: "B", source_count: 3, new_count: 1 }]);
    expect(r.flags).toContain("blocks_shortened");
    expect(planSessions(base({ sessions: src })).flags).not.toContain("blocks_shortened");
  });

  // Live, 2026-11-22: "the term starts in the first week of February" sent first_session_on
  // 2027-02-01 for the whole chunk and moved every class to Monday.
  it("not_before keeps each class's weekday; first_session_on moves it", () => {
    const thursdays = weekly("2026-09-03", 3); // Thursdays
    const kept = planSessions(base({ sessions: thursdays, period_start: "2027-01-15", not_before: "2027-02-01" }));
    expect(kept.events.map((e) => e.date)).toEqual(["2027-02-04", "2027-02-11", "2027-02-18"]);
    const moved = planSessions(base({ sessions: thursdays, period_start: "2027-01-15", first_session_on: "2027-02-01" }));
    expect(moved.events[0].date).toBe("2027-02-01");
    // A not_before earlier than the period start changes nothing.
    expect(planSessions(base({ sessions: thursdays, not_before: "2020-01-01" })).events[0].date).toBe("2027-04-01");
  });

  // Live, 2026-11-22: Good Friday inside an Easter break the operator skipped was asked about again.
  it("a date already skipped by one holiday needs no decision for another covering it", () => {
    const fridays = weekly("2026-09-04", 4); // Fridays
    const r = planSessions(base({
      sessions: fridays, period_start: "2027-03-19",
      holidays: [
        { id: 1, name: "Easter break", start: "2027-03-25", end: "2027-03-30" },
        { id: 2, name: "Good Friday", start: "2027-03-26", end: "2027-03-26" },
      ],
      decisions: [{ holiday_id: 1, action: "skip" }],
    }));
    expect(r.undecided).toEqual([]);
    expect(r.events.map((e) => e.date)).toEqual(["2027-03-19", "2027-04-02", "2027-04-09", "2027-04-16"]);
    // Still asked when no covering holiday is skipped.
    const asked = planSessions(base({
      sessions: fridays, period_start: "2027-03-19",
      holidays: [
        { id: 1, name: "Easter break", start: "2027-03-25", end: "2027-03-30" },
        { id: 2, name: "Good Friday", start: "2027-03-26", end: "2027-03-26" },
      ],
      decisions: [{ holiday_id: 1, action: "run" }],
    }));
    expect(asked.undecided).toEqual([2]);
  });
});
