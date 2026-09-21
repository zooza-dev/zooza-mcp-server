import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cancelSessionsDescription,
  dayCount,
  spanOfDates,
  MAX_CLIENTS,
  MAX_SESSIONS,
  MAX_SPAN_DAYS,
  countRegisterForTest as countRegister,
  goingCount,
  nonMovingCount,
  projectSessionRow,
  resolveScope,
  runCancelSessions,
} from "./cancel-sessions.js";
import { clearUpdatePlanStore, saveUpdatePlan } from "./update-plan-store.js";

/** The guards under test all run before any network call, so a throwing auth
 *  object proves the refusal happened locally: if a test ever reaches upstream,
 *  it fails loudly instead of silently hitting a real API. */
const noNetworkAuth = new Proxy({} as never, {
  get() {
    throw new Error("a guard let the call through to the network");
  },
});

function textOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("resolveScope — exactly one entity", () => {
  it("refuses a call with no scope at all", () => {
    const r = resolveScope({});
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("exactly one scope");
  });

  it("refuses two scopes, naming both", () => {
    const r = resolveScope({ trainer_id: 5, schedule_id: 9, from: "2026-09-22", to: "2026-09-23" });
    expect(r).toHaveProperty("error");
    if ("error" in r) {
      expect(r.error).toContain("one entity at a time");
      expect(r.error).toContain("trainer");
      expect(r.error).toContain("schedule");
    }
  });

  it("refuses a bare date range with no entity", () => {
    // The whole point of the guard: "cancel everything next week" has no
    // reviewable blast radius.
    const r = resolveScope({ from: "2026-09-22", to: "2026-09-26" });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("exactly one scope");
  });

  it("refuses trainer_id without a complete range", () => {
    const r = resolveScope({ trainer_id: 412, from: "2026-09-22" });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("needs both from and to");
  });

  it("refuses an inverted range", () => {
    const r = resolveScope({ schedule_id: 3312, from: "2026-09-26", to: "2026-09-22" });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("must be on or before");
  });

  it("accepts one trainer with a range and reports the span", () => {
    const r = resolveScope({ trainer_id: 412, from: "2026-09-22", to: "2026-09-26" });
    expect(r).not.toHaveProperty("error");
    if (!("error" in r)) {
      expect(r.kind).toBe("trainer");
      expect(r.spanDays).toBe(5);
      expect(r.query.trainer_id).toBe(412);
      expect(r.query.from).toBe("2026-09-22");
    }
  });

  it("treats place_id + date as ONE scope, not two", () => {
    const r = resolveScope({ place_id: 8, date: "2026-09-25" });
    expect(r).not.toHaveProperty("error");
    if (!("error" in r)) {
      expect(r.kind).toBe("place");
      expect(r.spanDays).toBe(1);
    }
  });

  it("refuses place_id without a date", () => {
    const r = resolveScope({ place_id: 8 });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("needs a date");
  });

  it("refuses event_ids mixed with a date as two scopes", () => {
    const r = resolveScope({ event_ids: [1, 2], date: "2026-09-25" });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("one entity at a time");
  });

  it("refuses event_ids mixed with a range, pointing at event_ids", () => {
    // from/to is not a scope of its own, so this lands on the event_ids-specific
    // message rather than the two-scopes one.
    const r = resolveScope({ event_ids: [1, 2], from: "2026-09-22", to: "2026-09-26" });
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("already names the exact sessions");
  });

  it("builds an id-targeted query with filter=filter, which api-v1 requires", () => {
    const r = resolveScope({ event_ids: [98211, 98212] });
    expect(r).not.toHaveProperty("error");
    if (!("error" in r)) {
      expect(r.query.filter).toBe("filter");
      expect(r.query.ids).toBe("98211|98212");
    }
  });
});

describe("dayCount", () => {
  it("counts a single day as 1, inclusive", () => {
    expect(dayCount("2026-09-22", "2026-09-22")).toBe(1);
  });

  it("counts a Monday-to-Friday week as 5", () => {
    expect(dayCount("2026-09-22", "2026-09-26")).toBe(5);
  });

  it("returns 0 for unparseable input so the caller refuses", () => {
    expect(dayCount("not-a-date", "2026-09-26")).toBe(0);
  });
});

