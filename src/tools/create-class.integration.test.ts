import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runCommitClass, billableWarnings, deriveUnitPrice } from "./commit-class.js";
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
  it("posts the schedule then events, and marks every event billable", async () => {
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
    // Regression guard. This asserted `false` until 2026-08-24, which is how a live
    // course ended up pricing at EUR 0: api-v1 only applies its `billable = 1` filter
    // when billable_events > 0 (Schedule.php:1194-1198), so non-billable events plus
    // billable_events: 10 makes remaining_events resolve to 0 and the whole class
    // prices at nothing. Do not flip this back without reading that code path.
    for (const e of postedEvents) {
      expect(e.billable).toBe(true);
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

describe("billableWarnings", () => {
  it("stays silent when billable_events is unset", () => {
    // billable_events = 0 disables api-v1's billable filter entirely, so every
    // session counts and there is nothing to reconcile.
    expect(billableWarnings(0, 16)).toEqual([]);
  });

  it("stays silent when the counts agree", () => {
    expect(billableWarnings(16, 16)).toEqual([]);
  });

  it("flags charging for more sessions than exist", () => {
    const [w] = billableWarnings(15, 12);
    expect(w).toContain("only 12 were created");
    expect(w).toContain("3 session(s) that do not exist");
  });

  it("flags sessions that will be free", () => {
    // The real Nemčina shape: billable_events 15 against 16 created sessions.
    const [w] = billableWarnings(15, 16);
    expect(w).toContain("15 of its 16 sessions");
    expect(w).toContain("1 session(s) are free");
  });
});

describe("deriveUnitPrice", () => {
  it("divides the operator's total across billable sessions", () => {
    // The exact case that shipped three wrong courses: "EUR 300 for the term",
    // 20 sessions. Putting 300 in unit_price charged 6000.
    expect(deriveUnitPrice(300, 20, 20)).toEqual({ unit_price: 15, divisor: 20 });
  });

  it("falls back to the created session count when billable_events is unset", () => {
    // billable_events = 0 disables api-v1's billable filter, so every session counts.
    expect(deriveUnitPrice(200, 0, 16)).toEqual({ unit_price: 12.5, divisor: 16 });
  });

  it("prefers billable_events over the raw session count", () => {
    // A class may deliberately run more sessions than it charges for.
    expect(deriveUnitPrice(300, 10, 20)).toEqual({ unit_price: 30, divisor: 10 });
  });

  it("rounds to cents", () => {
    const r = deriveUnitPrice(200, 15, 15);
    expect(r?.unit_price).toBe(13.33);
  });

  it("returns null when there is no total to divide", () => {
    expect(deriveUnitPrice(0, 20, 20)).toBeNull();
  });

  it("returns null when there is nothing to divide by", () => {
    // Caller must be told, not handed a division by zero.
    expect(deriveUnitPrice(300, 0, 0)).toBeNull();
  });
});
