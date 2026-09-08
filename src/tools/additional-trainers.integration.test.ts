import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindClasses } from "./find-classes.js";
import { runFindEvents } from "./find-events.js";

/**
 * Read-path coverage for additional lecturers (spec ZMCP-20260908-002).
 * Mocks global fetch so real query assembly runs and we can assert exactly what
 * hits api-v1 — in particular that the roster is fetched ONCE, and only when a
 * page actually carries additional trainers.
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
      const call: FetchCall = { url: String(input), path: url.pathname, query: url.searchParams };
      calls.push(call);
      return handler(call);
    }),
  );
}
function structured<T = any>(r: unknown): T {
  return (r as { structuredContent: T }).structuredContent;
}
function json(r: unknown): any {
  return JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
}

const USERS = {
  total: 2,
  data: [
    { id: 11031, first_name: "Martin", last_name: "Novák" },
    { id: 11145, first_name: "Peter", last_name: "Kováč" },
  ],
};

/** One event carrying a session-level assignment plus the class roster. */
const EVENT_WITH = {
  id: 65459,
  schedule_id: 6835,
  date: "2026-11-10 17:30:00",
  status: "scheduled",
  trainers_events: [{ trainer_id: 11031, role: "helper" }],
  trainers_schedules: [
    { trainer_id: 11031, role: "helper" },
    { trainer_id: 11145, role: "secondary" },
  ],
};
/** api-v1 OMITS both keys on rows with nothing assigned. */
const EVENT_WITHOUT = { id: 65460, schedule_id: 6835, date: "2026-11-17 17:30:00", status: "scheduled" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessions_find_events — additional lecturers", () => {
  it("separates the session assignment from the class roster, and resolves names", async () => {
    installFetch((c) => {
      if (c.path === "/events") return ok({ total: 2, data: [EVENT_WITH, EVENT_WITHOUT] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    const res = structured(await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH));
    const [withT, withoutT] = res.events;

    expect(withT.additional_trainers).toEqual([
      { trainer_id: 11031, trainer_name: "Martin Novák", role: "helper" },
    ]);
    // The roster is a superset: Peter is eligible for the class but is NOT on
    // this session. Conflating the two is the whole trap this spec guards.
    expect(withT.class_additional_trainers.map((t: any) => t.trainer_id)).toEqual([11031, 11145]);
    expect(withT.additional_trainers.map((t: any) => t.trainer_id)).not.toContain(11145);

    // Omitted keys normalise to [] — "nobody assigned", not "not loaded".
    expect(withoutT.additional_trainers).toEqual([]);
    expect(withoutT.class_additional_trainers).toEqual([]);
  });

  it("fetches the roster exactly once for the whole page", async () => {
    installFetch((c) => {
      if (c.path === "/events")
        return ok({ total: 3, data: [EVENT_WITH, { ...EVENT_WITH, id: 2 }, { ...EVENT_WITH, id: 3 }] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH);
    expect(calls.filter((c) => c.path === "/users")).toHaveLength(1);
  });

  it("skips the roster call entirely when no session has additional lecturers", async () => {
    installFetch((c) => {
      if (c.path === "/events") return ok({ total: 1, data: [EVENT_WITHOUT] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH);
    expect(calls.filter((c) => c.path === "/users")).toHaveLength(0);
  });

  it("asks for inactive team members too, so deactivated lecturers still resolve", async () => {
    installFetch((c) => {
      if (c.path === "/events") return ok({ total: 1, data: [EVENT_WITH] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH);
    const users = calls.find((c) => c.path === "/users")!;
    expect(users.query.get("roles")).toContain("inactive");
    expect(users.query.get("filter")).toBe("filter");
  });

  it("degrades to null names when the roster lookup fails, without failing the read", async () => {
    installFetch((c) => {
      if (c.path === "/events") return ok({ total: 1, data: [EVENT_WITH] });
      if (c.path === "/users") return fail(500);
      return ok({});
    });

    const res = structured(await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH));
    expect(res.events[0].additional_trainers).toEqual([
      { trainer_id: 11031, trainer_name: null, role: "helper" },
    ]);
  });

  it("degrades to null names when the roster comes back truncated", async () => {
    installFetch((c) => {
      if (c.path === "/events") return ok({ total: 1, data: [EVENT_WITH] });
      // total exceeds the rows returned: 11145 is beyond the page.
      if (c.path === "/users") return ok({ total: 999, data: [USERS.data[0]] });
      return ok({});
    });

    const res = structured(await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH));
    const roster = res.events[0].class_additional_trainers;
    expect(roster.find((t: any) => t.trainer_id === 11031).trainer_name).toBe("Martin Novák");
    expect(roster.find((t: any) => t.trainer_id === 11145).trainer_name).toBeNull();
  });

  it("names virtual placeholder trainers locally — /v1/users never returns them", async () => {
    installFetch((c) => {
      if (c.path === "/events")
        return ok({
          total: 1,
          data: [{ ...EVENT_WITH, trainers_events: [{ trainer_id: 9000000000001, role: "helper" }] }],
        });
      if (c.path === "/users") return ok({ total: 0, data: [] });
      return ok({});
    });

    const res = structured(await runFindEvents({ company_id: 1, schedule_id: 6835 }, AUTH));
    expect(res.events[0].additional_trainers[0]).toMatchObject({
      trainer_id: 9000000000001,
      trainer_name: "To be decided",
    });
  });

  it("carries the fields across every query shape (ids / schedule_id / date window)", async () => {
    for (const args of [
      { ids: [65459] },
      { schedule_id: 6835 },
      { from: "2026-11-01", to: "2026-11-30" },
    ]) {
      installFetch((c) => {
        if (c.path === "/events") return ok({ total: 1, data: [EVENT_WITH] });
        if (c.path === "/users") return ok(USERS);
        return ok({});
      });
      const res = structured(await runFindEvents({ company_id: 1, ...args }, AUTH));
      expect(res.events[0].additional_trainers).toHaveLength(1);
      expect(calls.find((c) => c.path === "/events")!.query.get("filter")).toBe("filter");
    }
  });
});

describe("classes_find_classes — additional lecturers", () => {
  const SCHEDULE = {
    id: 6835,
    name: "Junior Mon 17:30",
    trainer_id: 900,
    trainer: { id: 900, first_name: "Hana", last_name: "Main" },
    trainers_schedules: [{ trainer_id: 11031, role: "secondary" }],
  };

  it("requests BOTH load_trainer (main) and load_trainers (additional)", async () => {
    installFetch((c) => {
      if (c.path === "/schedules") return ok({ total: 1, data: [SCHEDULE] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    await runFindClasses({ company_id: 1, name: "Junior" }, AUTH);
    const q = calls.find((c) => c.path === "/schedules")!.query;
    expect(q.get("load_trainer")).toBe("1");
    expect(q.get("load_trainers")).toBe("1");
  });

  it("returns the roster and keeps the main instructor out of it", async () => {
    installFetch((c) => {
      if (c.path === "/schedules") return ok({ total: 1, data: [SCHEDULE] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    const res = json(await runFindClasses({ company_id: 1, name: "Junior" }, AUTH));
    const cls = res.matches[0];
    expect(cls.trainer_name).toBe("Hana Main");
    expect(cls.additional_trainers).toEqual([
      { trainer_id: 11031, trainer_name: "Martin Novák", role: "secondary" },
    ]);
    expect(cls.additional_trainers.map((t: any) => t.trainer_id)).not.toContain(900);
  });

  it("normalises the omitted key to [] on a class with no additional lecturers", async () => {
    installFetch((c) => {
      if (c.path === "/schedules")
        return ok({ total: 1, data: [{ id: 7000, name: "Solo class", trainer_id: 900 }] });
      if (c.path === "/users") return ok(USERS);
      return ok({});
    });

    const res = json(await runFindClasses({ company_id: 1, name: "Solo" }, AUTH));
    expect(res.matches[0].additional_trainers).toEqual([]);
    expect(calls.filter((c) => c.path === "/users")).toHaveLength(0);
  });
});
