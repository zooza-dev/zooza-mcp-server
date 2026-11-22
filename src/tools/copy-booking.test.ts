import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { clearBookingCopyPlanStore } from "./booking-copy-plan-store.js";
import { runCopyBooking } from "./copy-booking.js";

/**
 * Cross-programme warnings (#28, ZMCP-20261009-010) over mocked HTTP. The preflight
 * response shape follows class/Preflight.php:130.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

let targetStatus = "pre_registered";

/** Target-class blocks the mocked preflight reports (class/Zooza/Resource/Schedule_Segment.php
 *  columns; dates in DATE_FORMAT_FULL). Empty = a class not divided into blocks. */
const BLOCKS = [
  { id: 501, name: "Monday", __calc__start: "2026-09-07 16:00:00", __calc__end: "2027-01-25 17:00:00" },
  { id: 502, name: "Wednesday", __calc__start: "2026-09-09 16:00:00", __calc__end: "2027-01-27 17:00:00" },
];
let remainingSegments: unknown[] = [];
let allSegments: unknown[] = [];
/** When set, a segment-scoped preflight reports these ids invalid. */
let invalidSegmentIds: number[] = [];

function preflight(segments?: number[]): unknown {
  const props: Record<string, { name: string; value: unknown }> = {};
  const scoped = Array.isArray(segments);
  const valid = scoped
    ? BLOCKS.filter((b) => segments!.includes(b.id) && !invalidSegmentIds.includes(b.id)).map((b) => ({
        id: b.id,
        company_id: 1,
        data: b,
        table: "schedule_segments",
      }))
    : undefined;
  for (const [name, value] of Object.entries({
    current_price: 0,
    // A segment-scoped preflight prices and counts only those blocks (registrations.php:4807-4849).
    target_price: scoped ? 120 * segments!.length : 240,
    target_status: targetStatus,
    remaining_events_count: scoped ? 5 * segments!.length : 10,
    target_capacity: 10,
    target_registered: 2,
    current_billing_period_name: "Trial",
    target_billing_period_name: "Autumn",
    all_segments: allSegments,
    remaining_segments: remainingSegments,
    ...(scoped ? { valid_segments: valid, invalid_segments: invalidSegmentIds } : {}),
  })) {
    props[name] = { name, value };
  }
  const checks: Record<string, { name: string; result: string; severity: string }> = {
    schedule_full: { name: "schedule_full", result: "passed", severity: "error" },
  };
  if (scoped && invalidSegmentIds.length > 0) {
    checks.requested_segments_exists = { name: "requested_segments_exists", result: "not_passed", severity: "warning" };
  }
  return { checks, properties: props };
}

function withBlocks(): void {
  remainingSegments = BLOCKS;
  allSegments = BLOCKS;
}

let calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
/** The target schedule's first-session date; undefined = not in the GET response. */
let scheduleStart: string | undefined;
function install(sourceCourse: number, targetCourse: number): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = new URL(String(input)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: (init?.method ?? "GET").toUpperCase(), body });
      if (path.endsWith("/registrations") && body?.action !== "preflight_check") {
        return ok({ registration_id: 777 });
      }
      if (path.endsWith("/registrations/55")) return ok({ id: 55, course_id: sourceCourse });
      if (path.endsWith("/schedules/9")) {
        return ok({
          id: 9,
          course_id: targetCourse,
          registration_fee: 15,
          unit_price: 12,
          ...(scheduleStart !== undefined ? { start: scheduleStart, total_events: 10 } : {}),
        });
      }
      if (path.endsWith("/registrations")) return ok(preflight(body?.preflight_properties?.segments));
      return ok({});
    }),
  );
}

async function preview(args: Record<string, unknown>): Promise<any> {
  const r = (await runCopyBooking(
    { company_id: 1, registration_id: 55, target_schedule_id: 9, ...args },
    AUTH,
  )) as { isError?: boolean; content: Array<{ text: string }> };
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}

async function previewRaw(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const r = (await runCopyBooking(
    { company_id: 1, registration_id: 55, target_schedule_id: 9, ...args },
    AUTH,
  )) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content[0].text };
}

