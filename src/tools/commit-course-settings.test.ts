import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import {
  buildApplied,
  commitFailureMessage,
  planInvalidMessage,
  runCommitCourseSettings,
} from "./commit-course-settings.js";
import {
  clearPlanStore,
  type CourseSettingsPlan,
  getPlan,
  markPlanUsed,
  PLAN_TTL_MS,
  savePlan,
} from "./course-settings-plan-store.js";

// The commit tool is one plan lookup + one PUT + one token burn — the token
// semantics ARE the behaviour under test, so these tests drive the full run
// function with the upstream call mocked instead of extracting more helpers.
vi.mock("../zooza.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../zooza.js")>();
  return { ...actual, zoozaFetch: vi.fn() };
});

const mockedFetch = vi.mocked(zoozaFetch);

const auth: ZoozaAuth = {
  mode: "legacy",
  apiKey: "key",
  company: "1", // deliberately NOT the plan's company — commit must use the frozen one
  legacyToken: "token",
  baseUrl: "http://api.test",
};

function plan(overrides: Partial<CourseSettingsPlan> = {}): CourseSettingsPlan {
  return {
    company_id: 77,
    course_id: 1019,
    section: "online_booking",
    put_body: {
      feedback_during_course: 1,
      feedback_after_course: 0,
      online_registration: false,
    },
    diff: [
      { field: "online_registration", label: "Online booking", current: 1, proposed: false },
    ],
    warnings: [],
    ...overrides,
  };
}

function resultText(result: Awaited<ReturnType<typeof runCommitCourseSettings>>): string {
  return result.content[0].text;
}

beforeEach(() => {
  clearPlanStore();
  mockedFetch.mockReset();
});

describe("plan lookup (error catalog)", () => {
  it("rejects an unknown token with the exact catalog message", async () => {
    const result = await runCommitCourseSettings({ token: "crs_p_nope" }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "This settings plan is unknown. Run classes_update_course_settings again to build a fresh plan.",
    );
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const { token } = savePlan(plan(), Date.now() - PLAN_TTL_MS - 1);
    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "This settings plan is expired. Run classes_update_course_settings again to build a fresh plan.",
    );
  });

  it("rejects an already-used token", async () => {
    const { token } = savePlan(plan());
    markPlanUsed(token);
    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "This settings plan is used. Run classes_update_course_settings again to build a fresh plan.",
    );
  });

  it("rejects missing input without touching the store or upstream", async () => {
    const result = await runCommitCourseSettings({}, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Missing or invalid input");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("successful commit", () => {
  it("PUTs exactly the stored put_body to the plan's course under the frozen company", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockResolvedValueOnce({ data: { id: 1019, name: "Ballet Beginners", online_registration: 0 } });

    await runCommitCourseSettings({ token }, auth);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [path, options, callAuth] = mockedFetch.mock.calls[0];
    expect(path).toBe("/courses/1019");
    expect(options).toEqual({
      method: "PUT",
      body: {
        feedback_during_course: 1,
        feedback_after_course: 0,
        online_registration: false,
      },
    });
    expect((callAuth as ZoozaAuth).company).toBe("77"); // plan company, not the request's
  });

  it("returns the output shape with applied echoing upstream-confirmed values, and burns the token", async () => {
    const { token } = savePlan(plan({ warnings: ["Some warning."] }));
    // Upstream returns the reloaded course with its own value representation (0, not false).
    mockedFetch.mockResolvedValueOnce({ data: { id: 1019, name: "Ballet Beginners", online_registration: 0 } });

    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(resultText(result))).toEqual({
      updated: true,
      course_id: 1019,
      section: "online_booking",
      applied: { online_registration: 0 },
      warnings: ["Some warning."],
    });
    expect(getPlan(token)).toEqual({ ok: false, reason: "used" });
  });

  it("unwraps a bare (non-enveloped) course response and falls back to sent values when a field is missing", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockResolvedValueOnce({ id: 1019, name: "Ballet Beginners" }); // no online_registration

    const result = await runCommitCourseSettings({ token }, auth);
    expect(JSON.parse(resultText(result)).applied).toEqual({ online_registration: false });
  });
});

