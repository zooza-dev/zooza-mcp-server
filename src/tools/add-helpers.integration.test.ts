import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { isoWeekday, runAddHelpers } from "./add-helpers.js";
import { clearUpdatePlanStore } from "./update-plan-store.js";

/**
 * trainers_add_helpers (ZMCP-20260908-001) over mocked HTTP, so the real query
 * assembly, phase dispatch and write ordering all execute.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

const MARTIN = 11031;
const PETER = 11145;

interface FetchCall {
  path: string;
  method: string;
  query: URLSearchParams;
  body: any;
}
let calls: FetchCall[] = [];
type Handler = (c: FetchCall) => Response;

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
function fail(status: number): Response {
  return { ok: false, status, text: async () => "upstream boom" } as unknown as Response;
}
function installFetch(handler: Handler): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = new URL(String(input));
      const call: FetchCall = {
        path: url.pathname,
        method: (init?.method ?? "GET").toUpperCase(),
        query: url.searchParams,
        body: init?.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
}
function text(r: unknown): string {
  return (r as { content: Array<{ text: string }> }).content[0].text;
}
function isError(r: unknown): boolean {
  return Boolean((r as { isError?: boolean }).isError);
}
function payload(r: unknown): any {
  return JSON.parse(text(r));
}

/** Mondays 2/9, Tuesdays 3/10, Wednesdays 4/11 of Nov 2026 — weekday-stable. */
const SESSIONS = [
  { id: 1, date: "2026-11-02 17:30:00" }, // Mon
  { id: 2, date: "2026-11-03 17:30:00" }, // Tue
  { id: 3, date: "2026-11-04 17:30:00" }, // Wed
  { id: 4, date: "2026-11-09 17:30:00" }, // Mon
  { id: 5, date: "2026-11-06 17:30:00" }, // Fri
];

const SCHEDULE = { id: 6835, name: "Junior", trainers_schedules: [] as any[] };

function events(assigned: Record<number, number[]> = {}) {
  return {
    total: SESSIONS.length,
    data: SESSIONS.map((s) => ({
      ...s,
      schedule_id: 6835,
      trainers_events: (assigned[s.id] ?? []).map((t) => ({ trainer_id: t, role: "secondary" })),
    })),
  };
}

const USERS = {
  total: 2,
  data: [
    { id: MARTIN, first_name: "Martin", last_name: "Novák" },
    { id: PETER, first_name: "Peter", last_name: "Kováč" },
  ],
};

function standardHandler(opts: { schedules?: any; events?: any; write?: Handler } = {}): Handler {
  return (c) => {
    if (c.method !== "GET" && opts.write) return opts.write(c);
    if (c.method !== "GET") return ok({});
    if (c.path === "/schedules") return ok(opts.schedules ?? { total: 1, data: [SCHEDULE] });
    if (c.path === "/events") return ok(opts.events ?? events());
    if (c.path === "/users") return ok(USERS);
    return ok({});
  };
}

beforeEach(() => clearUpdatePlanStore());
afterEach(() => vi.unstubAllGlobals());

describe("isoWeekday", () => {
  it("maps 1=Mon … 7=Sun from the date part, independent of host timezone", () => {
    expect(isoWeekday("2026-11-02 17:30:00")).toBe(1);
    expect(isoWeekday("2026-11-08 23:59:59")).toBe(7);
    // A late-evening session must not roll into the next weekday.
    expect(isoWeekday("2026-11-04 23:30:00")).toBe(3);
    expect(isoWeekday("nonsense")).toBeNull();
  });
});

describe("preview — validation", () => {
  it("refuses when neither selector is given", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers({ company_id: 1, assignments: [{ trainer_id: MARTIN }] }, AUTH);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("either schedule_ids, or course_id");
  });

  it("refuses course_id without billing_period_id", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      { company_id: 1, course_id: 963, assignments: [{ trainer_id: MARTIN }] },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("billing_period_id");
  });

  it("refuses an unrestricted assignment with no session_scope", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: MARTIN }] },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("session_scope");
  });

  it("refuses two different roles for the same trainer", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      {
        company_id: 1,
        schedule_ids: [6835],
        assignments: [
          { trainer_id: MARTIN, role: "helper", weekdays: [1] },
          { trainer_id: MARTIN, role: "assistant", weekdays: [3] },
        ],
      },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("ONE role per class");
  });

  it("refuses event_ids outside the selected classes", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      {
        company_id: 1,
        schedule_ids: [6835],
        assignments: [{ trainer_id: MARTIN, event_ids: [999] }],
      },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("do not belong to the selected classes");
  });

  it("refuses an unknown trainer id", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: 4242, weekdays: [1] }] },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("not a trainer in this company");
  });

  it("reports when the selector matches no classes", async () => {
    installFetch(standardHandler({ schedules: { total: 0, data: [] } }));
    const r = await runAddHelpers(
      {
        company_id: 1,
        course_id: 963,
        billing_period_id: 310,
        assignments: [{ trainer_id: MARTIN, weekdays: [1] }],
      },
      AUTH,
    );
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("No classes found");
  });

  it("reads sessions with filter=filter — without it schedule_id is ignored upstream", async () => {
    installFetch(standardHandler());
    await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      AUTH,
    );
    const ev = calls.find((c) => c.path === "/events")!;
    expect(ev.query.get("filter")).toBe("filter");
    expect(ev.query.get("schedule_id")).toBe("6835");
  });
});

