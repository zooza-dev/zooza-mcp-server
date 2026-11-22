import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ZoozaAuth } from "../auth/types.js";
import {
  ASK_OPERATOR_ERROR,
  buildCopyBatchBody,
  CHUNK_ERROR,
  copyClassInputSchema,
  copyClassStrictShape,
  hhmmToMinutes,
  planCopy,
  runCopyClass,
  toSourceSession,
} from "./copy-class.js";
import { resetRetryLedger } from "./copy-retry-ledger.js";
import { clearClassCopyPlanStore } from "./copy-class-plan-store.js";
import { runCallTool } from "./dispatcher.js";

// Spec ZMCP-20261122-001, phase 1: reads, holiday gate, batch body.

const AUTH: ZoozaAuth = { mode: "legacy", apiKey: "k", company: "1", legacyToken: "t", baseUrl: "https://api.test" };

// Spring 2027 starts Thursday 1 Apr.
const PERIODS = [
  { id: 81, name: "Winter 2026", period_start: "2026-09-01", period_end: "2027-01-31" },
  { id: 412, name: "Spring 2027", period_start: "2027-04-01", period_end: "2027-07-02" },
  { id: 413, name: "Autumn 2027", period_start: "2027-09-01", period_end: null },
];

/** Weekly sessions from `first`, `n` of them. */
function weekly(scheduleId: number, first: string, n: number, over: (i: number) => Record<string, unknown> = () => ({})) {
  const start = Date.parse(first + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    id: scheduleId * 100 + i,
    schedule_id: scheduleId,
    date: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10) + " 16:00:00",
    duration: 45,
    status: "scheduled",
    ...over(i),
  }));
}

function cls(id: number, over: Record<string, unknown> = {}) {
  return { id, name: `Class ${id}`, course_id: 964, place_id: 16, duration: 45, __calc__course_place: "Riverside", ...over };
}

interface World {
  schedules?: Record<number, unknown>;
  events?: Record<number, unknown[]>;
  /** Holidays per venue id. */
  holidays?: Record<number, unknown[]>;
  /** Venues with region codes (api-v1 then echoes settings.subdivision). */
  regions?: Record<number, string>;
  cap?: number;
  fail?: { path: string; status: number };
  /** POST schedules/copy?action=preflight_check; `n` counts the preflight calls from 1. Default: pfResponse(body). */
  preflight?: (body: Batch, n: number) => { status: number; body: unknown };
  /** POST schedules/copy (the commit). "throw" = the connection drops. Default: one completed step per class. */
  apply?: { status: number; body: unknown } | "throw";
  /** Programme names, GET courses/{id}. */
  courses?: Record<number, string>;
}

interface Call {
  method: string;
  path: string;
  q: URLSearchParams;
  body?: any;
  company?: string;
}

function stub(w: World): { calls: Call[]; inFlightMax: () => number } {
  const calls: Call[] = [];
  let inFlight = 0;
  let max = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const q = url.searchParams;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const company = (init?.headers as Record<string, string> | undefined)?.["X-ZOOZA-COMPANY"];
      calls.push({ method: init?.method ?? "GET", path, q, body, company });
      const respond = (status: number, body: unknown) =>
        ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;
      if (w.fail && path === w.fail.path) return respond(w.fail.status, { errors: ["boom"] });
      const list = (rows: unknown[], settings: Record<string, unknown> = {}) => {
        const page = Number(q.get("page") ?? 0);
        const size = Math.min(Number(q.get("page_size") ?? 1000), w.cap ?? 1000);
        return respond(200, { total: rows.length, settings, data: rows.slice(page * size, (page + 1) * size) });
      };
      if (path === "/billing_periods") return list(PERIODS);
      const sched = /^\/schedules\/(\d+)$/.exec(path);
      if (sched) {
        const rec = w.schedules?.[Number(sched[1])];
        return rec ? respond(200, rec) : respond(404, { errors: ["resource_not_found"] });
      }
      if (path === "/events") {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return list(w.events?.[Number(q.get("schedule_id"))] ?? []);
      }
      if (path === "/holidays") {
        const place = Number(q.get("place_id"));
        const region = w.regions?.[place];
        // api-v1's date_from filter (class/Zooza/Collection/Holidays.php:85-87); `end` is inclusive.
        const from = q.get("date_from") ?? "";
        const rows = (w.holidays?.[place] ?? []).filter((h) => {
          const { start, end } = h as { start: string; end: string };
          return start >= from || (start < from && end > from);
        });
        return list(rows, region ? { date_from: from, subdivision: region } : {});
      }
      if (path === "/schedules/copy" && init?.method === "POST") {
        if (q.get("action") === "preflight_check") {
          const n = calls.filter((c) => c.path === path && c.q.get("action") === "preflight_check").length;
          const r = w.preflight?.(body, n) ?? { status: 200, body: pfResponse(body) };
          return respond(r.status, r.body);
        }
        if (w.apply === "throw") throw new TypeError("fetch failed");
        const r = w.apply ?? { status: 200, body: jobResponse(body, "completed") };
        return respond(r.status, r.body);
      }
      const course = /^\/courses\/(\d+)$/.exec(path);
      if (course) {
        const name = w.courses?.[Number(course[1])];
        return name ? respond(200, { id: Number(course[1]), name }) : respond(404, { errors: ["resource_not_found"] });
      }
      return respond(500, { errors: [`unexpected ${path}`] });
    }),
  );
  return { calls, inFlightMax: () => max };
}

const BASE = { company_id: 1, target_billing_period_id: 412, bookings: "enrolled", session_count: 12 };

async function run(args: Record<string, unknown>) {
  const r = await runCopyClass({ ...BASE, ...args }, AUTH);
  return { r, text: r.content[0].text, out: r.isError ? undefined : JSON.parse(r.content[0].text) };
}

/** The plan alone (reads + planner + body), without the preflight that runCopyClass adds. */
async function plan(args: Record<string, unknown>) {
  const out: any = await planCopy(z.object(copyClassStrictShape).parse({ ...BASE, ...args }), AUTH);
  return { out };
}

