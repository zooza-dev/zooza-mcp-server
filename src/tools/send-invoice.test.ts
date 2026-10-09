import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPlanStore, getPlan, savePlan } from "./invoice-plan-store.js";
import { ZoozaApiError } from "../zooza.js";
import { invoiceBody, invoiceError, runPaymentsSendInvoice } from "./send-invoice.js";

const auth = { mode: "legacy", apiKey: "", company: "1", legacyToken: "", baseUrl: "http://api.test" } as never;

function mockFetch(handler: (url: URL, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = handler(url, init);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPlanStore();
});

describe("invoiceBody", () => {
  it("mirrors the app's create call with the previewed period", () => {
    expect(
      invoiceBody({ registration_id: 5, period_start: "2026-01-01 00:00:00", period_end: "2026-02-01 23:59:59", invoice_amount: 100 }, false),
    ).toEqual({
      order_id: 5,
      order_type: "course",
      skip_queue: true,
      start: "2026-01-01 00:00:00",
      end: "2026-02-01 23:59:59",
      notify_customer: false,
    });
  });
});

describe("payments_send_invoice preview", () => {
  it("bills the charged amount, flags overlap with an earlier invoice, skips nothing-paid bookings", async () => {
    mockFetch((url) => {
      const id = url.searchParams.get("order_id");
      if (url.pathname.endsWith("/customer_invoices/preview")) {
        return id === "1"
          ? { period_start: "2026-01-01 00:00:00", period_end: "2026-03-01 23:59:59", debt: -300, paid: 100 }
          : { period_start: "2026-01-01 00:00:00", period_end: "2026-03-01 23:59:59", debt: -50, paid: 0 };
      }
      return {
        total: 1,
        data:
          id === "1"
            ? [{ id: 9, invoice_no: "F-1", period_start: "2026-02-01 00:00:00", period_end: "2026-02-10 23:59:59", total_gross: 300, engine_return_code: "F-1" }]
            : [],
      };
    });
    const r = await runPaymentsSendInvoice({ company_id: 1, registration_ids: [1, 2] }, auth);
    const out = JSON.parse(r.content[0].text);
    expect(out.to_invoice).toHaveLength(1);
    expect(out.to_invoice[0]).toMatchObject({ registration_id: 1, invoice_amount: 300, paid: 100, outstanding: 200 });
    expect(out.to_invoice[0].warnings[0]).toContain("F-1");
    expect(out.skipped).toEqual([{ registration_id: 2, reason: "no payment in 2026-01-01 – 2026-03-01" }]);
    expect(out.send_to_client).toBe(true);
    expect(getPlan(out.token).ok).toBe(true);
  });

  it("errors when every booking is skipped", async () => {
    mockFetch((url) =>
      url.pathname.endsWith("/preview")
        ? { period_start: "2026-01-01 00:00:00", period_end: "2026-01-01 23:59:59", debt: 0, paid: 0 }
        : { total: 0, data: [] },
    );
    const r = await runPaymentsSendInvoice({ company_id: 1, registration_ids: [3] }, auth);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("nothing charged");
  });
});

describe("payments_send_invoice apply", () => {
  it("issues invoices sequentially from the stored plan and burns the token first", async () => {
    const { token } = savePlan({
      company_id: 1,
      send_to_client: true,
      items: [
        { registration_id: 1, period_start: "a", period_end: "b", invoice_amount: 300 },
        { registration_id: 2, period_start: "a", period_end: "b", invoice_amount: 50 },
      ],
    });
    const posted: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      posted.push(body);
      if (body.order_id === 2) return new Response(JSON.stringify({ errors: ["insert_failed"] }), { status: 400 });
      return new Response(JSON.stringify({ id: 77, invoice_no: "F-2", total_gross: 300, currency: "EUR" }), { status: 200 });
    });
    const r = await runPaymentsSendInvoice({ company_id: 1, token, confirmed: true }, auth);
    const out = JSON.parse(r.content[0].text);
    expect(posted).toHaveLength(2);
    expect(out.issued).toEqual([{ registration_id: 1, invoice_id: 77, invoice_no: "F-2", total: 300, currency: "EUR" }]);
    expect(out.failed[0].registration_id).toBe(2);
    expect(out.next_step).toContain("fresh preview");
    expect(getPlan(token)).toEqual({ ok: false, reason: "used" });
  });
});

describe("invoiceError", () => {
  it("adds the engine's message from errors[] to the bare engine name", () => {
    const body = JSON.stringify({
      error_log_raw: [{ key: "invoice_creation_failed", val: "xero" }],
      errors: [{ invoice_creation_failed: "xero" }, { ENGINE_ERROR: "XERO-Forbidden" }],
    });
    expect(invoiceError(new ZoozaApiError(400, "/customer_invoices", body))).toBe("api-v1 400: xero — XERO-Forbidden");
  });
});
