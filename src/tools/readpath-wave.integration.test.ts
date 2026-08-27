import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindClasses } from "./find-classes.js";
import { runFindEvents } from "./find-events.js";
import { runSessionsUpdate } from "./sessions-update.js";
import { clearUpdatePlanStore } from "./update-plan-store.js";

/**
 * Regression coverage for the sessions/classes read-path wave
 * (ZMCP-20260827-001..004). Mocks global fetch so the real query assembly runs
 * and we can assert exactly what hits api-v1.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

interface FetchCall {
  url: string;
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}
let calls: FetchCall[] = [];

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
function installFetch(handler: (call: FetchCall) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const call: FetchCall = {
        url,
        path: new URL(url).pathname,
        method: (init?.method ?? "GET").toUpperCase(),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
}
function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}
function eventsCall(): FetchCall {
  const c = calls.find((x) => x.path === "/events");
  if (!c) throw new Error("no /events call recorded");
  return c;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearUpdatePlanStore();
});

// ── ZMCP-20260827-001: sessions_update id resolution ─────────────────────────
describe("sessions_update — event resolution (Bug 1)", () => {
  it("resolves ids with filter=filter and NO status filter", async () => {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [{ id: 111, date: "2026-09-01 10:00:00" }] });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsUpdate(
      { company_id: 1, event_ids: [111], changes: { reschedule: { mode: "shift", days: 7 } } },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const get = eventsCall();
    expect(get.method).toBe("GET");
    expect(get.url).toContain("filter=filter");
    expect(get.url).not.toContain("status=");
  });

  it("reports the true missing ids (not a stale unrelated event)", async () => {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [{ id: 111, date: "2026-09-01 10:00:00" }] });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsUpdate(
      { company_id: 1, event_ids: [111, 222], changes: { reschedule: { mode: "shift", days: 7 } } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("222");
    expect(res.content[0].text).not.toContain("111");
  });
});

// ── ZMCP-20260827-004: sessions_update add-mode ──────────────────────────────
describe("sessions_update — add-mode (append sessions)", () => {
  const schedule = {
    id: 900,
    course_id: 55,
    trainer_id: 7,
    trainer_rate_type_id: 0,
    place_id: 8,
    room_id: 0,
    time: 895, // 14:55
    duration: 60,
    name: "Mon Ballet",
    schedule_type: "fixed_period",
  };

  it("preview lists the new sessions and defaults time/duration from the class", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules/900") return ok({ data: schedule });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsUpdate(
      { company_id: 1, schedule_id: 900, sessions: [{ date: "2027-01-04" }] },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.op).toBe("add");
    expect(out.schedule_id).toBe(900);
    const sess = out.new_sessions as Array<Record<string, unknown>>;
    expect(sess).toHaveLength(1);
    expect(sess[0]).toMatchObject({ date: "2027-01-04", time_minutes: 895, duration: 60 });
    expect(typeof out.token).toBe("string");
  });

  it("commit POSTs billable events to /events on the existing schedule", async () => {
    installFetch(({ path, method }) => {
      if (path === "/schedules/900") return ok({ data: schedule });
      if (path === "/events" && method === "POST") return ok([{ id: 9001 }]);
      throw new Error(`unexpected ${method} ${path}`);
    });
    const prev = await runSessionsUpdate(
      { company_id: 1, schedule_id: 900, sessions: [{ date: "2027-01-04", time: "17:30" }] },
      AUTH,
    );
    const token = parse(prev).token as string;
    const res = await runSessionsUpdate({ company_id: 1, token, confirmed: true }, AUTH);
    expect(res.isError).toBeFalsy();
    const post = calls.find((c) => c.path === "/events" && c.method === "POST");
    expect(post).toBeDefined();
    const events = post!.body!.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schedule_id: 900,
      course_id: 55,
      date_string: "2027-01-04",
      time_string: 1050, // 17:30
      duration: 60,
      billable: true,
    });
    expect(parse(res).created_event_ids).toEqual([9001]);
  });

  it("rejects event_ids and schedule_id together", async () => {
    installFetch(() => ok({ data: [] }));
    const res = await runSessionsUpdate(
      { company_id: 1, event_ids: [1], changes: { duration: 30 }, schedule_id: 900, sessions: [{ date: "2027-01-04" }] },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not both");
  });
});

// ── ZMCP-20260827-002: sessions_find_events window ───────────────────────────
describe("sessions_find_events — no hidden upcoming filter (Bug 2)", () => {
  function stub() {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [] });
      if (path === "/user") return ok({ data: { id: 1, role: "owner" } });
      throw new Error(`unexpected ${path}`);
    });
  }
  function today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  it("bare call injects from=today and never sends upcoming_events", async () => {
    stub();
    await runFindEvents({ company_id: 1 }, AUTH);
    const url = eventsCall().url;
    expect(url).toContain(`from=${today()}`);
    expect(url).not.toContain("upcoming_events");
  });

  it("scoped call (schedule_id) injects NO from and NO upcoming_events → full history", async () => {
    stub();
    await runFindEvents({ company_id: 1, schedule_id: 42 }, AUTH);
    const url = eventsCall().url;
    expect(url).toContain("schedule_id=42");
    expect(url).not.toContain("from=");
    expect(url).not.toContain("upcoming_events");
  });
});

// ── ZMCP-20260827-003: classes_find_classes enrichment ───────────────────────
describe("classes_find_classes — with_sessions / sort / sessions_count", () => {
  it("passes with_events=1 and sort_by, and surfaces sessions_count from total_events", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules")
        return ok({ data: [{ id: 5, name: "A", total_events: 19, status: "active" }], total: 1 });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runFindClasses(
      { company_id: 1, with_sessions: true, sort: "created_desc" },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const sch = calls.find((c) => c.path === "/schedules")!;
    expect(sch.url).toContain("with_events=1");
    expect(sch.url).toContain("sort_by=created_desc");
    const out = parse(res);
    const matches = out.matches as Array<Record<string, unknown>>;
    expect(matches[0].sessions_count).toBe(19);
  });
});