/** Preview, then apply with the token; returns the body POSTed by the apply call. */
async function appliedBody(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await preview(args);
  const r = (await runCopyBooking({ token: out.token, confirmed: true }, AUTH)) as { isError?: boolean };
  expect(r.isError).toBeFalsy();
  const writes = calls.filter(
    (c) => c.method === "POST" && c.path.endsWith("/registrations") && c.body?.action !== "preflight_check",
  );
  expect(writes.length).toBe(1);
  return writes[0].body!;
}

function writesSent(): number {
  return calls.filter(
    (c) => c.method === "POST" && c.path.endsWith("/registrations") && c.body?.action !== "preflight_check",
  ).length;
}

afterEach(() => {
  scheduleStart = undefined;
  targetStatus = "pre_registered";
  remainingSegments = [];
  allSegments = [];
  invalidSegmentIds = [];
  vi.unstubAllGlobals();
  clearBookingCopyPlanStore();
});

describe("bookings_copy_booking — cross-programme warnings", () => {
  it("warns different_programme with the target price + fee on copy", async () => {
    install(1, 2);
    const out = await preview({ action: "copy", payments: "from_target_class" });
    const w = out.warnings.find((x: string) => x.startsWith("different_programme"));
    expect(w).toBeDefined();
    expect(w).toContain("240");
    expect(w).toContain("15 registration fee");
    expect(w).toContain("payments_add_plan");
    expect(w).toContain("booking-form answers");
  });

  it("adds no different_programme warning inside the same programme", async () => {
    install(2, 2);
    const out = await preview({ action: "copy", payments: "from_target_class" });
    expect(out.warnings.some((x: string) => x.includes("different_programme"))).toBe(false);
  });

  it("move + do_not_change across programmes adds the payments-stay warning", async () => {
    install(1, 2);
    const out = await preview({ action: "move", payments: "do_not_change" });
    const w = out.warnings.filter((x: string) => x.startsWith("different_programme"));
    expect(w.length).toBe(2);
    expect(w.some((x: string) => x.includes("payments and payment schedule stay on the booking"))).toBe(true);
    // The old plan stays on a do_not_change move, so no "add a plan" advice.
    expect(w.some((x: string) => x.includes("payments_add_plan"))).toBe(false);
  });

  it("copy + do_not_change across programmes has no payments-stay warning", async () => {
    install(1, 2);
    const out = await preview({ action: "copy", payments: "do_not_change" });
    const w = out.warnings.filter((x: string) => x.startsWith("different_programme"));
    expect(w.length).toBe(1);
  });

  it("fetches the target schedule once and sends no write during preview", async () => {
    install(1, 2);
    await preview({ action: "copy", payments: "from_target_class" });
    expect(calls.filter((c) => c.path.endsWith("/schedules/9")).length).toBe(1);
    expect(calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/registrations")).length).toBe(0);
  });
});

describe("bookings_copy_booking — payments: free / custom_amount (ZMCP-20261121-002)", () => {
  it("still requires payments on the preview call, with no default", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("`payments`");
    expect(r.text).toContain("free");
    expect(r.text).toContain("custom_amount");
    expect(calls.length).toBe(0);
  });

  it("rejects an unknown payments mode", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "half_price" });
    expect(r.isError).toBe(true);
  });

  it("free freezes debt 0 / fee 0 and the money block says 0 / 0", async () => {
    install(2, 2);
    const out = await preview({ action: "copy", payments: "free" });
    expect(out.money.payments_mode).toBe("free");
    expect(out.money.target_will_owe_total).toBe(0);
    expect(out.money.target_registration_fee).toBe(0);
    expect(out.money.set_balance).toBe(0);
    expect(out.money.result).toContain("owe 0, registration fee 0");
    expect(out.warnings.some((w: string) => w.includes("payments: free"))).toBe(true);
    expect(writesSent()).toBe(0);

    const body = await appliedBody({ action: "copy", payments: "free" });
    expect(body.debt).toBe(0);
    expect(body.registration_fee).toBe(0);
  });

  it("custom_amount freezes debt B / fee F and the money block reads both back", async () => {
    install(2, 2);
    const args = { action: "move", payments: "custom_amount", custom_balance: 200, custom_registration_fee: 20 };
    const out = await preview(args);
    expect(out.money.payments_mode).toBe("custom_amount");
    expect(out.money.set_balance).toBe(200);
    expect(out.money.target_registration_fee).toBe(20);
    expect(out.money.target_will_owe_total).toBe(220);
    expect(out.money.result).toContain("200 for the classes plus a 20 registration fee");
    expect(out.money.target_unit_price_per_session).toBeNull();

    const body = await appliedBody(args);
    expect(body.debt).toBe(200);
    expect(body.registration_fee).toBe(20);
  });

  it("custom_amount accepts a fee of 0 said out loud", async () => {
    install(2, 2);
    const body = await appliedBody({
      action: "copy",
      payments: "custom_amount",
      custom_balance: 150,
      custom_registration_fee: 0,
    });
    expect(body.debt).toBe(150);
    expect(body.registration_fee).toBe(0);
  });

  it.each([
    [{ custom_balance: 200 }],
    [{ custom_registration_fee: 20 }],
    [{}],
  ])("custom_amount without both numbers is refused before any call (%o)", async (extra) => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "custom_amount", ...extra });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "custom_amount needs custom_balance and custom_registration_fee. Ask the operator for both (0 is allowed).",
    );
    expect(calls.length).toBe(0);
  });

  it.each(["from_target_class", "do_not_change", "free"])(
    "custom numbers with payments: %s are rejected",
    async (payments) => {
      install(2, 2);
      for (const extra of [{ custom_balance: 1 }, { custom_registration_fee: 1 }]) {
        const r = await previewRaw({ action: "copy", payments, ...extra });
        expect(r.isError).toBe(true);
        expect(r.text).toBe("custom_balance / custom_registration_fee only apply with payments: custom_amount.");
      }
      expect(calls.length).toBe(0);
    },
  );

  it("rejects a negative custom amount", async () => {
    install(2, 2);
    const r = await previewRaw({
      action: "copy",
      payments: "custom_amount",
      custom_balance: -5,
      custom_registration_fee: 0,
    });
    expect(r.isError).toBe(true);
  });

  it.each(["free", "custom_amount"])(
    "%s is refused when the preflight status would not be registered",
    async (payments) => {
      targetStatus = "pre_late";
      install(2, 2);
      const extra = payments === "custom_amount" ? { custom_balance: 200, custom_registration_fee: 20 } : {};
      const r = await previewRaw({ action: "copy", payments, ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(
        "Zooza applies a set price only to an enrolled booking. This one would become 'late', so Zooza " +
          "will compute the price itself. Use from_target_class, or book it as registered.",
      );
      expect(r.text).not.toContain("token");
      expect(writesSent()).toBe(0);
    },
  );

  it("an explicit non-registered status wins over the preflight and is refused", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "free", status: "waitlist" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("would become 'waitlist'");
    expect(writesSent()).toBe(0);
  });

  it("an explicit registered status overrides a late preflight status", async () => {
    targetStatus = "pre_late";
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments: "free", status: "registered" });
    expect(body.status).toBe("registered");
    expect(body.debt).toBe(0);
  });

  it("from_target_class is unaffected by a non-registered status", async () => {
    targetStatus = "pre_late";
    install(2, 2);
    const out = await preview({ action: "copy", payments: "from_target_class" });
    expect(out.status).toBe("late");
  });
});

