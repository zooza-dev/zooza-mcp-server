import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runClassesCommitUpdate, runClassesPrepareUpdate } from "./classes-update.js";
import { runCommitClass } from "./commit-class.js";
import { runPreviewSchedule } from "./preview-schedule.js";
import type { ResolvedSchedule } from "./types.js";
import { clearUpdatePlanStore } from "./update-plan-store.js";

/**
 * Spec ZMCP-20261009-007 (issue #3): per-class trial switch (`trial_enabled` →
 * schedules.in_trial) and trainer_rate_type_id validation against the company's
 * pay rates. Mocks global fetch so request assembly runs for real.
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
      const call: FetchCall = {
        path: new URL(String(input)).pathname,
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

const RATE_TYPES = {
  total: 2,
  data: [
    { id: 4, name: "Senior", minutes: 60, type: "per_minute" },
    { id: 13, name: "Junior", minutes: 45, type: "per_minute" },
  ],
};

function fixedSchedule(overrides: Partial<ResolvedSchedule> = {}): ResolvedSchedule {
  return {
    course_id: 42,
    course_name: "Ballet",
    place_id: 7,
    place_name: "Main Hall",
    room_id: 3,
    trainer_id: 9,
    trainer_rate_type_id: 0,
    capacity: 10,
    duration_minutes: 60,
    all_day: false,
    online_registration: true,
    schedule_type: "fixed_period",
    unit_price: 12,
    price: 120,
    registration_fee: 5,
    billable_events: 1,
    ...overrides,
  };
}
const ONE_EVENT = [{ date_string: "2026-11-02", time_minutes: 780, duration: 60 }];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearUpdatePlanStore();
});

describe("classes_update — trial_enabled", () => {
  it("trial_enabled: false is sent to api-v1 as in_trial: false and diffed against in_trial", async () => {
    installFetch(({ path, method }) => {
      if (path === "/schedules/42" && method === "GET") return ok({ id: 42, course_id: 5, in_trial: true });
      if (path === "/schedules/42" && method === "PUT") return ok({ id: 42 });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { trial_enabled: false } },
      AUTH,
    );
    expect(prep.isError).toBeFalsy();
    const out = parse(prep);
    const diff = ((out.summary as { diffs: Array<{ field_changes: unknown[] }> }).diffs[0]
      .field_changes[0]) as Record<string, unknown>;
    expect(diff).toMatchObject({ field: "trial_enabled", from: true, to: false });
    // false needs no course read — only true can be gated off by the programme.
    expect(calls.some((c) => c.path.startsWith("/courses/"))).toBe(false);

    const commit = await runClassesCommitUpdate({ token: out.token }, AUTH);
    expect(commit.isError).toBeFalsy();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/schedules/42");
    expect(put?.body).toEqual({ in_trial: false });
  });

  it("trial_enabled: true on a programme with trial_type none warns but still previews", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules/42") return ok({ id: 42, course_id: 5, in_trial: false });
      if (path === "/courses/5") return ok({ id: 5, trial_type: "none" });
      throw new Error(`unexpected ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { trial_enabled: true } },
      AUTH,
    );
    expect(prep.isError).toBeFalsy();
    const warnings = (parse(prep).summary as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('trial_type "none"'))).toBe(true);
  });

  it("trial_enabled: true on a programme that offers trials adds no warning", async () => {
    installFetch(({ path }) => {
      if (path === "/schedules/42") return ok({ id: 42, course_id: 5, in_trial: false });
      if (path === "/courses/5") return ok({ id: 5, trial_type: "free_trial" });
      throw new Error(`unexpected ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      { company_id: 1, schedule_ids: [42], changes: { trial_enabled: true } },
      AUTH,
    );
    expect((parse(prep).summary as { warnings: string[] }).warnings).toEqual([]);
  });
});

describe("classes_update — trainer_rate_type_id validation", () => {
  it("rejects an id that is not one of the company's pay rates, naming the valid ids", async () => {
    installFetch(({ path }) => {
      if (path === "/trainer_rates/types") return ok(RATE_TYPES);
      throw new Error(`unexpected ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      {
        company_id: 1,
        schedule_ids: [42],
        changes: { trainer_rate_type_id: 99 },
        session_scope: "upcoming",
      },
      AUTH,
    );
    expect(prep.isError).toBe(true);
    const text = prep.content[0].text;
    expect(text).toContain("99");
    expect(text).toContain("4 (Senior)");
    expect(text).toContain("13 (Junior)");
    expect(calls.some((c) => c.path.startsWith("/schedules"))).toBe(false);
  });

  it("accepts a known id", async () => {
    installFetch(({ path }) => {
      if (path === "/trainer_rates/types") return ok(RATE_TYPES);
      if (path === "/schedules/42") return ok({ id: 42, trainer_rate_type_id: 4 });
      if (path === "/events") return ok({ total: 3, data: [] });
      throw new Error(`unexpected ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      {
        company_id: 1,
        schedule_ids: [42],
        changes: { trainer_rate_type_id: 13 },
        session_scope: "upcoming",
      },
      AUTH,
    );
    expect(prep.isError).toBeFalsy();
    expect(typeof parse(prep).token).toBe("string");
  });

  it("downgrades a failed rate lookup to a warning instead of blocking", async () => {
    installFetch(({ path }) => {
      if (path === "/trainer_rates/types") return fail(500);
      if (path === "/schedules/42") return ok({ id: 42, trainer_rate_type_id: 4 });
      if (path === "/events") return ok({ total: 3, data: [] });
      throw new Error(`unexpected ${path}`);
    });
    const prep = await runClassesPrepareUpdate(
      {
        company_id: 1,
        schedule_ids: [42],
        changes: { trainer_rate_type_id: 13 },
        session_scope: "upcoming",
      },
      AUTH,
    );
    expect(prep.isError).toBeFalsy();
    const warnings = (parse(prep).summary as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes("Could not verify trainer_rate_type_id 13"))).toBe(true);
  });
});

describe("classes_commit_class — trial_enabled + rate validation", () => {
  function commitHandler(overrides: { trialPut?: () => Response } = {}) {
    return ({ path, method }: FetchCall): Response => {
      if (path === "/trainer_rates/types") return ok(RATE_TYPES);
      if (path === "/schedules" && method === "POST") return ok({ id: 555 });
      if (path === "/schedules/555" && method === "PUT") {
        return overrides.trialPut ? overrides.trialPut() : ok({ id: 555 });
      }
      if (path === "/events" && method === "POST") return ok([{ id: 1 }]);
      throw new Error(`unexpected ${method} ${path}`);
    };
  }

  it("trial_enabled: false is applied as a follow-up PUT in_trial: false", async () => {
    installFetch(commitHandler());
    const res = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ trial_enabled: false }),
        events: ONE_EVENT,
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/schedules");
    expect(post?.body).not.toHaveProperty("in_trial");
    expect(post?.body).not.toHaveProperty("trial_enabled");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/schedules/555");
    expect(put?.body).toEqual({ in_trial: false });
  });

  it("trial_enabled: true is sent as in_trial: true", async () => {
    installFetch(commitHandler());
    await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ trial_enabled: true }),
        events: ONE_EVENT,
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ in_trial: true });
  });

  it("omitting trial_enabled sends no trial write (programme default applies)", async () => {
    installFetch(commitHandler());
    await runCommitClass(
      { company_id: 1, schedule: fixedSchedule(), events: ONE_EVENT, payment_schedule_template_ids: [100] },
      AUTH,
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a failed trial write is a warning, never an error (the class exists)", async () => {
    installFetch(commitHandler({ trialPut: () => fail(500) }));
    const res = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ trial_enabled: false }),
        events: ONE_EVENT,
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.schedule_id).toBe(555);
    expect(out.created_event_ids).toEqual([1]);
    expect((out.warnings as string[]).some((w) => w.includes("setting trial lessons to off failed"))).toBe(true);
  });

  it("rejects an unknown trainer_rate_type_id before any write", async () => {
    installFetch(commitHandler());
    const res = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ trainer_rate_type_id: 99 }),
        events: ONE_EVENT,
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Valid ids: 4 (Senior), 13 (Junior)");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("accepts a known trainer_rate_type_id and writes it on the schedule", async () => {
    installFetch(commitHandler());
    const res = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ trainer_rate_type_id: 13 }),
        events: ONE_EVENT,
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );
    expect(res.isError).toBeFalsy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/schedules");
    expect(post?.body?.trainer_rate_type_id).toBe(13);
  });
});

describe("classes_preview_schedule — trial_enabled + rate validation", () => {
  function previewHandler(trialType: string) {
    return ({ path }: FetchCall): Response => {
      if (path === "/courses/42") {
        return ok({ id: 42, name: "Ballet", target_audience: "groups", trial_type: trialType });
      }
      if (path === "/places/7") return ok({ id: 7, name: "Main Hall", rooms: [] });
      if (path === "/courses/42/payment_schedules_templates") return ok({ data: [] });
      if (path === "/trainer_rates/types") return ok(RATE_TYPES);
      throw new Error(`unexpected ${path}`);
    };
  }
  const base = { company_id: 1, course_id: 42, place_id: 7, trainer_id: 9 };

  it("carries trial_enabled into the shell and warns when the programme has trials off", async () => {
    installFetch(previewHandler("none"));
    const res = await runPreviewSchedule({ ...base, trial_enabled: true }, AUTH);
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect((out.schedule as Record<string, unknown>).trial_enabled).toBe(true);
    expect((out.warnings as string[]).some((w) => w.includes('trial_type "none"'))).toBe(true);
  });

  it("rejects an unknown trainer_rate_type_id with the valid list", async () => {
    installFetch(previewHandler("free_trial"));
    const res = await runPreviewSchedule({ ...base, trainer_rate_type_id: 99 }, AUTH);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Valid ids: 4 (Senior), 13 (Junior)");
  });
});
