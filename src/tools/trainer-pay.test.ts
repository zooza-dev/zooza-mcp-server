import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindEvents } from "./find-events.js";
import { runGetAttendance } from "./get-attendance.js";

/**
 * Spec ZMCP-20261009-011 — additional trainers in attendance + trainer pay.
 *
 * Pay fixtures are the live api-test rows the GATE was verified on (2026-10-09,
 * company 1): the expected `amount`s are the `to_pay` figures GET
 * /users/{id}/report returned for those sessions, not values derived here.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

interface FetchCall {
  path: string;
  query: URLSearchParams;
}
let calls: FetchCall[] = [];

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
function fail(status: number): Response {
  return { ok: false, status, text: async () => "boom" } as unknown as Response;
}
function installFetch(handler: (call: FetchCall) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const call: FetchCall = { path: url.pathname, query: url.searchParams };
      calls.push(call);
      return handler(call);
    }),
  );
}
function structured<T = any>(r: unknown): T {
  return (r as { structuredContent: T }).structuredContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const USERS = {
  total: 3,
  data: [
    { id: 11081, first_name: "Eva", last_name: "Farkašová" },
    { id: 11083, first_name: "Main", last_name: "Trainer" },
    { id: 11079, first_name: "Jana", last_name: "Helper" },
  ],
};

/** Live api-test /trainer_rates rows used by the fixtures (unit_amount per minute). */
const RATES = {
  total: 4,
  data: [
    { id: 34, trainer_id: 11083, rate_id: 6, unit_amount: 0.1667 },
    { id: 35, trainer_id: 11081, rate_id: 6, unit_amount: 0.1667 },
    { id: 15, trainer_id: 645, rate_id: 2, unit_amount: 0.4444 },
    { id: 99, trainer_id: 11083, rate_id: 50, unit_amount: 12.5 },
  ],
};
const RATE_TYPES = {
  total: 3,
  data: [
    { id: 2, name: "Senior", minutes: 45, type: "per_minute" },
    { id: 6, name: "Test", minutes: 60, type: "per_minute" },
    { id: 50, name: "Per class", minutes: 0, type: "fixed" },
  ],
};

/** api-test event 78175: main 11083 + secondary 11081, rate type 6, 60 min, 100%. */
const EV_78175 = {
  id: 78175,
  schedule_id: 7441,
  date: "2025-06-02 10:30:00",
  status: "scheduled",
  duration: 60,
  trainer_id: 11083,
  trainer_rate_type_id: 6,
  trainer_payout_percentage: 1,
  schedule: { id: 7441, duration: 60 },
  trainers_events: [{ trainer_id: 11081, role: "secondary" }],
};
/** api-test event 59772: duration 0 → falls back to the class's 60; helpers have no rate 2. */
const EV_59772 = {
  id: 59772,
  schedule_id: 6215,
  date: "2023-08-28 20:30:00",
  status: "scheduled",
  duration: 0,
  trainer_id: 645,
  trainer_rate_type_id: 2,
  trainer_payout_percentage: 1,
  schedule: { id: 6215, duration: 60 },
  trainers_events: [
    { trainer_id: 11079, role: "secondary" },
    { trainer_id: 11094, role: "assistant" },
  ],
};

function payHandler(events: unknown[], rates: () => Response = () => ok(RATES)) {
  return (c: FetchCall) => {
    if (c.path === "/events") return ok({ total: events.length, data: events });
    if (c.path === "/users") return ok(USERS);
    if (c.path === "/trainer_rates") return rates();
    if (c.path === "/trainer_rates/types") return ok(RATE_TYPES);
    return ok({});
  };
}