describe("upstream failures (token survives, exact catalog rows)", () => {
  it("403 → permission catalog row, token NOT burned", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockRejectedValueOnce(new ZoozaApiError(403, "/courses/1019", "forbidden"));

    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "api-v1 rejected the update: this account lacks the edit_course permission (only owner and assistant roles can change programme settings).",
    );
    expect(getPlan(token).ok).toBe(true);
  });

  it("5xx → NOT-applied + retry-once catalog row, token NOT burned", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockRejectedValueOnce(new ZoozaApiError(502, "/courses/1019", "bad gateway"));

    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "Zooza API error (502) — the update was NOT applied. The token is still valid; retry classes_update_course_settings once.",
    );
    expect(getPlan(token).ok).toBe(true);
  });

  it("transport failure → NOT-applied + retry-once, token NOT burned", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "Zooza API error (network: fetch failed) — the update was NOT applied. The token is still valid; retry classes_update_course_settings once.",
    );
    expect(getPlan(token).ok).toBe(true);
  });

  it("other 4xx → NOT-applied + re-prepare guidance, token NOT burned", async () => {
    const { token } = savePlan(plan());
    mockedFetch.mockRejectedValueOnce(
      new ZoozaApiError(400, "/courses/1019", JSON.stringify({ errors: ["wrong_parameters_sent"] })),
    );

    const result = await runCommitCourseSettings({ token }, auth);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "api-v1 rejected the update (400: wrong_parameters_sent) — the update was NOT applied. " +
        "Run classes_update_course_settings again to build a fresh plan.",
    );
    expect(getPlan(token).ok).toBe(true);
  });

  it("a retry with the surviving token succeeds and only then burns it", async () => {
    const { token } = savePlan(plan());
    mockedFetch
      .mockRejectedValueOnce(new ZoozaApiError(500, "/courses/1019", "boom"))
      .mockResolvedValueOnce({ data: { id: 1019, online_registration: 0 } });

    const first = await runCommitCourseSettings({ token }, auth);
    expect(first.isError).toBe(true);

    const second = await runCommitCourseSettings({ token }, auth);
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(resultText(second)).updated).toBe(true);
    expect(getPlan(token)).toEqual({ ok: false, reason: "used" });
  });
});

describe("pure helpers", () => {
  it("planInvalidMessage renders each reason", () => {
    expect(planInvalidMessage("unknown")).toBe(
      "This settings plan is unknown. Run classes_update_course_settings again to build a fresh plan.",
    );
    expect(planInvalidMessage("expired")).toBe(
      "This settings plan is expired. Run classes_update_course_settings again to build a fresh plan.",
    );
    expect(planInvalidMessage("used")).toBe(
      "This settings plan is used. Run classes_update_course_settings again to build a fresh plan.",
    );
  });

  it("commitFailureMessage maps 403 / 5xx / 4xx / transport", () => {
    expect(commitFailureMessage(new ZoozaApiError(403, "/x", ""))).toContain("edit_course");
    expect(commitFailureMessage(new ZoozaApiError(503, "/x", ""))).toContain(
      "Zooza API error (503)",
    );
    expect(commitFailureMessage(new ZoozaApiError(404, "/x", "not found"))).toContain(
      "(404: not found)",
    );
    expect(commitFailureMessage(new Error("socket hang up"))).toContain("network: socket hang up");
  });

  it("buildApplied echoes upstream values per diff field and skips guard echoes", () => {
    const p = plan({
      diff: [
        { field: "price", label: "Price", current: "120.00", proposed: 150 },
        { field: "unit_price", label: "Unit price", current: "12.00", proposed: 15 },
      ],
      put_body: {
        feedback_during_course: 1,
        feedback_after_course: 0,
        fees_included_in_price: 1,
        price: 150,
        unit_price: 15,
      },
    });
    expect(buildApplied(p, { id: 1019, name: "x", price: "150.00" })).toEqual({
      price: "150.00", // upstream-confirmed representation
      unit_price: 15, // upstream omitted it — sent value
    });
    expect(buildApplied(p, undefined)).toEqual({ price: 150, unit_price: 15 });
  });
});
