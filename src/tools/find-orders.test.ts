import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { projectOrder, runFindOrders } from "./find-orders.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;

// Keys copied from live api-test GET /orders?user_id=11391 (2026-10-09).
const LIVE_ROW = {
  id: 707,
  product_id: 153,
  user_id: 11391,
  status: "pending",
  payment_status: "unpaid",
  created: "2026-10-08 15:18:33",
  __calc__debt: -20,
  __calc__paid: 0,
  __calc__balance: -20,
  __users__full_name: "Martin Rapavy",
  __users__email: "x@example.com",
  __users__phone: "+421000000000",
  origin: null,
  __products__name: "Entry Pass",
  currency: null,
  product: { id: 153 },
  user: { id: 11391 },
};

describe("payments_find_orders — projection", () => {
  it("projects the live row and drops contact details", () => {
    const p = projectOrder(LIVE_ROW);
    expect(p).toEqual({
      order_id: 707,
      product_name: "Entry Pass",
      status: "pending",
      payment_status: "unpaid",
      charged: 20,
      paid: 0,
      balance: -20,
      currency: null,
      created: "2026-10-08 15:18:33",
      user_id: 11391,
      client_name: "Martin Rapavy",
    });
    expect(JSON.stringify(p)).not.toContain("example.com");
  });

  it("keeps null payment_status as null", () => {
    expect(projectOrder({ ...LIVE_ROW, payment_status: null }).payment_status).toBeNull();
  });

  it("paid order: charged 90, paid 90, balance 0", () => {
    const p = projectOrder({ ...LIVE_ROW, payment_status: "paid", __calc__debt: -90, __calc__paid: 90, __calc__balance: 0 });
    expect([p.charged, p.paid, p.balance]).toEqual([90, 90, 0]);
  });
});

describe("payments_find_orders — guards", () => {
  it("refuses without a targeting filter, before any API call", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const r = await runFindOrders({ company_id: 1, payment_status: "unpaid" }, AUTH);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("refusing to dump every order");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("never calls the single-order endpoint", () => {
    const src = readFileSync(new URL("./find-orders.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/["'`]\/orders\/[\$\{"'`]/);
    expect(src).not.toMatch(/\/orders\/\$\{/);
  });
});