describe("projectSessionRow — reading the shape api-v1 actually sends", () => {
  // This row is shaped like a real GET /v1/events record: attendance counts as
  // flat `__calc__attendance__*` columns, capacity nested under `schedule`, the
  // trainer's name as a materialised column. The first version of this tool read
  // the names that find-events *projects* (attendance_counts / capacity /
  // trainer_name), which are absent here — so a session with 37 enrolled
  // previewed as "0 clients affected" and the 150-client cap never fired.
  const raw = {
    id: 98211,
    date: "2026-10-11 10:00:00",
    status: "scheduled",
    schedule_id: 3312,
    __calc__attendance__going: 37,
    __calc__attendance__attended: 2,
    __calc__attendance__noshow: 1,
    __calc__attendance__canceled: 4,
    __calc__attendance__canceled_late: 1,
    __calc__attendance__waitlist: 3,
    __calc__event_trainer: "Yowler Shafler",
    course: { name: "Registration course" },
    schedule: { name: "Registration course Sun 10:00", capacity: 40 },
  };

  it("reads the enrolled count from the raw column", () => {
    expect(goingCount(raw)).toBe(37);
  });

  it("returns 0 for a row that carries the PROJECTED names instead", () => {
    // Guards the regression directly: if someone reintroduces the projected
    // reads, this row is what production data looks like and it yields nothing.
    expect(goingCount({ attendance_counts: { going: 37 } } as never)).toBe(0);
  });

  it("counts marked and waitlisted attendees as staying behind, not the cancelled ones", () => {
    // attended 2 + noshow 1 + waitlist 3 = 6; the 5 canceled rows are already off
    // this session and the 37 going ones travel to the make-up.
    expect(nonMovingCount(raw)).toBe(6);
  });

  it("projects the operator-facing fields from their real sources", () => {
    expect(projectSessionRow(raw)).toEqual({
      event_id: 98211,
      date: "2026-10-11 10:00:00",
      schedule_id: 3312,
      class_name: "Registration course Sun 10:00",
      trainer_name: "Yowler Shafler",
      going: 37,
      capacity: 40,
    });
  });

  it("falls back to the course name when the class has none", () => {
    const { class_name } = projectSessionRow({ ...raw, schedule: { capacity: 40 } });
    expect(class_name).toBe("Registration course");
  });
});

describe("countRegister — the number the operator decides on", () => {
  // The register as api-v1 returns it: one row per enrolled registration, with
  // `attendance` null until someone marks it.
  const register = [
    { attendance: "going" },
    { attendance: null },
    { attendance: "attended" },
    { attendance: "noshow" },
    { attendance: "waitlist" },
    { attendance: "canceled" },
    { attendance: "canceled_late" },
  ];

  it("counts everyone still expecting the class, marked or not", () => {
    // going + unmarked + attended + noshow + waitlist = 5; the two cancelled
    // rows are already off this session.
    expect(countRegister(register).expected).toBe(5);
  });

  it("counts only a going row as actually travelling to a make-up", () => {
    expect(countRegister(register).moving).toBe(1);
  });

  it("counts unmarked rows as staying behind, not moving", () => {
    // The subtle one: an unmarked row looks like an attendee who will turn up,
    // but move_attendees skips it, so it stays on the cancelled session.
    expect(countRegister(register).staying).toBe(4);
  });

  it("reports an empty register as nobody affected", () => {
    expect(countRegister([])).toEqual({ expected: 0, moving: 0, staying: 0, live: true });
  });
});

describe("spanOfDates — the cap an event_ids list would otherwise dodge", () => {
  it("measures the span of a scattered list, not its length", () => {
    // The hole this closes: `event_ids` carries no from/to, so the pre-resolution
    // check saw nothing to measure and the 7-day promise did not apply to it.
    expect(spanOfDates(["2026-10-01 09:00:00", "2026-10-19 18:00:00"])).toBe(19);
  });

  it("reports 1 for several sessions on the same day", () => {
    expect(spanOfDates(["2026-10-01 09:00:00", "2026-10-01 17:30:00"])).toBe(1);
  });

  it("ignores unparseable dates and returns 0 when nothing parses", () => {
    expect(spanOfDates(["", "not a date"])).toBe(0);
  });

  it("stays within the cap for a deliberate 7-day window", () => {
    expect(spanOfDates(["2026-10-01 09:00:00", "2026-10-07 20:00:00"])).toBeLessThanOrEqual(
      MAX_SPAN_DAYS,
    );
  });
});

