import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runCommitClass } from "./commit-class.js";
import { runPreviewEvents } from "./preview-events-tool.js";
import { runPreviewSchedule } from "./preview-schedule.js";
import type { ResolvedSchedule } from "./types.js";

/**
 * End-to-end coverage of the class-creation flow (ZMCP-20260522-001 AC:
 * "Integration test covering shell preview → multi-block events → commit
 * success; lead-collection short-circuit; course-not-found; events
 * count-mismatch detection; stub fallback").
 *
 * We mock the global `fetch` rather than `zoozaFetch`, so the real request
 * assembly, `ZoozaApiError` parsing, and stub fallback logic all execute.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "test-key",
  company: "1",
  legacyToken: "test-token",
  baseUrl: "https://api.test",
};

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: FetchCall[] = [];

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fail(status: number, body: unknown = {}): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Route mocked fetch by (method, path). Handler receives the recorded call. */
function installFetch(handler: (call: FetchCall) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
      const call: FetchCall = { url, method, body };
      calls.push(call);
      return handler(call);
    }),
  );
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** A fully-resolved fixed-period shell, as `classes_preview_schedule` would emit. */
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
    billable_events: 10,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVENTS_PREVIEW_USE_STUB;
});

describe("classes_preview_schedule", () => {
  it("resolves the shell, copies course pricing (never silently 0), and warns", async () => {
    installFetch(({ url }) => {
      if (url.endsWith("/courses/42")) {
        return ok({
          id: 42,
          name: "Ballet",
          target_audience: "groups",
          unit_price: "12",
          price: "120",
          registration_fee: "5",
          billable_events: "10",
        });
      }
      if (url.endsWith("/places/7")) {
        return ok({
          id: 7,
          name: "Main Hall",
          rooms: [{ id: 3, name: "Studio A", capacity: 20 }],
        });
      }
      if (url.endsWith("/courses/42/payment_schedules_templates")) {
        return ok({
          data: [
            { id: 100, name: "Monthly plan", schedule_type: "in_advance", frequency: "monthly" },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runPreviewSchedule(
      { company_id: 1, course_id: 42, place_id: 7, trainer_id: 9, room_id: 3 },
      AUTH,
    );

    expect(result.isError).toBeFalsy();
    const out = parse(result);
    const schedule = out.schedule as ResolvedSchedule;
    expect(schedule.unit_price).toBe(12);
    expect(schedule.price).toBe(120);
    expect(schedule.registration_fee).toBe(5);
    expect(schedule.billable_events).toBe(10);
    expect(schedule.capacity).toBe(10); // groups default

    const templates = out.payment_templates as Array<{ id: number; selected_by_default: boolean }>;
    expect(templates).toEqual([
      { id: 100, name: "Monthly plan", selected_by_default: true },
    ]);

    const warnings = out.warnings as string[];
    expect(warnings.some((w) => w.includes("online_registration"))).toBe(true);
    expect(warnings.some((w) => w.includes("billing_period_id"))).toBe(true);
  });

  it("returns an actionable error when the course does not exist", async () => {
    installFetch(({ url }) => {
      if (url.endsWith("/courses/999")) return fail(404, { errors: ["not_found"] });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runPreviewSchedule(
      { company_id: 1, course_id: 999, place_id: 7, trainer_id: 9 },
      AUTH,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Course 999 not found");
    // Place / templates are never fetched once the course lookup fails.
    expect(calls).toHaveLength(1);
  });
});

describe("classes_preview_events", () => {
  it("expands multiple blocks and omits the non-LLM-facing `billable` field", async () => {
    process.env.EVENTS_PREVIEW_USE_STUB = "true";

    const result = await runPreviewEvents(
      {
        company_id: 1,
        place_id: 7,
        from_date: "2026-05-04", // Monday
        blocks: [
          { weekdays: ["mon"], cadence: "weekly", count: 3, time_minutes: 780, duration: 60 },
          { weekdays: ["wed"], cadence: "weekly", count: 2, time_minutes: 900, duration: 45 },
        ],
      },
      AUTH,
    );

    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out.event_count).toBe(5);
    const events = out.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(5);
    for (const e of events) {
      expect(e).not.toHaveProperty("billable");
    }
    // Forced stub → no HTTP call to api-v1.
    expect(calls).toHaveLength(0);
  });

  it("falls back to the local stub when api-v1 returns 404", async () => {
    installFetch(({ url }) => {
      if (url.includes("/events/preview/")) return fail(404, {});
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runPreviewEvents(
      {
        company_id: 1,
        place_id: 7,
        from_date: "2026-05-04",
        blocks: [{ weekdays: ["mon"], cadence: "weekly", count: 2, time_minutes: 780, duration: 60 }],
      },
      AUTH,
    );

    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out.event_count).toBe(2);
    // The preview endpoint WAS attempted before falling back.
    expect(calls.some((c) => c.url.includes("/events/preview/"))).toBe(true);
  });
});

describe("classes_commit_class", () => {
  it("posts the schedule then events, and forces billable:false on every event", async () => {
    installFetch(({ url }) => {
      if (url.endsWith("/schedules")) {
        return ok({
          id: 555,
          __calc__registration_url: "https://reg.test/555",
          __view__admin_url: "https://admin.test/555",
          __view__registration_url_active: true,
        });
      }
      if (url.endsWith("/events")) {
        return ok([{ id: 1 }, { id: 2 }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule(),
        events: [
          { date_string: "2026-05-04", time_minutes: 780, duration: 60 },
          { date_string: "2026-05-11", time_minutes: 780, duration: 60 },
        ],
        payment_schedule_template_ids: [100],
      },
      AUTH,
    );

    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out.schedule_id).toBe(555);
    expect(out.created_event_ids).toEqual([1, 2]);
    expect(out.registration_url).toBe("https://reg.test/555");

    const schedulePost = calls.find((c) => c.method === "POST" && c.url.endsWith("/schedules"));
    expect(schedulePost?.body?.payment_schedules).toEqual([100]);
    expect(schedulePost?.body?.billable_events).toBe(10);

    const eventsPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/events"));
    const postedEvents = (eventsPost?.body?.events ?? []) as Array<Record<string, unknown>>;
    expect(postedEvents).toHaveLength(2);
    for (const e of postedEvents) {
      expect(e.billable).toBe(false);
    }
  });

  it("short-circuits a lead-collection class: schedule only, no events POST", async () => {
    installFetch(({ url }) => {
      if (url.endsWith("/schedules")) return ok({ id: 777 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ schedule_type: "lead_collection" }),
        events: [],
      },
      AUTH,
    );

    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out.schedule_id).toBe(777);
    expect(out.created_event_ids).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/events"))).toBe(false);
  });

  it("rejects a lead-collection class that carries events, before any HTTP call", async () => {
    installFetch(() => {
      throw new Error("must not call api-v1");
    });

    const result = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule({ schedule_type: "lead_collection" }),
        events: [{ date_string: "2026-05-04", time_minutes: 780, duration: 60 }],
      },
      AUTH,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Lead-collection classes cannot have events");
    expect(calls).toHaveLength(0);
  });

  it("detects api-v1 silently skipping events (count mismatch)", async () => {
    installFetch(({ url }) => {
      if (url.endsWith("/schedules")) return ok({ id: 900 });
      if (url.endsWith("/events")) return ok([{ id: 10 }]); // only 1 of 3
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await runCommitClass(
      {
        company_id: 1,
        schedule: fixedSchedule(),
        events: [
          { date_string: "2026-05-04", time_minutes: 780, duration: 60 },
          { date_string: "2026-05-11", time_minutes: 780, duration: 60 },
          { date_string: "2026-05-18", time_minutes: 780, duration: 60 },
        ],
      },
      AUTH,
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("silently skipped");
    expect(text).toContain("2 of 3");
    expect(text).toContain("900"); // schedule id surfaced for recovery
  });
});
