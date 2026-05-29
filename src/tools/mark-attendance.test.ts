import { describe, it, expect } from "vitest";
import { extractOpenTrialFollowupTodoId } from "./mark-attendance.js";

/**
 * Verifies trial-followup todo detection (agreed handoff -20260527-001 /
 * api API-20260529-001). The live fetch is best-effort and never throws; this
 * exercises the pure parsing that decides whether to echo `pending_action`.
 *
 * The extractor does NOT trust the endpoint's filtering — it verifies each
 * candidate todo belongs to the marked registration and is an open
 * trial_followup, so an endpoint that ignores an unknown query param (returning
 * company-wide or closed todos) can't cause a wrong/stale `todo_id` echo.
 */
const REG = 990;
const todo = (over: Record<string, unknown> = {}) => ({
  id: 42,
  status: "open",
  kind: "trial_followup",
  entity_type: "registration",
  entity_id: REG,
  ...over,
});

describe("extractOpenTrialFollowupTodoId", () => {
  it("returns the id of a matching open todo from a {data:[...]} envelope", () => {
    expect(extractOpenTrialFollowupTodoId({ data: [todo()] }, REG)).toBe(42);
  });

  it("returns the id from a bare array", () => {
    expect(extractOpenTrialFollowupTodoId([todo({ id: 7 })], REG)).toBe(7);
  });

  it("accepts a numeric-string entity_id", () => {
    expect(extractOpenTrialFollowupTodoId([todo({ entity_id: String(REG) })], REG)).toBe(42);
  });

  it("skips done/cancelled todos and returns the first matching open one", () => {
    const body = {
      data: [
        todo({ id: 1, status: "done" }),
        todo({ id: 2, status: "cancelled" }),
        todo({ id: 3, status: "open" }),
      ],
    };
    expect(extractOpenTrialFollowupTodoId(body, REG)).toBe(3);
  });

  it("rejects a todo for a DIFFERENT registration (endpoint ignored the filter)", () => {
    expect(extractOpenTrialFollowupTodoId([todo({ entity_id: 991 })], REG)).toBeNull();
  });

  it("rejects a non-trial_followup kind and a non-registration entity_type", () => {
    expect(extractOpenTrialFollowupTodoId([todo({ kind: "other" })], REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId([todo({ entity_type: "event" })], REG)).toBeNull();
  });

  it("treats a status-less or non-'open' row as NOT open", () => {
    expect(extractOpenTrialFollowupTodoId([todo({ status: undefined })], REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId([todo({ status: "OPEN" })], REG)).toBeNull();
  });

  it("returns null for empty / malformed / non-object bodies and id-less rows", () => {
    expect(extractOpenTrialFollowupTodoId({ data: [] }, REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId([], REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId(null, REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId("nope", REG)).toBeNull();
    expect(extractOpenTrialFollowupTodoId([todo({ id: undefined })], REG)).toBeNull();
  });
});