describe("runCancelSessions — refusals before any network call", () => {
  it("requires a reason", async () => {
    const r = await runCancelSessions(
      { company_id: 1, date: "2026-09-22" },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("reason is required");
  });

  it("requires public_reason when notify is on", async () => {
    // Clients would otherwise get a bare "cancelled" email with no explanation.
    const r = await runCancelSessions(
      { company_id: 1, date: "2026-09-22", reason: "Pool closed", notify: true },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("public_reason");
  });

  it("refuses a range wider than the cap before resolving anything", async () => {
    const r = await runCancelSessions(
      {
        company_id: 1,
        trainer_id: 412,
        from: "2026-09-01",
        to: "2026-09-30",
        reason: "Sick leave",
      },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(`the limit is ${MAX_SPAN_DAYS}`);
  });

  it("rejects `confirmed` sent without a token", async () => {
    const r = await runCancelSessions(
      { company_id: 1, date: "2026-09-22", reason: "Pool closed", confirmed: true },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("only applies when applying");
  });
});

describe("the silence warning", () => {
  it("is worded so an operator cannot skim past it", () => {
    // Asserted on the source rather than through a network call: the point is the
    // wording, and this is the sentence standing between an operator and 37
    // parents turning up to a class that is not happening.
    const src = readFileSync(new URL("./cancel-sessions.ts", import.meta.url), "utf8");
    expect(src).toContain("will NOT be told");
    expect(src).toContain("would only find out by turning up");
  });
});

describe("runCancelSessions — apply phase token handling", () => {
  it("refuses an unknown token", async () => {
    clearUpdatePlanStore();
    const r = await runCancelSessions(
      { token: "upd_sessions_cancel_nope", confirmed: true },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("no longer valid");
  });

  it("refuses a token minted by a different tool", async () => {
    clearUpdatePlanStore();
    const { token } = saveUpdatePlan({
      kind: "sessions",
      company_id: 1,
      event_payloads: [{ id: 1, date: "2026-09-22 09:00:00" }],
      summary: {},
    });
    const r = await runCancelSessions({ token, confirmed: true }, noNetworkAuth);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not a cancellation plan");
  });

  it("ignores a scope sent alongside a token — the plan is frozen", async () => {
    // The security property: a token cannot be replayed against a wider scope.
    // resolveDualPhase rejects any extra field on the apply call outright.
    clearUpdatePlanStore();
    const { token } = saveUpdatePlan({
      kind: "sessions_cancel",
      company_id: 1,
      event_payloads: [{ id: 98211, status: "unplanned", billable: false }],
      verify_replacement: false,
      summary: {},
    });
    const r = await runCancelSessions(
      { token, confirmed: true, trainer_id: 999, from: "2026-01-01", to: "2026-12-31" },
      noNetworkAuth,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain("999");
  });
});

describe("cancelSessionsDescription — what a fresh Claude must be able to tell apart", () => {
  it("states the one-entity rule and the caps", () => {
    expect(cancelSessionsDescription).toContain("exactly ONE entity");
    expect(cancelSessionsDescription).toContain(String(MAX_SESSIONS));
    expect(cancelSessionsDescription).toContain(String(MAX_CLIENTS));
  });

  it("distinguishes itself from the three tools it is most confusable with", () => {
    expect(cancelSessionsDescription).toContain("sessions_mark_attendance");
    expect(cancelSessionsDescription).toContain("sessions_update");
    expect(cancelSessionsDescription).toContain("NOT deleted");
  });

  it("says cancelling issues no make-up credits", () => {
    // The single most likely wrong promise to a client.
    expect(cancelSessionsDescription).toContain("no make-up credits");
  });
});