// Easter Monday 2027 is 29 Mar; use holidays that hit Mondays from 5 Apr.
const EASTER_BREAK = { id: 9030, name: "Easter break", start: "2027-04-12", end: "2027-04-16", type: 2 };
const MAY_DAY = { id: 9031, name: "Labour Day", start: "2027-05-03", end: "2027-05-03", type: 1 };

describe("classes_copy_class phase 1 — input gate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("26 classes return the chunking error before any fetch", async () => {
    const { calls } = stub({});
    const classes = Array.from({ length: 26 }, (_, i) => ({ schedule_id: i + 1 }));
    const { r, text } = await run({ classes });
    expect(r.isError).toBe(true);
    expect(text).toBe(CHUNK_ERROR);
    expect(calls).toHaveLength(0);
  });

  it.each([["bookings"], ["session_count"]])("missing %s asks the operator, before any fetch", async (field) => {
    const { calls } = stub({});
    const args: Record<string, unknown> = { ...BASE, classes: [{ schedule_id: 1 }] };
    delete args[field];
    const r = await runCopyClass(args, AUTH);
    expect(r.content[0].text).toBe(ASK_OPERATOR_ERROR);
    expect(calls).toHaveLength(0);
  });

  // Through call_tool, which validates against the REGISTERED shape (as the SDK does on
  // a direct call) before the handler runs — so the directives must survive that layer.
  const handles = () =>
    new Map<string, RegisteredTool>([
      [
        "classes_copy_class",
        {
          title: "Copy classes",
          description: "d",
          inputSchema: z.object(copyClassInputSchema),
          handler: (a: unknown) => runCopyClass(a, AUTH),
          enabled: true,
        } as unknown as RegisteredTool,
      ],
    ]);

  it("via call_tool: 26 classes return the chunking error, not a schema error", async () => {
    const { calls } = stub({});
    const classes = Array.from({ length: 26 }, (_, i) => ({ schedule_id: i + 1 }));
    const r = await runCallTool({ name: "classes_copy_class", arguments: { ...BASE, classes } }, handles(), undefined);
    expect(r.content[0].text).toBe(CHUNK_ERROR);
    expect(calls).toHaveLength(0);
  });

  it.each([["bookings"], ["session_count"]])("via call_tool: missing %s asks the operator", async (field) => {
    const { calls } = stub({});
    const args: Record<string, unknown> = { ...BASE, classes: [{ schedule_id: 1 }] };
    delete args[field];
    const r = await runCallTool({ name: "classes_copy_class", arguments: args }, handles(), undefined);
    expect(r.content[0].text).toBe(ASK_OPERATOR_ERROR);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed exchange_date and an empty class list before any fetch", async () => {
    const { calls } = stub({});
    const bad = await run({
      classes: [{ schedule_id: 1 }],
      holiday_decisions: [{ holiday_id: 1, action: "exchange", exchange_date: "3.5.2027" }],
    });
    expect(bad.text).toMatch(/exchange_date must be YYYY-MM-DD/);
    expect((await run({ classes: [] })).r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("confirmed without a token is refused by the dual-phase guard", async () => {
    stub({});
    const { text } = await run({ classes: [{ schedule_id: 1 }], confirmed: true });
    expect(text).toMatch(/`confirmed` only applies/);
  });
});

describe("classes_copy_class phase 1 — reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the period unpaged, every class, every session page (status any) and holidays once per venue", async () => {
    const { calls } = stub({
      schedules: { 1: cls(1), 2: cls(2), 3: cls(3, { place_id: 17 }) },
      events: { 1: weekly(1, "2026-09-07", 12), 2: weekly(2, "2026-09-08", 12), 3: weekly(3, "2026-09-09", 12) },
      cap: 5,
    });
    const { out } = await plan({ classes: [{ schedule_id: 1 }, { schedule_id: 2 }, { schedule_id: 3 }] });
    expect(out.kind).toBe("ready");

    const bp = calls.filter((c) => c.path === "/billing_periods");
    expect(bp).toHaveLength(1);
    expect(bp[0].q.get("filter")).toBe("filter");
    expect(bp[0].q.has("page")).toBe(false);

    expect(calls.filter((c) => /^\/schedules\/\d+$/.test(c.path)).map((c) => c.path).sort()).toEqual([
      "/schedules/1", "/schedules/2", "/schedules/3",
    ]);

    const ev = calls.filter((c) => c.path === "/events");
    // 12 rows, server cap 5 → 3 pages per class.
    expect(ev).toHaveLength(9);
    expect(ev.every((c) => c.q.get("status") === "any" && c.q.get("filter") === "filter")).toBe(true);

    const hol = calls.filter((c) => c.path === "/holidays");
    expect(hol.map((c) => c.q.get("place_id")).sort()).toEqual(["16", "17"]);
    // From the day before the period start (api-v1's strict end > date_from), to the
    // target period extended by 8 weeks.
    expect(hol[0].q.get("date_from")).toBe("2027-03-31");
    expect(hol[0].q.get("date_to")).toBe("2027-08-27");

    // Never the holiday-blind local generator, and no write.
    expect(calls.some((c) => c.path.includes("preview"))).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a venue override is the venue whose holidays are read", async () => {
    const { calls } = stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 12) } });
    await run({ classes: [{ schedule_id: 1, place_id: 99 }] });
    expect(calls.filter((c) => c.path === "/holidays").map((c) => c.q.get("place_id"))).toEqual(["99"]);
  });

  it("reads sessions at most 5 classes at a time", async () => {
    const schedules: Record<number, unknown> = {};
    const events: Record<number, unknown[]> = {};
    for (let i = 1; i <= 12; i++) {
      schedules[i] = cls(i);
      events[i] = weekly(i, "2026-09-07", 4);
    }
    const s = stub({ schedules, events });
    await run({ classes: Object.keys(schedules).map((id) => ({ schedule_id: Number(id) })) });
    expect(s.inFlightMax()).toBe(5);
  });

  it("an unknown class and an unknown period give the not-found text", async () => {
    stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 12) } });
    expect((await run({ classes: [{ schedule_id: 1 }, { schedule_id: 7 }] })).text).toBe("Class 7 not found in this company.");
    expect((await run({ target_billing_period_id: 999, classes: [{ schedule_id: 1 }] })).text).toBe(
      "Billing period 999 not found.",
    );
  });

  it.each([
    ["/billing_periods", /billing period 412/],
    ["/schedules/1", /class 1/],
    ["/events", /sessions of class 1/],
    ["/holidays", /holidays of venue 16.*never planned without holidays/],
  ])("a failed %s read aborts, naming what failed", async (path, msg) => {
    stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 12) }, fail: { path, status: 500 } });
    const { r, text } = await run({ classes: [{ schedule_id: 1 }] });
    expect(r.isError).toBe(true);
    expect(text).toMatch(msg);
  });
});