describe("sessions_find_events — trainer pay (mirrors the trainer report)", () => {
  it("matches the report for main AND additional trainer (event 78175)", async () => {
    installFetch(payHandler([EV_78175]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];

    expect(ev.pay).toEqual({
      rate_type_id: 6,
      rate_type: "per_minute",
      payout_percentage: 1,
      minutes: 60,
      // report to_pay for trainer 11083: 10.00 (main row is ROUND(…, 2))
      main_trainer: { unit_amount: 0.1667, amount: 10 },
    });
    // report to_pay for trainer 11081: 10.002 (additional rows are not rounded)
    expect(ev.additional_trainers).toEqual([
      {
        trainer_id: 11081,
        trainer_name: "Eva Farkašová",
        role: "secondary",
        pay: { unit_amount: 0.1667, amount: 10.002 },
      },
    ]);
  });

  it("uses the class duration when the session's is 0, and pays 0 with no rate (event 59772)", async () => {
    installFetch(payHandler([EV_59772]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [59772] }, AUTH)).events[0];

    expect(ev.pay.minutes).toBe(60);
    // report to_pay for trainer 645: 26.66
    expect(ev.pay.main_trainer).toEqual({ unit_amount: 0.4444, amount: 26.66 });
    // report to_pay for 11079 / 11094: 0 — neither has a rate for type 2
    expect(ev.additional_trainers.map((t: any) => t.pay)).toEqual([
      { unit_amount: null, amount: 0 },
      { unit_amount: null, amount: 0 },
    ]);
  });

  it("applies payout_percentage and skips minutes for a fixed rate type", async () => {
    installFetch(
      payHandler([{ ...EV_78175, trainer_rate_type_id: 50, trainer_payout_percentage: "0.5000" }]),
    );
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.pay.rate_type).toBe("fixed");
    expect(ev.pay.main_trainer).toEqual({ unit_amount: 12.5, amount: 6.25 });
    expect(ev.additional_trainers[0].pay).toEqual({ unit_amount: null, amount: 0 });
  });

  it("scales a per-minute rate by payout_percentage (cancelled sessions carry 0)", async () => {
    installFetch(payHandler([{ ...EV_78175, trainer_payout_percentage: 0 }]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.pay.main_trainer.amount).toBe(0);
    expect(ev.additional_trainers[0].pay.amount).toBe(0);
  });

  it("skips both rate lookups when no session has a rate type", async () => {
    installFetch(payHandler([{ ...EV_78175, trainer_rate_type_id: 0 }]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.pay).toBeNull();
    expect(ev.additional_trainers[0].pay).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/trainer_rates"))).toHaveLength(0);
  });

  it("fetches the rate table once per page", async () => {
    installFetch(payHandler([EV_78175, { ...EV_78175, id: 2 }, EV_59772]));
    await runFindEvents({ company_id: 1, schedule_id: 7441 }, AUTH);
    expect(calls.filter((c) => c.path === "/trainer_rates")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/trainer_rates/types")).toHaveLength(1);
  });

  it("degrades to null pay plus a warning when rates are not readable — never a fake 0", async () => {
    installFetch(payHandler([EV_78175], () => fail(403)));
    const res = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH));
    expect(res.events[0].pay).toBeNull();
    expect(res.events[0].additional_trainers[0].pay).toBeNull();
    expect(res.meta.warnings.join(" ")).toMatch(/pay unavailable/i);
  });

  it("keeps pay off the class roster", async () => {
    installFetch(
      payHandler([{ ...EV_78175, trainers_schedules: [{ trainer_id: 11081, role: "secondary" }] }]),
    );
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.class_additional_trainers[0]).not.toHaveProperty("pay");
  });
});

describe("sessions_get_attendance — additional trainers", () => {
  const DETAIL = {
    id: 78175,
    course_id: 10,
    course: { id: 10, registration_type: "full", track_attendance: 1 },
    trainers_events: [
      { trainer_id: 11081, role: "secondary" },
      { trainer_id: 11079, role: "helper" },
    ],
  };
  const ROWS = [{ registration_id: 1, status: "registered", customer: { first_name: "Ann" } }];

  function attendanceHandler(detail: unknown, users: () => Response = () => ok(USERS)) {
    return (c: FetchCall) => {
      if (c.path === "/attendance") return ok(ROWS);
      if (c.path === "/events") return ok({ total: 1, data: [detail] });
      if (c.path === "/users") return users();
      return ok({});
    };
  }

  it("returns the session's additional trainers with roles and names", async () => {
    installFetch(attendanceHandler(DETAIL));
    const res = await runGetAttendance({ company_id: 1, event_id: 78175 }, AUTH);
    expect(structured(res).additional_trainers).toEqual([
      { trainer_id: 11081, trainer_name: "Eva Farkašová", role: "secondary" },
      { trainer_id: 11079, trainer_name: "Jana Helper", role: "helper" },
    ]);
    expect(res.content[0].text).toContain("Eva Farkašová (Secondary instructor)");
    expect(res.content[0].text).toContain("Jana Helper (Assistant instructor)");
  });

  it("returns [] and skips the roster call when nobody else works the session", async () => {
    const { trainers_events: _omit, ...withoutHelpers } = DETAIL;
    installFetch(attendanceHandler(withoutHelpers));
    const res = structured(await runGetAttendance({ company_id: 1, event_id: 78175 }, AUTH));
    expect(res.additional_trainers).toEqual([]);
    expect(calls.filter((c) => c.path === "/users")).toHaveLength(0);
  });

  it("keeps ids and roles with null names when the roster lookup fails", async () => {
    installFetch(attendanceHandler(DETAIL, () => fail(500)));
    const res = structured(await runGetAttendance({ company_id: 1, event_id: 78175 }, AUTH));
    expect(res.additional_trainers[0]).toEqual({ trainer_id: 11081, trainer_name: null, role: "secondary" });
  });
});
