import { describe, it, expect } from "vitest";
import { computeAllowedStatuses } from "./get-attendance.js";

/**
 * Verifies the allowed_statuses gate against api-v1's confirmed rule
 * (agreed handoff 2026-05-28-attendance-field-shapes, `Attendance.php:1356-1363`):
 *   - cross-company → block exactly canceled/going.
 *   - company `limited` + caller in {main_member, member, external_member,
 *     receptionist} → block exactly canceled/going.
 *   - otherwise → all five.
 * `ignore` is NEVER blocked by the limited gate.
 */
const FULL = ["attended", "noshow", "canceled", "going", "ignore"];
const RESTRICTED = ["attended", "noshow", "ignore"];

const GATED_ROLES = ["main_member", "member", "external_member", "receptionist"];
const UNGATED_ROLES = ["owner", "assistant", "customer"];

describe("computeAllowedStatuses", () => {
  it("returns the full set when company is not limited, regardless of role", () => {
    for (const role of [...GATED_ROLES, ...UNGATED_ROLES]) {
      expect(computeAllowedStatuses(role, "default", false)).toEqual(FULL);
      expect(computeAllowedStatuses(role, null, false)).toEqual(FULL);
    }
  });

  it("blocks exactly canceled/going for gated roles under `limited`", () => {
    for (const role of GATED_ROLES) {
      expect(computeAllowedStatuses(role, "limited", false)).toEqual(RESTRICTED);
    }
  });

  it("does NOT restrict ungated roles even under `limited`", () => {
    for (const role of UNGATED_ROLES) {
      expect(computeAllowedStatuses(role, "limited", false)).toEqual(FULL);
    }
  });

  it("restricts cross-company rows regardless of role or policy", () => {
    expect(computeAllowedStatuses("owner", "default", true)).toEqual(RESTRICTED);
    expect(computeAllowedStatuses("member", "limited", true)).toEqual(RESTRICTED);
    expect(computeAllowedStatuses(null, null, true)).toEqual(RESTRICTED);
  });

  it("is optimistic (full set) when role is unknown and same-company", () => {
    // whoami fetch failed → role null → don't block blindly (mark_attendance
    // surfaces low_permissions per-row instead).
    expect(computeAllowedStatuses(null, "limited", false)).toEqual(FULL);
  });

  it("keeps `ignore` available in every restricted case", () => {
    expect(computeAllowedStatuses("member", "limited", false)).toContain("ignore");
    expect(computeAllowedStatuses("member", "limited", false)).not.toContain("canceled");
    expect(computeAllowedStatuses("member", "limited", false)).not.toContain("going");
  });
});