describe("classes_copy_class phase 1 — source mapping and planning", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps cancelled, replacement, duration, billable and blocks (segments[] first, then __schedule_segments__name)", () => {
    expect(
      toSourceSession(
        { id: 1, date: "2026-09-07 16:00:00", duration: "50", status: "unplanned", billable: true, segments: [{ name: "monday" }], __schedule_segments__name: "x" },
        45,
      ),
    ).toEqual({ date: "2026-09-07 16:00:00", duration: 50, cancelled: true, replacement: false, blocks: ["monday"], billable: true });
    expect(
      toSourceSession(
        { id: 2, date: "2026-09-08 16:00:00", status: "scheduled", is_custom_replacement_event: 1, __schedule_segments__name: "Mon, Group 1|Blok 3" },
        45,
      ),
    ).toEqual({ date: "2026-09-08 16:00:00", duration: 45, cancelled: false, replacement: true, blocks: ["Mon, Group 1", "Blok 3"], billable: false });
  });

  it("a cancelled session counts toward same_as_source and is carried as cancelled_in_source", async () => {
    stub({
      schedules: { 1: cls(1) },
      events: { 1: weekly(1, "2026-09-07", 10, (i) => (i === 3 ? { status: "unplanned" } : {})) },
    });
    const { out } = await plan({ session_count: "same_as_source", classes: [{ schedule_id: 1 }] });
    expect(out.classes[0].sessions.count).toBe(10);
    expect(out.classes[0].cancelled_in_source).toBe(1);
  });

  it("the chunk first_session_on applies, and a per-class one wins (moving the weekday)", async () => {
    stub({ schedules: { 1: cls(1), 2: cls(2) }, events: { 1: weekly(1, "2026-09-07", 3), 2: weekly(2, "2026-09-07", 3) } });
    const { out } = await plan({
      session_count: 3,
      first_session_on: "2027-04-12",
      classes: [{ schedule_id: 1 }, { schedule_id: 2, first_session_on: "2027-04-14", time: "17:30" }],
    });
    expect(out.body.classes["1"].events.map((e: { date_string: string }) => e.date_string)).toEqual([
      "2027-04-12", "2027-04-19", "2027-04-26",
    ]);
    expect(out.body.classes["2"].events[0]).toEqual({ date_string: "2027-04-14", time_string: 1050, duration: 45, blocks: [], billable: false, status: "scheduled" });
    expect(out.classes[1].pattern.slots[0].weekday).toBe("Wed");
  });

  it("carries ends_after_period, blocks_extended and block_weekday_mix per class", async () => {
    stub({
      schedules: { 1: cls(1) },
      events: { 1: weekly(1, "2026-09-07", 3, (i) => ({ segments: [{ name: i < 2 ? "a" : "b" }] })) },
    });
    const { out } = await plan({ session_count: 16, classes: [{ schedule_id: 1 }] });
    expect(out.classes[0].flags).toEqual(expect.arrayContaining(["blocks_extended", "ends_after_period"]));
    expect(out.classes[0].block_counts).toEqual([
      { name: "a", source_count: 2, new_count: 2 },
      { name: "b", source_count: 1, new_count: 14 },
    ]);
  });

  it("an irregular source is flagged irregular_pattern", async () => {
    const dates = ["2026-09-07", "2026-09-10", "2026-09-22", "2026-10-02"];
    stub({
      schedules: { 1: cls(1) },
      events: { 1: dates.map((d, i) => ({ id: i, date: `${d} 16:00:00`, duration: 45, status: "scheduled" })) },
    });
    const { out } = await plan({ session_count: "same_as_source", classes: [{ schedule_id: 1 }] });
    expect(out.classes[0].flags).toContain("irregular_pattern");
  });

  it("planner errors abort with their text (exchange on a multi-day break)", async () => {
    stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 12) }, holidays: { 16: [EASTER_BREAK] } });
    const { r, text } = await run({
      classes: [{ schedule_id: 1 }],
      holiday_decisions: [{ holiday_id: 9030, action: "exchange", exchange_date: "2027-04-17" }],
    });
    expect(r.isError).toBe(true);
    expect(text).toBe("Easter break lasts 5 days: choose skip or run. Exchange is for a single-day holiday.");
  });

  it("a class with no sessions aborts, naming it", async () => {
    stub({ schedules: { 1: cls(1) }, events: { 1: [] } });
    expect((await run({ classes: [{ schedule_id: 1 }] })).text).toMatch(/Class 1 has no sessions/);
  });
});

describe("classes_copy_class — a class's own problem sets it aside, the chunk goes on", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a class with no sessions is set aside with its reason; the others get a preview and a token", async () => {
    stub({ ...TWO, schedules: { ...TWO.schedules, 3: cls(3) }, events: { ...TWO.events, 3: [] } });
    const { r, out } = await run({ classes: [{ schedule_id: 1 }, { schedule_id: 3 }, { schedule_id: 2 }] });
    expect(r.isError).toBeFalsy();
    expect(out.token).toBeTruthy();
    expect(out.classes.map((c: { source_schedule_id: number }) => c.source_schedule_id)).toEqual([1, 2]);
    expect(out.set_aside).toEqual([{ schedule_id: 3, name: "Class 3", reason: "Class 3 has no sessions to copy a pattern from." }]);
    expect(out.warnings.join(" ")).toMatch(/1 class is NOT in this copy/);
    expect(out.scope).toMatch(/^Copying 2 classes/);
  });

  it("a set-aside class rides along on needs_decision too", async () => {
    stub({ schedules: { 1: cls(1), 3: cls(3) }, events: { 1: weekly(1, "2026-09-07", 12), 3: [] }, holidays: { 16: [EASTER_BREAK] } });
    const { out } = await plan({ classes: [{ schedule_id: 1 }, { schedule_id: 3 }] });
    expect(out.kind).toBe("needs_decision");
    expect(out.result.set_aside.map((c: { schedule_id: number }) => c.schedule_id)).toEqual([3]);
  });

  it("when every class is set aside, it is an error naming each", async () => {
    stub({ schedules: { 3: cls(3) }, events: { 3: [] } });
    const { r, text } = await run({ classes: [{ schedule_id: 3 }] });
    expect(r.isError).toBe(true);
    expect(text).toBe("Class 3 has no sessions to copy a pattern from.");
  });
});

