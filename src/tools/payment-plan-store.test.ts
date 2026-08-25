import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPlanStore,
  getPlan,
  markPlanUsed,
  PAYMENT_PLAN_TTL_MS,
  type PaymentPlanApplication,
  savePlan,
} from "./payment-plan-store.js";

const PLAN: PaymentPlanApplication = {
  company_id: 1,
  registration_id: 52815,
  payment_schedule_id: 4805,
  total_price: 200,
  warnings: [],
};

describe("payment-plan-store", () => {
  beforeEach(() => clearPlanStore());

  it("issues a token that resolves back to the plan", () => {
    const { token, expires_in_seconds } = savePlan(PLAN);
    expect(expires_in_seconds).toBe(900);
    const found = getPlan(token);
    expect(found.ok && found.plan.payment_schedule_id).toBe(4805);
  });

  it("keeps total_price distinct from the plan id", () => {
    // Guards the confusion this tool exists to prevent: 4805 is a group plan id,
    // 200 is money, and 341 (the template) must never reach the apply body.
    const { token } = savePlan(PLAN);
    const found = getPlan(token);
    expect(found.ok && found.plan.total_price).toBe(200);
  });

  it("rejects an unknown token", () => {
    expect(getPlan("pay_p_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("expires after the TTL", () => {
    const now = 1_000_000;
    const { token } = savePlan(PLAN, now);
    expect(getPlan(token, now + PAYMENT_PLAN_TTL_MS - 1).ok).toBe(true);
    expect(getPlan(token, now + PAYMENT_PLAN_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("is single-use once marked", () => {
    const { token } = savePlan(PLAN);
    markPlanUsed(token);
    expect(getPlan(token)).toEqual({ ok: false, reason: "used" });
  });

  it("survives a lookup that does not mark it used", () => {
    // The apply path burns the token only AFTER the write lands, so a transport
    // failure must leave it usable for one retry.
    const { token } = savePlan(PLAN);
    expect(getPlan(token).ok).toBe(true);
    expect(getPlan(token).ok).toBe(true);
  });
});