describe("bookings_copy_booking — fields never / conditionally sent", () => {
  const NEVER = ["price_resolution", "payment_schedule"];

  it("from_target_class body is unchanged: no debt, fee, setup_payments or never-sent fields", async () => {
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments: "from_target_class" });
    expect(body).toEqual({ action: "copy", registration_id: 55, schedule_id: 9, status: "registered" });
  });

  it("do_not_change body is unchanged: only setup_payments false is added", async () => {
    install(2, 2);
    const body = await appliedBody({ action: "move", payments: "do_not_change" });
    expect(body).toEqual({
      action: "move",
      registration_id: 55,
      schedule_id: 9,
      status: "registered",
      setup_payments: false,
    });
  });

  it.each([
    ["free", {}],
    ["custom_amount", { custom_balance: 10, custom_registration_fee: 5 }],
  ])("%s sends debt + registration_fee and nothing on the never list", async (payments, extra) => {
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments, ...extra });
    expect(Object.keys(body).sort()).toEqual(
      ["action", "debt", "registration_fee", "registration_id", "schedule_id", "status"].sort(),
    );
    for (const k of NEVER) expect(body).not.toHaveProperty(k);
    expect(body).not.toHaveProperty("segments");
  });

  it("sends no segments without blocks, even when the target class has blocks", async () => {
    withBlocks();
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments: "from_target_class" });
    expect(body).not.toHaveProperty("segments");
    for (const k of NEVER) expect(body).not.toHaveProperty(k);
  });

  it("sends segments (the valid ids) only when blocks was given, and nothing on the never list", async () => {
    withBlocks();
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments: "from_target_class", blocks: ["monday"] });
    expect(body).toEqual({
      action: "copy",
      registration_id: 55,
      schedule_id: 9,
      status: "registered",
      segments: [501],
    });
  });
});

