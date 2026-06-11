import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPlanStore,
  getPlan,
  markPlanUsed,
  type MessagePlan,
  PLAN_TTL_MS,
  savePlan,
} from "./message-plan-store.js";

const PLAN: MessagePlan = {
  company_id: 7,
  channel: "email",
  audience_params: { schedule_id: 482 },
  audience_echo: { schedule_id: 482 },
  subject: "Room change",
  body: "Hi *|FIRST_NAME|*, we moved to Room B.",
  marketing: false,
  guests: false,
  recipient_count: 23,
};

const T0 = 1_750_000_000_000;

describe("message plan store", () => {
  beforeEach(() => clearPlanStore());

  it("round-trips a plan and reports TTL in seconds", () => {
    const { token, expires_in_seconds } = savePlan(PLAN, T0);
    expect(token).toMatch(/^msg_p_/);
    expect(expires_in_seconds).toBe(900);
    const lookup = getPlan(token, T0 + 1000);
    expect(lookup).toEqual({ ok: true, plan: PLAN });
  });

  it("rejects unknown tokens", () => {
    expect(getPlan("msg_p_nope", T0)).toEqual({ ok: false, reason: "unknown" });
  });

  it("expires tokens after the TTL", () => {
    const { token } = savePlan(PLAN, T0);
    expect(getPlan(token, T0 + PLAN_TTL_MS - 1).ok).toBe(true);
    expect(getPlan(token, T0 + PLAN_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps the token valid until explicitly marked used (commit-retry contract)", () => {
    const { token } = savePlan(PLAN, T0);
    // getPlan does not consume — a failed commit can retry.
    expect(getPlan(token, T0).ok).toBe(true);
    expect(getPlan(token, T0).ok).toBe(true);
    markPlanUsed(token);
    expect(getPlan(token, T0)).toEqual({ ok: false, reason: "used" });
  });
});