describe("classes_copy_class — period with no last day, and status by position", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("warns that ends_after_period cannot be flagged", async () => {
    stub({ ...TWO });
    const { out } = await run({ target_billing_period_id: 413, classes: [{ schedule_id: 1 }] });
    expect(out.warnings.join(" ")).toMatch(/"Autumn 2027" has no last day, so no class can be flagged ends_after_period/);
  });

  it("sends status unplanned for a session cancelled in the source", async () => {
    stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 4, (i) => (i === 2 ? { status: "unplanned" } : {})) } });
    const { out } = await plan({ session_count: "same_as_source", classes: [{ schedule_id: 1 }] });
    expect(out.body.classes["1"].events.map((e: { status: string }) => e.status)).toEqual(["scheduled", "scheduled", "unplanned", "scheduled"]);
  });
});

describe("classes_copy_class phase 1 — holiday gate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("undecided hits return needs_decision grouped per holiday, with no token and no write", async () => {
    const { calls } = stub({
      schedules: { 1: cls(1), 2: cls(2) },
      events: { 1: weekly(1, "2026-09-07", 12), 2: weekly(2, "2026-09-07", 12) },
      holidays: { 16: [EASTER_BREAK, MAY_DAY] },
      regions: { 16: "SK-BA" },
    });
    const decided = [{ holiday_id: 9031, action: "run" }];
    const { out } = await run({ classes: [{ schedule_id: 1 }, { schedule_id: 2 }], holiday_decisions: decided });
    expect(out).toEqual({
      status: "needs_decision",
      holidays: [
        {
          holiday_id: 9030, name: "Easter break", start: "2027-04-12", end: "2027-04-16", type: "school", single_day: false,
          hits: [{ schedule_id: 1, dates: ["2027-04-12"] }, { schedule_id: 2, dates: ["2027-04-12"] }],
        },
      ],
      decided,
    });
    expect(out.token).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a break that ends exactly on the period start still hits the first session", async () => {
    // Thursday class; the target period starts Thursday 2027-04-01, the last day of the break.
    const BREAK_ENDING = { id: 9032, name: "Easter break", start: "2027-03-29", end: "2027-04-01", type: 2 };
    stub({
      schedules: { 1: cls(1) },
      events: { 1: weekly(1, "2026-09-10", 12) },
      holidays: { 16: [BREAK_ENDING] },
      regions: { 16: "SK-BA" },
    });
    const { out } = await run({ classes: [{ schedule_id: 1 }] });
    expect(out.status).toBe("needs_decision");
    expect(out.holidays).toEqual([
      expect.objectContaining({ holiday_id: 9032, hits: [{ schedule_id: 1, dates: ["2027-04-01"] }] }),
    ]);
  });

  it("a venue with no region codes adds the every-region notice when a school break is listed", async () => {
    stub({ schedules: { 1: cls(1) }, events: { 1: weekly(1, "2026-09-07", 12) }, holidays: { 16: [EASTER_BREAK] } });
    const { out } = await run({ classes: [{ schedule_id: 1 }] });
    expect(out.status).toBe("needs_decision");
    expect(out.notices).toEqual([
      'Venue "Riverside" (16) has no region set, so the school breaks of every region are listed. Ask the operator which ones apply to them; the others can be run.',
    ]);
  });

  it("no notice for a venue with region codes", async () => {
    stub({
      schedules: { 1: cls(1) },
      events: { 1: weekly(1, "2026-09-07", 12) },
      holidays: { 16: [EASTER_BREAK] },
      regions: { 16: "SK-BA" },
    });
    expect((await run({ classes: [{ schedule_id: 1 }] })).out.notices).toBeUndefined();
  });

  it("every hit decided: skip and exchange shape the events, and the body is built", async () => {
    stub({
      schedules: { 1: cls(1) },
      events: { 1: weekly(1, "2026-09-07", 4) },
      holidays: { 16: [EASTER_BREAK, MAY_DAY] },
    });
    const decisions = [
      { holiday_id: 9030, action: "skip" },
      { holiday_id: 9031, action: "exchange", exchange_date: "2027-05-04" },
    ];
    const { out } = await plan({ session_count: 5, classes: [{ schedule_id: 1 }], holiday_decisions: decisions });
    expect(out.kind).toBe("ready");
    expect(out.holiday_decisions).toEqual(decisions);
    expect(out.body.classes["1"].events.map((e: { date_string: string }) => e.date_string)).toEqual([
      "2027-04-05", "2027-04-19", "2027-04-26", "2027-05-04", "2027-05-10",
    ]);
  });
});