describe("preview — the operator's sentence", () => {
  it("plans Martin Mon+Wed and Peter Tue+Wed without writing anything", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      {
        company_id: 1,
        schedule_ids: [6835],
        assignments: [
          { trainer_id: MARTIN, weekdays: [1, 3] },
          { trainer_id: PETER, weekdays: [2, 3] },
        ],
      },
      AUTH,
    );
    expect(isError(r)).toBe(false);
    const { token, summary } = payload(r);
    expect(token).toMatch(/^upd_helpers_/);
    // Martin: Mon(1), Wed(3), Mon(4) = 3. Peter: Tue(2), Wed(3) = 2.
    expect(summary.totals.sessions_activate).toBe(5);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("merges repeat entries for one trainer instead of conflicting", async () => {
    installFetch(standardHandler());
    const r = await runAddHelpers(
      {
        company_id: 1,
        schedule_ids: [6835],
        assignments: [
          { trainer_id: MARTIN, weekdays: [1] },
          { trainer_id: MARTIN, weekdays: [3] },
        ],
      },
      AUTH,
    );
    const { summary } = payload(r);
    expect(summary.totals.trainers).toBe(1);
    expect(summary.totals.sessions_activate).toBe(3); // Mon, Mon, Wed
  });

  it("reports assignments outside the rules and leaves them alone by default", async () => {
    // Martin is already on session 5 (a Friday), which no rule mentions.
    installFetch(standardHandler({ events: events({ 5: [MARTIN] }) }));
    const r = await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      AUTH,
    );
    const { summary } = payload(r);
    expect(summary.existing_outside_rules).toHaveLength(1);
    expect(summary.existing_outside_rules[0]).toMatchObject({
      trainer_id: MARTIN,
      sessions: 1,
      weekdays: [5],
    });
    expect(summary.existing_outside_rules[0].note).toContain("left as-is");
    expect(summary.totals.sessions_deactivate).toBe(0);
  });

  it("clears them only when clear_unlisted is set", async () => {
    installFetch(standardHandler({ events: events({ 5: [MARTIN] }) }));
    const r = await runAddHelpers(
      {
        company_id: 1,
        schedule_ids: [6835],
        assignments: [{ trainer_id: MARTIN, weekdays: [1] }],
        clear_unlisted: true,
      },
      AUTH,
    );
    const { summary } = payload(r);
    expect(summary.totals.sessions_deactivate).toBe(1);
    expect(summary.existing_outside_rules[0].note).toContain("REMOVED");
  });

  it("skips sessions where the lecturer is already assigned (idempotent plan)", async () => {
    installFetch(standardHandler({ events: events({ 1: [MARTIN], 4: [MARTIN] }) }));
    const r = await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      AUTH,
    );
    const { summary } = payload(r);
    expect(summary.totals.sessions_activate).toBe(0);
  });

  it("spells out the session cascade of a class-level removal", async () => {
    installFetch(
      standardHandler({
        schedules: {
          total: 1,
          data: [{ ...SCHEDULE, trainers_schedules: [{ trainer_id: PETER, role: "helper" }] }],
        },
        events: events({ 1: [PETER], 2: [PETER] }),
      }),
    );
    const r = await runAddHelpers({ company_id: 1, schedule_ids: [6835], remove_from_class: [PETER] }, AUTH);
    const { summary } = payload(r);
    const change = summary.classes[0].changes[0];
    expect(change).toMatchObject({ class_roster: "remove", sessions_cleared: 2 });
    expect(change.warning).toContain("cannot be undone");
  });
});

