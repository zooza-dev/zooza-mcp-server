import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPlanStore,
  type CourseSettingsPlan,
  getPlan,
  markPlanUsed,
  PLAN_TTL_MS,
  savePlan,
} from "./course-settings-plan-store.js";

const PLAN: CourseSettingsPlan = {
  company_id: 7,
  course_id: 1019,
  section: "online_booking",
  put_body: {
    online_registration: false,
    // Guard echoes prepare always attaches (feedback-wipe trap).
    feedback_during_course: true,
    feedback_after_course: false,
  },
  diff: [
    { field: "online_registration", label: "Online booking", current: true, proposed: false },
  ],
  warnings: [],
};

const T0 = 1_750_000_000_000;

describe("course settings plan store", () => {
  beforeEach(() => clearPlanStore());

  it("round-trips a plan and reports TTL in seconds", () => {
    const { token, expires_in_seconds } = savePlan(PLAN, T0);
    expect(token).toMatch(/^crs_p_/);
    expect(expires_in_seconds).toBe(900);
    const lookup = getPlan(token, T0 + 1000);
    expect(lookup).toEqual({ ok: true, plan: PLAN });
  });

  it("rejects unknown tokens", () => {
    expect(getPlan("crs_p_nope", T0)).toEqual({ ok: false, reason: "unknown" });
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