describe("buildCopyBatchBody", () => {
  const events = [{ date: "2027-04-05", time: "16:00", duration: 45, blocks: ["monday"] }];

  it("keys classes by source id, overrides only what was given, plus the target period", () => {
    const body = buildCopyBatchBody({
      target_billing_period_id: 412,
      bookings: "enrolled",
      classes: [
        { input: { schedule_id: 6650 }, events },
        {
          input: {
            schedule_id: 6652, course_id: 971, name: "Tots 2", trainer_id: 5, place_id: 17, room_id: 3, capacity: 10,
            online_registration: false, time: "09:05", allow_repeat_copy: true, price: 120, first_session_on: "2027-04-14",
          },
          events,
        },
      ],
    });
    expect(body).toEqual({
      classes: {
        "6650": {
          overrides: { billing_period_id: 412 },
          events: [{ date_string: "2027-04-05", time_string: 960, duration: 45, blocks: ["monday"] }],
          registrations: "all",
        },
        "6652": {
          // price is mapped in phase 2 (price_hints); first_session_on lives in events[].
          overrides: {
            billing_period_id: 412, course_id: 971, name: "Tots 2", trainer_id: 5, place_id: 17, room_id: 3, capacity: 10,
            online_registration: false, time: 545,
          },
          events: [{ date_string: "2027-04-05", time_string: 960, duration: 45, blocks: ["monday"] }],
          registrations: "all",
          allow_repeat_copy: true,
        },
      },
    });
  });

  it("bookings none omits registrations; allow_repeat_copy false is omitted", () => {
    const body = buildCopyBatchBody({
      target_billing_period_id: 412,
      bookings: "none",
      classes: [{ input: { schedule_id: 1, allow_repeat_copy: false }, events }],
    });
    expect(body.classes["1"]).toEqual({
      overrides: { billing_period_id: 412 },
      events: [{ date_string: "2027-04-05", time_string: 960, duration: 45, blocks: ["monday"] }],
    });
  });

  it("HH:MM converts to minutes since midnight", () => {
    expect(hhmmToMinutes("00:00")).toBe(0);
    expect(hhmmToMinutes("19:30")).toBe(1170);
    expect(hhmmToMinutes("23:59")).toBe(1439);
  });
});

// ── Phase 2: preflight, preview, token, apply ──

type Batch = { classes: Record<string, any> };

const ALL_CHECKS = [
  ["already_copied_to_billing_period", "error"],
  ["recently_copied", "warning"],
  ["booking_already_in_target", "warning"],
  ["capacity_below_bookings", "warning"],
  ["registration_type_change", "warning"],
  ["pricing_model_change", "warning"],
  ["unknown_block_names", "warning"],
  ["booking_refused", "error"],
] as const;

/** Class checks, all passed, keyed by name (class/Preflight.php:63-90). `failed` overrides some. */
function pfChecks(failed: Record<string, { severity?: string; data: Record<string, unknown> }> = {}) {
  const out: Record<string, unknown> = {};
  for (const [name, severity] of ALL_CHECKS) {
    const f = failed[name];
    out[name] = f
      ? { name, result: "not_passed", severity: f.severity ?? severity, data: f.data }
      : { name, result: "passed", severity };
  }
  return out;
}

function pfBooking(id: number, total = 60) {
  return {
    registration_id: id, client: `Client ${id}`, email: `c${id}@x.test`, participant_full_name: `Kid ${id}`, slots: 1,
    status: "registered", target_status: "registered",
    amount_indicative: { price: total, registration_fee: 0, total, admin_price: false },
    already_carried: null, refusal: null,
  };
}

/**
 * One class of a preflight response, in Class_Copy_Preflight::preview_class()'s shape
 * (class/Class_Copy_Preflight.php:171-177, schedule block :851-881).
 */
function pfClass(id: number, cls: any, over: { bookings?: unknown[]; checks?: unknown; schedule?: Record<string, unknown> } = {}) {
  const sessions = cls.events.map((e: any) => ({
    date: e.date_string, time: e.time_string, duration: e.duration, trainer_id: 5, place_id: 16, room_id: 0,
    blocks: e.blocks, billable: false,
  }));
  const bookings = over.bookings ?? (cls.registrations === "all" ? [pfBooking(id * 10 + 1), pfBooking(id * 10 + 2)] : []);
  return {
    schedule: {
      name: cls.overrides.name ?? `Class ${id}`, course_id: cls.overrides.course_id ?? 964, billing_period_id: 412,
      trainer_id: 5, place_id: 16, room_id: 0, capacity: 12, price: "60.0000", unit_price: "0.0000", registration_fee: "0.0000",
      online_registration: 1, time: 960, duration: 45, start: sessions[0]?.date, end: sessions.at(-1)?.date,
      origin: "copy", previous: id, retention_response_id: null, payment_schedules: [],
      diff: {
        billing_period_id: { from: 81, to: 412 },
        ...(cls.overrides.course_id ? { course_id: { from: 964, to: cls.overrides.course_id } } : {}),
      },
      price_hints: { course_price: 60, course_registration_fee: 0, price_field: "price" },
      session_summary: {
        count: sessions.length, first_date: sessions[0]?.date ?? null, last_date: sessions.at(-1)?.date ?? null,
        weekdays: ["mon"], source_weekdays: ["mon"],
      },
      ...over.schedule,
    },
    sessions,
    source_sessions: [],
    bookings,
    checks: over.checks ?? pfChecks(),
  };
}

/** A whole preflight response (Class_Copy_Preflight::preview(), :107-111). */
function pfResponse(body: Batch, perClass: Record<string, Parameters<typeof pfClass>[2]> = {}, jobChecks?: unknown) {
  const classes: Record<string, ReturnType<typeof pfClass>> = {};
  for (const [id, c] of Object.entries(body.classes)) classes[id] = pfClass(Number(id), c, perClass[id]);
  const all = Object.values(classes);
  return {
    classes,
    totals: {
      classes: all.length,
      sessions: all.reduce((a, c) => a + c.sessions.length, 0),
      bookings: all.reduce((a, c) => a + c.bookings.length, 0),
      amount_indicative: all.reduce((a, c) => a + c.bookings.reduce((b: number, x: any) => b + x.amount_indicative.total, 0), 0),
    },
    checks: jobChecks ?? { class_cap: { name: "class_cap", result: "passed", severity: "error" } },
  };
}

/** `{ job }` as Class_Copy::job_response() returns it (class/Class_Copy.php). */
function jobResponse(body: Batch, status: "completed" | "queued", id = 88) {
  return {
    job: {
      id, type: "schedule_copy", status, deduplicated: false,
      steps: Object.keys(body.classes).map((sid, i) => ({
        id: 500 + i, seq: i + 1, source_schedule_id: Number(sid), status,
        result:
          status === "completed"
            ? {
                schedule_id: 1070001 + i,
                bookings: [
                  { registration_id: 1, new_registration_id: 9001, amount_charged: 60 },
                  { registration_id: 2, new_registration_id: null, amount_charged: 0, skipped: true, status: "canceled", notice: "booking_skipped" },
                ],
                notices: [],
              }
            : null,
      })),
    },
  };
}