describe("commit — write ordering and shape", () => {
  async function previewThenCommit(args: Record<string, unknown>, handler: Handler) {
    installFetch(handler);
    const prev = await runAddHelpers({ company_id: 1, ...args }, AUTH);
    expect(isError(prev)).toBe(false);
    const { token } = payload(prev);
    calls = [];
    const applied = await runAddHelpers({ company_id: 1, token, confirmed: true }, AUTH);
    return { applied, token };
  }

  it("writes the class roster BEFORE any session — a session write without it inserts role NULL", async () => {
    const { applied } = await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      standardHandler(),
    );
    expect(isError(applied)).toBe(false);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes[0]).toMatchObject({
      path: `/schedules/6835/trainers/${MARTIN}`,
      method: "PUT",
      body: { role: "secondary", update_mode: "schedule" },
    });
    expect(writes.slice(1).every((c) => c.path.startsWith("/events/"))).toBe(true);
  });

  it("sends ONLY additional_trainers on an event PUT, so nothing else is disturbed", async () => {
    await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [3] }] },
      standardHandler(),
    );
    const ev = calls.find((c) => c.path.startsWith("/events/"))!;
    expect(Object.keys(ev.body)).toEqual(["additional_trainers"]);
    expect(ev.body.additional_trainers).toEqual([{ trainer_id: MARTIN, is_active: true }]);
  });

  it("batches several lecturers changing on ONE session into a single event call", async () => {
    await previewThenCommit(
      {
        schedule_ids: [6835],
        assignments: [
          { trainer_id: MARTIN, weekdays: [3] },
          { trainer_id: PETER, weekdays: [3] },
        ],
      },
      standardHandler(),
    );
    const eventCalls = calls.filter((c) => c.path.startsWith("/events/"));
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].body.additional_trainers).toHaveLength(2);
  });

  it("an UNRESTRICTED assignment issues no event calls at all — api-v1 fans out", async () => {
    const { applied } = await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN }], session_scope: "upcoming" },
      standardHandler(),
    );
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0].body.update_mode).toBe("upcoming");
    expect(payload(applied).applied[0].session_writes).toBe(0);
  });

  it("maps class_only to the app's update_mode spelling", async () => {
    await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN }], session_scope: "class_only" },
      standardHandler(),
    );
    expect(calls.find((c) => c.method === "PUT")!.body.update_mode).toBe("schedule");
  });

  it("removes a lecturer from the class with DELETE, after the other writes", async () => {
    const { applied } = await previewThenCommit(
      { schedule_ids: [6835], remove_from_class: [PETER] },
      standardHandler({
        schedules: {
          total: 1,
          data: [{ ...SCHEDULE, trainers_schedules: [{ trainer_id: PETER, role: "helper" }] }],
        },
        events: events({ 1: [PETER] }),
      }),
    );
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.at(-1)).toMatchObject({
      path: `/schedules/6835/trainers/${PETER}`,
      method: "DELETE",
    });
    expect(payload(applied).applied[0].roster_deletes).toBe(1);
  });

  it("skips a trainer's session writes when their roster write failed", async () => {
    const { applied } = await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      standardHandler({
        write: (c) => (c.path.includes("/trainers/") ? fail(500) : ok({})),
      }),
    );
    expect(calls.filter((c) => c.path.startsWith("/events/"))).toHaveLength(0);
    const out = payload(applied);
    expect(out.updated).toBe(false);
    expect(out.applied[0].failed[0]).toContain("session changes in this class were skipped");
  });

  it("reports partial failure per class and keeps the token re-usable", async () => {
    let seen = 0;
    const { applied, token } = await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      standardHandler({
        write: (c) => {
          if (c.path.startsWith("/events/")) {
            seen += 1;
            return seen === 1 ? fail(502) : ok({});
          }
          return ok({});
        },
      }),
    );
    const out = payload(applied);
    expect(out.updated).toBe(false);
    expect(out.classes_applied).toBe("0 of 1");
    expect(out.note).toContain("re-running the same token is safe");

    // Token NOT burned — the retry must be possible.
    installFetch(standardHandler());
    const retry = await runAddHelpers({ company_id: 1, token, confirmed: true }, AUTH);
    expect(isError(retry)).toBe(false);
  });

  it("burns the token after a clean run", async () => {
    const { token } = await previewThenCommit(
      { schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      standardHandler(),
    );
    installFetch(standardHandler());
    const again = await runAddHelpers({ company_id: 1, token, confirmed: true }, AUTH);
    expect(isError(again)).toBe(true);
    expect(text(again)).toContain("no longer valid");
  });

  it("refuses to apply without confirmed:true", async () => {
    installFetch(standardHandler());
    const prev = await runAddHelpers(
      { company_id: 1, schedule_ids: [6835], assignments: [{ trainer_id: MARTIN, weekdays: [1] }] },
      AUTH,
    );
    const { token } = payload(prev);
    const r = await runAddHelpers({ company_id: 1, token }, AUTH);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("confirmed: true");
  });
});