describe("bookings_copy_booking — blocks (ZMCP-20261121-002)", () => {
  function preflights(): Array<Record<string, unknown>> {
    return calls
      .filter((c) => c.body?.action === "preflight_check")
      .map((c) => c.body!.preflight_properties as Record<string, unknown>);
  }

  it("resolves names case-insensitively and sends a second, segment-scoped preflight", async () => {
    withBlocks();
    install(2, 2);
    await preview({ action: "copy", payments: "from_target_class", blocks: ["  MONDAY "] });
    const pf = preflights();
    expect(pf.length).toBe(2);
    expect(pf[0]).not.toHaveProperty("segments");
    expect(pf[1].segments).toEqual([501]);
  });

  it("the second preflight's price and session count drive the preview; blocks listed by name + dates", async () => {
    withBlocks();
    install(2, 2);
    const out = await preview({ action: "copy", payments: "from_target_class", blocks: ["monday"] });
    expect(out.money.target_class_price_total).toBe(120);
    expect(out.money.target_will_owe_total).toBe(135); // 120 + the schedule's 15 fee
    expect(out.money.sessions_remaining).toBe(5);
    expect(out.target.sessions_remaining).toBe(5);
    expect(out.money.blocks).toEqual([{ name: "Monday", start: "2026-09-07", end: "2027-01-25" }]);
    expect(out.money.result).toContain("Booked into these blocks only: Monday");
    expect(writesSent()).toBe(0);
  });

  it("never shows segment ids in the model-facing preview or apply text", async () => {
    withBlocks();
    install(2, 2);
    const r = await previewRaw({ action: "move", payments: "from_target_class", blocks: ["Monday", "wednesday"] });
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/50[12]/);
    const token = JSON.parse(r.text).token;
    const applied = (await runCopyBooking({ token, confirmed: true }, AUTH)) as { content: Array<{ text: string }> };
    expect(applied.content[0].text).not.toMatch(/50[12]/);
    const write = calls.find((c) => c.method === "POST" && c.body?.action === "move");
    expect(write?.body?.segments).toEqual([501, 502]);
  });

  it("works together with a payment mode: free + blocks freezes debt 0 and the segments", async () => {
    withBlocks();
    install(2, 2);
    const body = await appliedBody({ action: "copy", payments: "free", blocks: ["wednesday"] });
    expect(body.debt).toBe(0);
    expect(body.registration_fee).toBe(0);
    expect(body.segments).toEqual([502]);
  });

  it("an unknown name lists every available block with its dates, before any second preflight or write", async () => {
    withBlocks();
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", blocks: ["monday", "tuesday"] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "The target class has no block named 'tuesday'. Available: Monday (2026-09-07 – 2027-01-25), " +
        "Wednesday (2026-09-09 – 2027-01-27).",
    );
    expect(r.text).not.toMatch(/50[12]/);
    expect(preflights().length).toBe(1);
    expect(writesSent()).toBe(0);
  });

  it("matches only blocks still running from start (remaining_segments), not all_segments", async () => {
    allSegments = BLOCKS;
    remainingSegments = [BLOCKS[1]];
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", blocks: ["monday"] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "The target class has no block named 'monday'. Available: Wednesday (2026-09-09 – 2027-01-27).",
    );
  });

  it("a target class with no blocks is refused with the not-divided error", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", blocks: ["monday"] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("The target class is not divided into blocks. Remove blocks.");
    expect(preflights().length).toBe(1);
    expect(writesSent()).toBe(0);
  });

  it("blocks together with target_event_id is refused before any call", async () => {
    withBlocks();
    install(2, 2);
    const r = await previewRaw({
      action: "copy",
      payments: "from_target_class",
      blocks: ["monday"],
      target_event_id: 4,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "blocks applies to classes sold in blocks; target_event_id is for one-off sessions. Send one or the other.",
    );
    expect(calls.length).toBe(0);
  });

  it("aborts when the second preflight rejects a block (requested_segments_exists), with no write", async () => {
    withBlocks();
    invalidSegmentIds = [502];
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", blocks: ["wednesday"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Zooza rejected the chosen blocks");
    expect(r.text).toContain("Monday (2026-09-07 – 2027-01-25)");
    expect(r.text).not.toMatch(/50[12]/);
    expect(writesSent()).toBe(0);
  });

  it("rejects an empty blocks list", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", blocks: [] });
    expect(r.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("without blocks only one preflight is sent and money has no blocks", async () => {
    withBlocks();
    install(2, 2);
    const out = await preview({ action: "copy", payments: "from_target_class" });
    expect(preflights().length).toBe(1);
    expect(out.money).not.toHaveProperty("blocks");
    expect(out.money.target_class_price_total).toBe(240);
  });
});