const TWO = {
  schedules: { 1: cls(1, { name: "Monday Swim 1" }), 2: cls(2, { name: "Monday Swim 2" }) },
  events: { 1: weekly(1, "2026-09-07", 12), 2: weekly(2, "2026-09-07", 12) },
  courses: { 964: "Swim 1", 971: "Swim 2" },
};

const copyPosts = (calls: Call[]) => calls.filter((c) => c.path === "/schedules/copy");
const preflights = (calls: Call[]) => copyPosts(calls).filter((c) => c.q.get("action") === "preflight_check");
const commits = (calls: Call[]) => copyPosts(calls).filter((c) => !c.q.has("action"));

describe("classes_copy_class phase 2 — preflight and preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearClassCopyPlanStore();
  });

  it("POSTs the planned body once to schedules/copy?action=preflight_check and shapes the preview from it", async () => {
    const { calls } = stub(TWO);
    const args = { classes: [{ schedule_id: 1 }, { schedule_id: 2 }] };
    const { out: planned } = await plan(args);
    const { r, out } = await run(args);
    expect(r.isError).toBeUndefined();

    const pf = preflights(calls);
    expect(pf).toHaveLength(1);
    expect(pf[0].method).toBe("POST");
    expect(pf[0].body).toEqual(planned.body);
    expect(commits(calls)).toHaveLength(0);

    expect(out.token).toMatch(/^ccp_/);
    expect(Date.parse(out.expires_at) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(out.scope).toBe(
      'Copying 2 classes from billing period "Winter 2026" (1 Sep 2026 – 31 Jan 2027) into billing period "Spring 2027" ' +
        "(1 Apr – 2 Jul 2027): 24 sessions, 4 bookings (enrolled clients). Nobody is emailed.",
    );
    expect(out.classes[0]).toEqual({
      source_schedule_id: 1,
      name: "Class 1",
      programme: { id: 964, name: "Swim 1" },
      new_programme: null,
      pattern: "Mon 16:00, 45 min",
      sessions: { count: 12, first: "2027-04-05", last: "2027-06-21" },
      blocks: [],
      bookings: { count: 2, amount_indicative: 120 },
      flags: [],
      checks: [],
    });
    expect(out.totals).toEqual({ classes: 2, sessions: 24, bookings: 4, amount_indicative: 240 });
    expect(out.holiday_decisions).toEqual([]);
    expect(out.warnings).toEqual(["Amounts are indicative: they are recomputed when each class is copied."]);
  });

  it("rows and totals are the preflight's, not MCP arithmetic", async () => {
    stub({
      ...TWO,
      preflight: (body) => {
        const res = pfResponse(body, { "1": { bookings: [pfBooking(11, 33.335), pfBooking(12, 10)], schedule: { name: "Swim (new)" } } });
        res.totals = { classes: 1, sessions: 99, bookings: 7, amount_indicative: 1234.5 };
        return { status: 200, body: res };
      },
    });
    const { out } = await run({ bookings: "none", classes: [{ schedule_id: 1 }] });
    expect(out.totals).toEqual({ classes: 1, sessions: 99, bookings: 7, amount_indicative: 1234.5 });
    expect(out.classes[0].name).toBe("Swim (new)");
    expect(out.classes[0].bookings).toEqual({ count: 2, amount_indicative: 43.34 });
    expect(out.scope).toMatch(/: 99 sessions, no bookings \(clients are not copied\)\. Nobody is emailed\.$/);
  });

  it("a booking with a notice (e.g. cancelled since) is listed as not_carried, not counted or summed", async () => {
    stub({
      ...TWO,
      preflight: (body) => ({
        status: 200,
        body: pfResponse(body, {
          "1": { bookings: [pfBooking(11, 50), { ...pfBooking(12, 0), target_status: null, notice: "booking_status_changed" }] },
        }),
      }),
    });
    const { out } = await run({ classes: [{ schedule_id: 1 }] });
    expect(out.classes[0].bookings).toEqual({
      count: 1, amount_indicative: 50, not_carried: [{ registration_id: 12, notice: "booking_status_changed" }],
    });
  });

  it("a progression shows new_programme, and flags plus cancelled sessions are carried", async () => {
    stub({ ...TWO, events: { 1: weekly(1, "2026-09-07", 10, (i) => (i === 2 ? { status: "unplanned" } : {})) } });
    const { out } = await run({ session_count: 16, classes: [{ schedule_id: 1, course_id: 971 }] });
    expect(out.classes[0].programme).toEqual({ id: 964, name: "Swim 1" });
    expect(out.classes[0].new_programme).toEqual({ id: 971, name: "Swim 2" });
    expect(out.classes[0].flags).toEqual(expect.arrayContaining(["ends_after_period", "cancelled_sessions_in_source: 1"]));
  });

  it("a 4xx preflight passes api-v1's text through; a 5xx aborts; neither issues a token", async () => {
    stub({
      ...TWO,
      preflight: () => ({ status: 400, body: { error_log_raw: [{ key: "resource_not_found", val: "Programme not found" }] } }),
    });
    const four = await run({ classes: [{ schedule_id: 1 }] });
    expect(four.r.isError).toBe(true);
    expect(four.text).toBe("Zooza refused the copy: Programme not found. Nothing was copied.");

    vi.unstubAllGlobals();
    stub({ ...TWO, preflight: () => ({ status: 502, body: { errors: ["bad gateway"] } }) });
    const five = await run({ classes: [{ schedule_id: 1 }] });
    expect(five.r.isError).toBe(true);
    expect(five.text).toMatch(/^Zooza's dry run of the copy failed \(api-v1 502: bad gateway\)\. Nothing was copied/);
    expect(five.text).not.toMatch(/ccp_/);
  });

  it("a price override takes a second preflight with the mapped field; only that one drives the preview", async () => {
    const { calls } = stub({
      ...TWO,
      preflight: (body, n) => {
        const res = pfResponse(body, {
          "1": {
            schedule: { price_hints: { course_price: 60, course_registration_fee: 0, price_field: "unit_price" } },
            bookings: n === 1 ? [pfBooking(11, 60)] : [pfBooking(11, 95)],
          },
        });
        return { status: 200, body: res };
      },
    });
    const { out } = await run({ classes: [{ schedule_id: 1, price: 95 }, { schedule_id: 2 }] });
    const pf = preflights(calls);
    expect(pf).toHaveLength(2);
    expect(pf[0].body.classes["1"].overrides).toEqual({ billing_period_id: 412 });
    expect(pf[1].body.classes["1"].overrides).toEqual({ billing_period_id: 412, unit_price: 95 });
    expect(pf[1].body.classes["2"].overrides).toEqual({ billing_period_id: 412 });
    expect(out.classes[0].bookings.amount_indicative).toBe(95);

    // The frozen body is the mapped one.
    await runCopyClass({ token: out.token, confirmed: true }, AUTH);
    expect(commits(calls)[0].body).toEqual(pf[1].body);
  });

  it("price maps to price when price_hints say so", async () => {
    const { calls } = stub(TWO);
    await run({ classes: [{ schedule_id: 1, price: 70 }] });
    expect(preflights(calls)[1].body.classes["1"].overrides).toEqual({ billing_period_id: 412, price: 70 });
  });

  it("a failed error check in a class means no token, with the check text and a fix-or-drop sentence", async () => {
    stub({
      ...TWO,
      preflight: (body) => ({
        status: 200,
        body: pfResponse(body, {
          "1": {
            checks: pfChecks({
              already_copied_to_billing_period: { data: { schedule_ids: [1070555] } },
              capacity_below_bookings: { data: { capacity: 1, seats: 2 } },
            }),
          },
        }),
      }),
    });
    const { r, out } = await run({ classes: [{ schedule_id: 1 }, { schedule_id: 2 }] });
    expect(r.isError).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.classes[0].checks).toEqual([
      'error: "Class 1" already has a copy in "Spring 2027" (class 1070555). Drop it from the chunk, or set allow_repeat_copy: true if a second copy is intended.',
      "warning: Capacity 1 is below the 2 seats the carried bookings take.",
    ]);
    expect(out.classes[1].checks).toEqual([]);
    expect(out.blocked).toBe(
      "No token: an error check failed for class 1. Fix or drop that class (see each class's checks), then preview again.",
    );
  });

  it("booking_refused blocks too; a job-level error check blocks the whole chunk", async () => {
    stub({
      ...TWO,
      preflight: (body) => ({
        status: 200,
        body: pfResponse(
          body,
          { "2": { checks: pfChecks({ booking_refused: { data: { bookings: [{ registration_id: 21, error: "invalid_registration_status" }] } } }) } },
          { class_cap: { name: "class_cap", result: "not_passed", severity: "error", data: { classes: 26, max: 25 } } },
        ),
      }),
    });
    const { out } = await run({ classes: [{ schedule_id: 1 }, { schedule_id: 2 }] });
    expect(out.token).toBeUndefined();
    expect(out.classes[1].checks).toEqual(["error: Zooza would refuse to carry booking 21 (invalid_registration_status)."]);
    expect(out.checks).toEqual(["error: 26 classes is more than the 25 one copy takes."]);
    expect(out.blocked).toMatch(/^No token: an error check failed for class 2, the whole chunk\. Fix or drop those classes/);
  });

  it("only warnings or notices failed: the token is issued and the checks are listed", async () => {
    stub({
      ...TWO,
      preflight: (body) => ({
        status: 200,
        body: pfResponse(body, {
          "1": {
            checks: pfChecks({
              already_copied_to_billing_period: { severity: "notice", data: { schedule_ids: [1070555] } },
              unknown_block_names: { data: { names: ["tuesday"] } },
            }),
          },
        }),
      }),
    });
    const { out } = await run({ classes: [{ schedule_id: 1, allow_repeat_copy: true }] });
    expect(out.token).toMatch(/^ccp_/);
    expect(out.blocked).toBeUndefined();
    expect(out.classes[0].checks).toEqual([
      'notice: "Class 1" already has a copy in "Spring 2027" (class 1070555); a second copy is made, as asked with allow_repeat_copy.',
      "warning: Block tuesday is not a block of the source class; Zooza would create it as a new block.",
    ]);
  });

  it("needs_decision still makes no preflight call", async () => {
    const { calls } = stub({ ...TWO, holidays: { 16: [MAY_DAY] }, regions: { 16: "SK-BA" } });
    const { out } = await run({ classes: [{ schedule_id: 1 }] });
    expect(out.status).toBe("needs_decision");
    expect(copyPosts(calls)).toHaveLength(0);
  });

  it("holiday decisions are echoed in the preview", async () => {
    stub({ ...TWO, holidays: { 16: [MAY_DAY] }, regions: { 16: "SK-BA" } });
    const decisions = [{ holiday_id: 9031, action: "skip" }];
    const { out } = await run({ classes: [{ schedule_id: 1 }], holiday_decisions: decisions });
    expect(out.holiday_decisions).toEqual(decisions);
    expect(out.token).toMatch(/^ccp_/);
  });
});

