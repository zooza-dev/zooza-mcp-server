import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { resetRetryLedger } from "./copy-retry-ledger.js";
import { MODE_ERROR, runShowCopyProgress, type CopyJobResult, type CopyProgressResult } from "./show-copy-progress.js";

// Spec ZMCP-20261122-002 (coverage mode, in_progress, job mode).

const AUTH: ZoozaAuth = { mode: "legacy", apiKey: "k", company: "1", legacyToken: "t", baseUrl: "https://api.test" };

const PERIODS = [
  { id: 81, name: "Winter 2026" },
  { id: 412, name: "Spring 2027" },
];

interface World {
  source?: unknown[];
  archived?: unknown[];
  target?: unknown[];
  places?: unknown[];
  courses?: unknown[];
  /** Server-side page cap, to prove paging follows `total`, not short pages. */
  cap?: number;
  failPath?: string;
  /** Status code for failPath (default 500). */
  failStatus?: number;
  failBody?: string;
  jobs?: { queued?: unknown[]; running?: unknown[] };
  job?: unknown;
  steps?: unknown[];
}

function cls(id: number, over: Record<string, unknown> = {}) {
  return { id, name: `Class ${id}`, course_id: 964, place_id: 16, trainer_id: 5, start: "2026-09-07", total_events: 12, schedule_type: "fixed_period", previous: 0, ...over };
}

function stub(w: World): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      const q = url.searchParams;
      if (w.failPath && url.pathname.endsWith(w.failPath)) {
        return { ok: false, status: w.failStatus ?? 500, text: async () => w.failBody ?? JSON.stringify({ errors: [] }) } as unknown as Response;
      }
      if (/\/jobs\/\d+$/.test(url.pathname)) {
        return { ok: true, status: 200, text: async () => JSON.stringify(w.job ?? {}) } as unknown as Response;
      }
      let rows: unknown[] = [];
      if (url.pathname.endsWith("/jobs")) rows = q.get("status") === "running" ? (w.jobs?.running ?? []) : q.get("status") === "queued" ? (w.jobs?.queued ?? []) : [];
      else if (url.pathname.endsWith("/steps")) rows = w.steps ?? [];
      if (url.pathname.endsWith("/billing_periods")) rows = PERIODS;
      else if (url.pathname.endsWith("/places")) rows = w.places ?? [];
      else if (url.pathname.endsWith("/courses")) rows = w.courses ?? [];
      else if (url.pathname.endsWith("/schedules")) {
        const bp = q.get("billing_period_id");
        rows = bp === "412" ? (w.target ?? []) : q.get("status") === "archive" ? (w.archived ?? []) : (w.source ?? []);
      }
      const page = Number(q.get("page") ?? 0);
      const size = Math.min(Number(q.get("page_size") ?? 1000), w.cap ?? 1000);
      const data = rows.slice(page * size, (page + 1) * size);
      return { ok: true, status: 200, text: async () => JSON.stringify({ total: rows.length, data }) } as unknown as Response;
    }),
  );
  return urls;
}

async function run(args: Record<string, unknown>): Promise<{ r: Awaited<ReturnType<typeof runShowCopyProgress>>; out: CopyProgressResult }> {
  const r = await runShowCopyProgress({ company_id: 1, source_billing_period_id: 81, target_billing_period_id: 412, ...args }, AUTH);
  return { r, out: r.isError ? (undefined as never) : JSON.parse(r.content[0].text) };
}

