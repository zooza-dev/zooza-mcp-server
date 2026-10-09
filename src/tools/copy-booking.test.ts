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

function preflight(): unknown {
  const props: Record<string, { name: string; value: unknown }> = {};
  for (const [name, value] of Object.entries({
    current_price: 0,
    target_price: 240,
    target_status: "pre_registered",
    remaining_events_count: 10,
    target_capacity: 10,
    target_registered: 2,
    current_billing_period_name: "Trial",
    target_billing_period_name: "Autumn",
  })) {
    props[name] = { name, value };
  }
  return { checks: { schedule_full: { name: "schedule_full", result: "passed", severity: "error" } }, properties: props };
}

let calls: Array<{ path: string; method: string }> = [];
function install(sourceCourse: number, targetCourse: number): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: (init?.method ?? "GET").toUpperCase() });
      if (path.endsWith("/registrations/55")) return ok({ id: 55, course_id: sourceCourse });
      if (path.endsWith("/schedules/9")) {
        return ok({ id: 9, course_id: targetCourse, registration_fee: 15, unit_price: 12 });
      }
      if (path.endsWith("/registrations")) return ok(preflight());
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

afterEach(() => {
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