describe("classes_copy_class phase 2 — apply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearClassCopyPlanStore();
  });

  async function preview(w: World = TWO, classes: unknown[] = [{ schedule_id: 1 }]) {
    const s = stub(w);
    const { out } = await run({ classes });
    return { ...s, token: out.token as string, frozen: preflights(s.calls).at(-1)!.body };
  }

  it("POSTs the frozen body once, without the preflight action; a one-class job comes back completed", async () => {
    const { calls, token, frozen } = await preview();
    const r = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(r.isError).toBeUndefined();
    const c = commits(calls);
    expect(c).toHaveLength(1);
    expect(c[0].method).toBe("POST");
    expect(c[0].body).toEqual(frozen);
    expect(JSON.parse(r.content[0].text)).toEqual({
      job_id: 88,
      status: "completed",
      classes: [
        { source_schedule_id: 1, status: "completed", new_schedule_id: 1070001, bookings_copied: 1, bookings_skipped: 1, amount_charged: 60 },
      ],
      next: 'Copied. classes_show_copy_progress for billing period "Spring 2027" (412) shows what is left to copy.',
    });
  });

  it("a queued batch job returns its id and how to follow it", async () => {
    const w: World = { ...TWO, apply: { status: 200, body: jobResponse({ classes: { "1": {}, "2": {} } }, "queued", 91) } };
    const { token } = await preview(w, [{ schedule_id: 1 }, { schedule_id: 2 }]);
    const out = JSON.parse((await runCopyClass({ token, confirmed: true }, AUTH)).content[0].text);
    expect(out.job_id).toBe(91);
    expect(out.status).toBe("queued");
    expect(out.classes.map((x: { new_schedule_id: unknown }) => x.new_schedule_id)).toEqual([null, null]);
    expect(out.next).toMatch(/^Job 91 is queued\. Follow it with classes_show_copy_progress job_id:91 in a minute \(the period view, for billing period "Spring 2027" \(412\)/);
  });

  it("fields the model sends at apply time never reach api-v1", async () => {
    const { calls, token, frozen } = await preview();
    // A preview input riding along with the token is refused before any write.
    const stray = await runCopyClass(
      { token, confirmed: true, classes: [{ schedule_id: 1, name: "Hacked" }], target_billing_period_id: 999 },
      AUTH,
    );
    expect(stray.isError).toBe(true);
    expect(commits(calls)).toHaveLength(0);
    // company_id is wrapper-injected and tolerated, but the write goes to the plan's company.
    const ok = await runCopyClass({ token, confirmed: true, company_id: 999 }, AUTH);
    expect(ok.isError).toBeUndefined();
    const c = commits(calls);
    expect(c).toHaveLength(1);
    expect(c[0].body).toEqual(frozen);
    expect(c[0].company).toBe("1");
    expect(JSON.stringify(c[0].body)).not.toMatch(/Hacked|999/);
  });

  it("a token is single-use", async () => {
    const { calls, token } = await preview();
    await runCopyClass({ token, confirmed: true }, AUTH);
    const again = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/token is used/);
    expect(commits(calls)).toHaveLength(1);
  });

  it("a 4xx returns api-v1's text", async () => {
    const w: World = {
      ...TWO,
      apply: {
        status: 400,
        body: { error_log_raw: [{ key: "schedule_already_copied_to_billing_period", val: "Class is already copied to this billing period" }] },
      },
    };
    const { calls, token } = await preview(w);
    const r = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(
      /^Zooza refused the copy: schedule_already_copied_to_billing_period: Class is already copied to this billing period\. Nothing was copied\./,
    );
    expect(commits(calls)).toHaveLength(1);
  });

  it("a refusal whose value alone says nothing still names api-v1's key (live: a bare \"Schedule\")", async () => {
    const w: World = { ...TWO, apply: { status: 400, body: { error_log_raw: [{ key: "insert_failed", val: "Schedule" }] } } };
    const { token } = await preview(w);
    const r = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(r.content[0].text).toMatch(/^Zooza refused the copy: insert_failed: Schedule\./);
  });

  it("a temporarily failed class is retryable once; a second job failing it, or a real error, goes to the operator", async () => {
    resetRetryLedger();
    const failedJob = (id: number, key: string, data: unknown = { sessions: 5, created: 4 }) => ({
      job: {
        id, type: "schedule_copy", status: "failed", deduplicated: false,
        steps: [
          { id: 1, seq: 1, source_schedule_id: 1, status: "failed", result: null, error: { key, data } },
          { id: 2, seq: 2, source_schedule_id: 2, status: "completed", result: { schedule_id: 1070002, bookings: [] } },
        ],
      },
    });
    const apply = async (body: unknown) => {
      const { token } = await preview({ ...TWO, apply: { status: 200, body } }, [{ schedule_id: 1 }, { schedule_id: 2 }]);
      return JSON.parse((await runCopyClass({ token, confirmed: true }, AUTH)).content[0].text);
    };
    // api-v1 6c023963: a database error api-v1's own retries could not clear says retryable: true.
    const first = await apply(failedJob(597, "internal_error", { value: "db_error", db_error: "Deadlock found", retryable: true, attempts: 3 }));
    expect(first.classes[0]).toMatchObject({ status: "failed", retryable: true });
    expect(first.classes[0].error).toMatch(/^internal_error: .*Deadlock found/);
    expect(first.classes[1].retryable).toBeUndefined();
    expect(first.next).toMatch(/Class 1 failed with a temporary error \(retryable: true\)\. The operator already approved this copy/);
    // The same failed job read again does not use up the retry; a second job does.
    vi.unstubAllGlobals();
    const second = await apply(failedJob(604, "internal_error", { value: "db_error", db_error: "Deadlock found", retryable: true, attempts: 3 }));
    expect(second.classes[0].retryable).toBe(false);
    expect(second.next).toMatch(/Class 1: tell the operator why it failed/);
    vi.unstubAllGlobals();
    resetRetryLedger();
    const real = await apply(failedJob(610, "capacity_exceeded"));
    expect(real.classes[0].retryable).toBe(false);
    // insert_failed is no longer the deadlock's disguise: a real problem, never auto-retried.
    vi.unstubAllGlobals();
    expect((await apply(failedJob(611, "insert_failed"))).classes[0].retryable).toBe(false);
    vi.unstubAllGlobals();
    expect((await apply(failedJob(612, "internal_error", { value: "db_error", db_error: "Duplicate entry", retryable: false }))).classes[0].retryable).toBe(false);
  });

  it.each([
    ["a 5xx", { status: 503, body: { errors: ["unavailable"] } } as World["apply"]],
    ["a dropped connection", "throw" as const],
    ["a 2xx without a job", { status: 200, body: {} } as World["apply"]],
  ])("%s returns the do-NOT-call-again text, one POST, and burns the token", async (_, apply) => {
    const { calls, token } = await preview({ ...TWO, apply });
    const r = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text.startsWith(
      'Zooza did not confirm the copy. Do NOT call again; check classes_show_copy_progress for billing period "Spring 2027" (412) first.',
    )).toBe(true);
    expect(commits(calls)).toHaveLength(1);
    const again = await runCopyClass({ token, confirmed: true }, AUTH);
    expect(again.content[0].text).toMatch(/token is used/);
    expect(commits(calls)).toHaveLength(1);
  });

  it("an unknown token is refused without a write", async () => {
    const { calls } = stub(TWO);
    const r = await runCopyClass({ token: "ccp_nope", confirmed: true }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/token is unknown/);
    expect(calls).toHaveLength(0);
  });
});