describe("classes_show_copy_progress — coverage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copied is decided by `previous` only; a same-named class without lineage is still remaining", async () => {
    stub({
      source: [cls(1), cls(2), cls(3)],
      target: [cls(101, { previous: 1 }), cls(102, { name: "Class 2", previous: 0 })],
      places: [{ id: 16, name: "Riverside" }],
    });
    const { out } = await run({});
    expect(out.copied).toEqual([{ source_schedule_id: 1, new_schedule_ids: [101] }]);
    expect(out.totals).toEqual({ source_classes: 3, copied: 1, in_progress: 0, remaining: 2, excluded: 0 });
    expect(out.remaining_chunks).toEqual([{ group: "Riverside", count: 2, schedule_ids: [2, 3] }]);
    expect(out.source.name).toBe("Winter 2026");
  });

  it("reads every page of a 120-class period even when the server caps page_size at 50", async () => {
    const source = Array.from({ length: 120 }, (_, i) => cls(i + 1));
    const urls = stub({ source, cap: 50, places: [{ id: 16, name: "Riverside" }] });
    const { out } = await run({});
    expect(out.totals.source_classes).toBe(120);
    expect(urls.filter((u) => u.startsWith("/schedules") && u.includes("billing_period_id=81") && !u.includes("status=archive"))).toHaveLength(3);
  });

  it("chunks are never larger than 25, and a big group is split and numbered", async () => {
    stub({ source: Array.from({ length: 60 }, (_, i) => cls(i + 1)), places: [{ id: 16, name: "Riverside" }] });
    const { out } = await run({});
    expect(out.remaining_chunks.map((c) => [c.group, c.count])).toEqual([
      ["Riverside (1/3)", 25], ["Riverside (2/3)", 25], ["Riverside (3/3)", 10],
    ]);
  });

  it("lead pipelines, archived classes and classes with no sessions are excluded with a reason", async () => {
    stub({
      source: [cls(1), cls(2, { schedule_type: "lead_collection" }), cls(3, { total_events: 0 })],
      archived: [cls(4)],
    });
    const { out } = await run({});
    expect(out.excluded.map((e) => [e.schedule_id, e.reason])).toEqual([[4, "archived"], [2, "lead_pipeline"], [3, "no_sessions"]]);
    expect(out.totals).toEqual({ source_classes: 4, copied: 0, in_progress: 0, remaining: 1, excluded: 3 });
  });

  it("classes of an archived programme are fetched (include_archived=1) and excluded, not dropped", async () => {
    const urls = stub({
      source: [cls(1, { course_id: 7 }), cls(2, { course_id: 8 })],
      courses: [{ id: 7, name: "Live", archive: false }, { id: 8, name: "Old", archive: true }],
    });
    const { out } = await run({});
    expect(out.excluded).toEqual([{ schedule_id: 2, name: "Class 2", reason: "programme_archived" }]);
    expect(out.totals).toEqual({ source_classes: 2, copied: 0, in_progress: 0, remaining: 1, excluded: 1 });
    expect(urls.filter((u) => u.startsWith("/schedules")).every((u) => u.includes("include_archived=1"))).toBe(true);
  });

  it("two copies of one class are both listed and flagged copied_twice", async () => {
    stub({ source: [cls(1)], target: [cls(101, { previous: 1 }), cls(102, { previous: "1" })] });
    const { out } = await run({});
    expect(out.copied).toEqual([{ source_schedule_id: 1, new_schedule_ids: [101, 102] }]);
    expect(out.flags).toEqual([{ source_schedule_id: 1, flag: "copied_twice" }]);
  });

  it("groups by instructor, programme and weekday with readable labels", async () => {
    stub({
      source: [
        cls(1, { trainer: { first_name: "Jana", last_name: "K" }, course_id: 7, start: "2026-09-07" }),
        cls(2, { trainer_id: 0, course_id: 8, start: "2026-09-08" }),
      ],
      courses: [{ id: 7, name: "Tots 1" }, { id: 8, name: "Tots 2" }],
    });
    expect((await run({ group_by: "instructor" })).out.remaining_chunks.map((c) => c.group)).toEqual(["Jana K", "no instructor"]);
    expect((await run({ group_by: "programme" })).out.remaining_chunks.map((c) => c.group)).toEqual(["Tots 1", "Tots 2"]);
    expect((await run({ group_by: "weekday" })).out.remaining_chunks.map((c) => c.group)).toEqual(["Monday", "Tuesday"]);
  });

  it("refuses the same period twice, and an unknown period, before reporting anything", async () => {
    stub({});
    const same = await runShowCopyProgress({ company_id: 1, source_billing_period_id: 81, target_billing_period_id: 81 }, AUTH);
    expect(same.content[0].text).toMatch(/are the same/);
    const unknown = await runShowCopyProgress({ company_id: 1, source_billing_period_id: 81, target_billing_period_id: 999 }, AUTH);
    expect(unknown.content[0].text).toBe("Billing period 999 not found. Resolve it via classes_find_resource kind:billing_period.");
  });

  it("a failed page fails the whole report instead of showing copied classes as remaining", async () => {
    stub({ source: [cls(1)], failPath: "/schedules" });
    const { r } = await run({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Zooza did not answer; try again.");
  });

  it("classes inside a queued or running copy job into the target are in_progress; lineage still wins", async () => {
    const into = (bp: number) => ({ overrides: { billing_period_id: bp } });
    const urls = stub({
      source: [cls(1), cls(2), cls(3), cls(4)],
      target: [cls(101, { previous: 1 })],
      jobs: {
        // Batch jobs carry the classes in payload.classes; source_schedule_id is null (live, job 500).
        queued: [{ id: 7, status: "queued", source_schedule_id: null, payload: { classes: { "1": into(412), "2": into(412) } } }],
        running: [{ id: 8, status: "running", source_schedule_id: null, payload: { classes: { "3": into(999) } } }],
      },
    });
    const { out } = await run({});
    expect(out.in_progress).toEqual([{ source_schedule_id: 2, job_id: 7, status: "queued" }]);
    expect(out.totals).toEqual({ source_classes: 4, copied: 1, in_progress: 1, remaining: 2, excluded: 0 });
    expect(out.remaining_chunks.flatMap((c) => c.schedule_ids)).toEqual([3, 4]);
    expect(out.next).toMatch(/Leave the classes in in_progress out/);
    // api-v1 matches status by equality, so one read per status.
    const jobUrls = urls.filter((u) => u.startsWith("/jobs"));
    expect(jobUrls.some((u) => u.includes("status=queued") && u.includes("type=schedule_copy"))).toBe(true);
    expect(jobUrls.some((u) => u.includes("status=running"))).toBe(true);
  });

  it("a failing jobs read does not fail coverage: it warns; a missing jobs resource (404) is silent", async () => {
    stub({ source: [cls(1)], failPath: "/jobs" });
    const failed = await run({});
    expect(failed.r.isError).toBeFalsy();
    expect(failed.out.totals.remaining).toBe(1);
    expect(failed.out.warnings[0]).toMatch(/Could not read the copy jobs/);
    vi.unstubAllGlobals();
    stub({ source: [cls(1)], failPath: "/jobs", failStatus: 404 });
    expect((await run({})).out.warnings).toEqual([]);
  });
});

