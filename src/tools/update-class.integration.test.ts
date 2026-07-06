import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import {
  runClassesCommitUpdate,
  runClassesPrepareUpdate,
} from "./classes-update.js";
import {
  runSessionsCommitUpdate,
  runSessionsPrepareUpdate,
} from "./sessions-update.js";
import { clearUpdatePlanStore } from "./update-plan-store.js";

/**
 * End-to-end coverage of the class/session edit flow (ZMCP-20260702-001/-002).
 * Mocks the global fetch so the real request assembly, cascade-key mapping,
 * date computation, ZoozaApiError parsing, and the prepare→commit token round
 * trip all execute.
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
function fail(status: number, body: unknown = {}): Response {
  return { ok: false, status, text: async () => JSON.stringify(body) } as unknown as Response;
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
async function tokenFrom(r: { content: Array<{ text: string }> }): Promise<string> {
  return parse(r).token as string;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearUpdatePlanStore();
});

describe("classes_update", () => {
  it("prepare: shell-only price change needs no session_scope and reports 0 affected", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules/42") return ok({ id: 42, price: 100 });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { price: 120 } },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    const summary = out.summary as Record<string, unknown>;
    expect(summary.sessions_affected).toBe(0);
    expect(summary.session_scope).toBeNull();
    expect(typeof out.token).toBe("string");
  });

  it("prepare: cascade field without session_scope is rejected", async () => {
    installFetch(() => ok({ id: 42 }));
    const res = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { trainer_id: 61 } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("session_scope");
    expect(calls).toHaveLength(0); // rejected before any fetch
  });

  it("prepare: course_id without confirm is rejected", async () => {
    installFetch(() => ok({ id: 42 }));
    const res = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { course_id: 9 } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("confirm_course_change");
  });

  it("prepare: place_id without room_id is rejected", async () => {
    installFetch(() => ok({ id: 42 }));
    const res = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { place_id: 7 }, session_scope: "all" },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("both place_id and room_id");
  });

  it("prepare→commit: single schedule maps session_scope to canonical update_mode key", async () => {
    installFetch(({ path, method }) => {
      if (path === "/schedules/42" && method === "GET")
        return ok({ id: 42, name: "TEST - Membership", trainer_id: 45 });
      if (path === "/events" && method === "GET") return ok({ data: [], total: 8 });
      if (path === "/schedules/42" && method === "PUT") return ok({});
      throw new Error(`unexpected ${method} ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { trainer_id: 61 }, session_scope: "upcoming" },
      AUTH,
    );
    expect(prep.isError).toBeFalsy();
    expect((parse(prep).summary as Record<string, unknown>).sessions_affected).toBe(8);

    const commit = await runClassesCommitUpdate({ token: await tokenFrom(prep) }, AUTH);
    expect(commit.isError).toBeFalsy();

    // The result must label the changed object as a CLASS by name — so the caller never
    // borrows a session/event id (e.g. "event #64") when describing what changed.
    const out = parse(commit);
    expect(out.object).toBe("class");
    expect(out.classes).toEqual([{ schedule_id: 42, name: "TEST - Membership" }]);

    const put = calls.find((c) => c.method === "PUT" && c.path === "/schedules/42");
    expect(put?.body).toEqual({ trainer_id: 61, update_mode_trainer: "upcoming" });
    expect(put?.body).not.toHaveProperty("id"); // id lives in the path for single
  });

  it("prepare→commit: bulk uses PUT /schedules/bulk with an id-bearing array", async () => {
    installFetch(({ path, method }) => {
      if (path.startsWith("/schedules/") && method === "GET") return ok({ id: 1, price: 10 });
      if (path === "/schedules/bulk" && method === "PUT") return ok([{ id: 1 }, { id: 2 }]);
      throw new Error(`unexpected ${method} ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [1, 2], changes: { price: 15 } },
      AUTH,
    );
    const commit = await runClassesCommitUpdate({ token: await tokenFrom(prep) }, AUTH);
    expect(commit.isError).toBeFalsy();
    const bulk = calls.find((c) => c.path === "/schedules/bulk");
    expect(bulk?.body).toEqual([
      { id: 1, price: 15 },
      { id: 2, price: 15 },
    ]);
  });

  it("prepare: schedule not found aborts with an actionable message", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules/999") return fail(404, {});
      throw new Error(`unexpected ${path}`);
    });
    const res = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [999], changes: { price: 1 } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Class 999 not found");
  });

  it("commit: an invalid/expired token is rejected", async () => {
    installFetch(() => ok({}));
    const res = await runClassesCommitUpdate({ token: "upd_classes_bogus" }, AUTH);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no longer valid");
  });
});

describe("sessions_update", () => {
  it("prepare: 'set' reschedule computes an absolute Y-m-d H:i:s date", async () => {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [{ id: 5567, date: "2026-07-01 13:00:00" }] });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsPrepareUpdate(
      { company_id: 1, event_ids: [5567], changes: { reschedule: { mode: "set", date: "2026-07-08", time: "17:00" } } },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    const sessions = out.sessions as Array<{ changes: Array<{ field: string; to: unknown }> }>;
    expect(sessions[0].changes[0]).toMatchObject({ field: "date", to: "2026-07-08 17:00:00" });
  });

  it("prepare: 'shift' moves each session by the interval", async () => {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [{ id: 1, date: "2026-07-01 13:00:00" }] });
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsPrepareUpdate(
      { company_id: 1, event_ids: [1], changes: { reschedule: { mode: "shift", days: 7 } } },
      AUTH,
    );
    const sessions = parse(res).sessions as Array<{ changes: Array<{ to: unknown }> }>;
    expect(sessions[0].changes[0].to).toBe("2026-07-08 13:00:00");
  });

  it("prepare: unknown event id aborts", async () => {
    installFetch(({ path }) => {
      if (path === "/events") return ok({ data: [] }); // none resolved
      throw new Error(`unexpected ${path}`);
    });
    const res = await runSessionsPrepareUpdate(
      { company_id: 1, event_ids: [123], changes: { trainer_id: 9 } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("123");
  });

  it("prepare→commit: PUT /events batch carries per-event payloads + notify, reconciles ids", async () => {
    installFetch(({ path, method }) => {
      if (path === "/events" && method === "GET")
        return ok({ data: [{ id: 1, date: "2026-07-01 09:00:00" }, { id: 2, date: "2026-07-02 09:00:00" }] });
      if (path === "/events" && method === "PUT") return ok([{ id: 1, updated: true }]); // id 2 skipped
      throw new Error(`unexpected ${method} ${path}`);
    });
    const prep = await runSessionsPrepareUpdate(
      { company_id: 1, event_ids: [1, 2], changes: { trainer_id: 9 }, notify: true },
      AUTH,
    );
    expect(res_notifyWarn(prep)).toBe(true);
    const commit = await runSessionsCommitUpdate({ token: await tokenFrom(prep) }, AUTH);
    const out = parse(commit);
    expect(out.updated_event_ids).toEqual([1]);
    expect(out.skipped_event_ids).toEqual([2]);
    expect(out.notified).toBe(true);

    const put = calls.find((c) => c.method === "PUT" && c.path === "/events");
    expect(put?.body).toEqual({
      events: [
        { id: 1, trainer_id: 9, notify: true },
        { id: 2, trainer_id: 9, notify: true },
      ],
    });
  });

  it("prepare: venue change without room_id is rejected", async () => {
    installFetch(() => ok({ data: [] }));
    const res = await runSessionsPrepareUpdate(
      { company_id: 1, event_ids: [1], changes: { place_id: 7 } },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("both place_id and room_id");
    expect(calls).toHaveLength(0);
  });
});

function res_notifyWarn(r: { content: Array<{ text: string }> }): boolean {
  const warnings = (parse(r).warnings as string[]) ?? [];
  return warnings.some((w) => w.includes("email enrolled clients"));
}
