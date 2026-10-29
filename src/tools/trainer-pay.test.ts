import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindEvents } from "./find-events.js";
import { runGetAttendance } from "./get-attendance.js";

/**
 * Spec ZMCP-20261009-011 — additional trainers in attendance + trainer pay.
 * Spec ZMCP-20261029-001 — pay is read from api-v1 (`load_pay`), never derived here:
 * the fixtures carry api-v1's `pay` sub-resource and the tests check only the mapping.
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

/**
 * api-test event 78175: main 11083 + secondary 11081, rate type 6, 60 min, 100%.
 * `pay` is what api-v1 attaches with load_pay=1 (`Trainer_Pay::for_events`).
 */
const PAY_78175 = {
  rate_type_id: 6,
  rate_type: "per_minute",
  payout_percentage: 1,
  minutes: 60,
  main_trainer: { trainer_id: 11083, to_pay: 10 },
  additional_trainers: [{ trainer_id: 11081, to_pay: 10 }],
};
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
  pay: PAY_78175,
};
/** api-test event 59772: helpers have no rate for type 2, so api-v1 pays them 0. */
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
  pay: {
    rate_type_id: 2,
    rate_type: "per_minute",
    payout_percentage: 1,
    minutes: 60,
    main_trainer: { trainer_id: 645, to_pay: 26.66 },
    additional_trainers: [
      { trainer_id: 11079, to_pay: 0 },
      { trainer_id: 11094, to_pay: 0 },
    ],
  },
};

function payHandler(events: unknown[]) {
  return (c: FetchCall) => {
    if (c.path === "/events") return ok({ total: events.length, data: events });
    if (c.path === "/users") return ok(USERS);
    return ok({});
  };
}

describe("sessions_find_events — trainer pay read from api-v1 (ZMCP-20261029-001)", () => {
  it("asks for load_pay and maps main AND additional pay without any rate lookup", async () => {
    installFetch(payHandler([EV_78175]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];

    expect(calls.find((c) => c.path === "/events")!.query.get("load_pay")).toBe("1");
    expect(calls.filter((c) => c.path.startsWith("/trainer_rates"))).toHaveLength(0);
    expect(ev.pay).toEqual({
      rate_type_id: 6,
      rate_type: "per_minute",
      payout_percentage: 1,
      minutes: 60,
      main_trainer: { amount: 10 },
    });
    expect(ev.additional_trainers).toEqual([
      { trainer_id: 11081, trainer_name: "Eva Farkašová", role: "secondary", pay: { amount: 10 } },
    ]);
  });

  it("keeps to_pay 0 (no rate set) as amount 0", async () => {
    installFetch(payHandler([EV_59772]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [59772] }, AUTH)).events[0];
    expect(ev.pay.main_trainer).toEqual({ amount: 26.66 });
    expect(ev.additional_trainers.map((t: any) => t.pay)).toEqual([{ amount: 0 }, { amount: 0 }]);
  });

  it("keeps another trainer's hidden to_pay as amount null, never 0", async () => {
    const hidden = {
      ...PAY_78175,
      main_trainer: { trainer_id: 11083, to_pay: null },
    };
    installFetch(payHandler([{ ...EV_78175, pay: hidden }]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.pay.main_trainer).toEqual({ amount: null });
    expect(ev.additional_trainers[0].pay).toEqual({ amount: 10 });
  });

  it("passes pay: null through (no rate type / no financial access) with no warning", async () => {
    installFetch(payHandler([{ ...EV_78175, pay: null }]));
    const res = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH));
    expect(res.events[0].pay).toBeNull();
    expect(res.events[0].additional_trainers[0].pay).toBeNull();
    expect(res.meta.warnings ?? []).toEqual([]);
  });

  it("returns null pay plus a warning when the API ignored load_pay", async () => {
    const { pay: _omit, ...withoutPay } = EV_78175;
    installFetch(payHandler([withoutPay]));
    const res = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH));
    expect(res.events[0].pay).toBeNull();
    expect(res.events[0].additional_trainers[0].pay).toBeNull();
    expect(res.meta.warnings.join(" ")).toMatch(/pay unavailable/i);
  });

  it("returns main_trainer null when the session has no main trainer", async () => {
    installFetch(payHandler([{ ...EV_78175, trainer_id: 0, pay: { ...PAY_78175, main_trainer: null } }]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.pay.main_trainer).toBeNull();
  });

  it("gives an additional trainer with no pay entry null pay", async () => {
    installFetch(payHandler([{ ...EV_78175, pay: { ...PAY_78175, additional_trainers: [] } }]));
    const ev = structured(await runFindEvents({ company_id: 1, ids: [78175] }, AUTH)).events[0];
    expect(ev.additional_trainers[0].pay).toBeNull();
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