describe("bookings_copy_booking — past start into a started class", () => {
  // Preflight prices from `start` (Registration_Copy.php:107); the create prices from now
  // once the class has started (Registration.php:1990-1996). Live: preview 69, debt 50.
  it("refuses from_target_class with a past start when the class has started; no write", async () => {
    install(2, 2);
    scheduleStart = "2020-01-06";
    const r = await previewRaw({ action: "copy", payments: "from_target_class", start: "2020-02-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("start 2020-02-01 is in the past and the target class has already started");
    expect(r.text).toContain("custom_amount");
    expect(writesSent()).toBe(0);
  });

  it("fails closed when the class start cannot be read", async () => {
    install(2, 2);
    const r = await previewRaw({ action: "copy", payments: "from_target_class", start: "2020-02-01" });
    expect(r.isError).toBe(true);
  });

  it("allows a past start when the class has not started yet", async () => {
    install(2, 2);
    scheduleStart = "2999-01-04";
    const out = await preview({ action: "copy", payments: "from_target_class", start: "2020-02-01" });
    expect(out.token).toBeDefined();
  });

  it("allows a past start with custom_amount (explicit debt) and with blocks", async () => {
    install(2, 2);
    withBlocks();
    scheduleStart = "2020-01-06";
    targetStatus = "registered";
    const body = await appliedBody({
      action: "copy",
      payments: "custom_amount",
      custom_balance: 19,
      custom_registration_fee: 50,
      start: "2020-02-01",
      blocks: ["Monday"],
    });
    expect(body.debt).toBe(19);
    expect(body.registration_fee).toBe(50);
    expect(body.start).toBe("2020-02-01");
  });

  it("does not refuse a start of today or later", async () => {
    install(2, 2);
    scheduleStart = "2020-01-06";
    const out = await preview({ action: "copy", payments: "from_target_class", start: "2999-01-01" });
    expect(out.token).toBeDefined();
  });
});