describe("classes_show_copy_progress — job mode", () => {
  afterEach(() => vi.unstubAllGlobals());

  const runJob = async (args: Record<string, unknown>) => runShowCopyProgress({ company_id: 1, ...args }, AUTH);

  it("one copy job's status per class, from the job and its steps", async () => {
    const urls = stub({
      job: { id: 501, status: "running", created_at: "2026-11-22 15:17:56", finished_at: null },
      steps: [
        {
          status: "completed",
          input: { source_schedule_id: 6383 },
          result: { schedule_id: 1113005, bookings: [{ new_registration_id: 9, amount_charged: 10 }, { new_registration_id: 10, amount_charged: "10" }, { skipped: true, new_registration_id: null }] },
        },
        { status: "failed", input: { source_schedule_id: 6384 }, result: null, error_key: "capacity_exceeded", error_data: "capacity" },
        { status: "queued", input: { source_schedule_id: 6385 }, result: null },
      ],
    });
    const r = await runJob({ job_id: 501 });
    const out = JSON.parse(r.content[0].text) as CopyJobResult;
    expect(out.classes).toEqual([
      { source_schedule_id: 6383, status: "completed", new_schedule_id: 1113005, bookings_copied: 2, bookings_skipped: 1, amount_charged: 20, error: null },
      { source_schedule_id: 6384, status: "failed", new_schedule_id: null, bookings_copied: 0, bookings_skipped: 0, amount_charged: 0, error: "capacity_exceeded: capacity", retryable: false },
      { source_schedule_id: 6385, status: "queued", new_schedule_id: null, bookings_copied: 0, bookings_skipped: 0, amount_charged: 0, error: null },
    ]);
    expect(out.totals).toEqual({ classes: 3, completed: 1, failed: 1, waiting: 1 });
    expect(out.next).toMatch(/Do not start this copy again/);
    expect(urls).toContain("/jobs/501");
    expect(urls.some((u) => u.startsWith("/jobs/501/steps"))).toBe(true);
  });

  it("a temporary step error is retryable once, the same rule as the apply", async () => {
    resetRetryLedger();
    stub({
      job: { id: 597, status: "failed" },
      steps: [{
        status: "failed", input: { source_schedule_id: 6232 }, result: null,
        error_key: "internal_error", error_data: { value: "db_error", db_error: "Deadlock found", retryable: true, attempts: 3 },
      }],
    });
    const out = JSON.parse((await runJob({ job_id: 597 })).content[0].text) as CopyJobResult;
    expect(out.classes[0]).toMatchObject({ retryable: true });
    expect(out.classes[0].error).toMatch(/^internal_error: .*Deadlock found/);
    expect(out.next).toMatch(/Class 6232 failed with a temporary error \(retryable: true\)/);
    // Reading the same job again keeps the retry.
    expect((JSON.parse((await runJob({ job_id: 597 })).content[0].text) as CopyJobResult).classes[0].retryable).toBe(true);
  });

  it("an unknown job (api-v1 400 with 0065) reads as gone, pointing to coverage mode", async () => {
    stub({ failPath: "/jobs/42", failStatus: 400, failBody: JSON.stringify({ errors: [{ "0065": "Resource not found - Job" }] }) });
    const r = await runJob({ job_id: 42 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No copy job 42\. Finished jobs are kept for 7 days\. Use coverage mode/);
  });

  it("asks for exactly one mode", async () => {
    const urls = stub({});
    expect((await runJob({})).content[0].text).toBe(MODE_ERROR);
    expect((await runJob({ job_id: 1, source_billing_period_id: 81 })).content[0].text).toBe(MODE_ERROR);
    expect((await runJob({ source_billing_period_id: 81 })).content[0].text).toBe(MODE_ERROR);
    expect(urls).toEqual([]);
  });
});
