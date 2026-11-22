import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { overlapping, runAddBillingPeriod } from "./add-billing-period.js";

// Spec ZMCP-20261121-001.

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(existing: unknown[], post?: { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body ? JSON.parse(init.body) : undefined });
      const res = method === "GET" ? { status: 200, body: { data: existing, total: existing.length } } : post!;
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => JSON.stringify(res.body),
      } as unknown as Response;
    }),
  );
  return calls;
}

const winter = { id: 7, name: "Winter 2026", active: true, period_start: "2026-01-05", period_end: "2026-03-27" };

describe("classes_add_billing_period", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects end before start without calling api-v1", async () => {
    const calls = stub([]);
    const r = await runAddBillingPeriod(
      { company_id: 1, name: "Spring 2027", period_start: "2027-04-12", period_end: "2027-04-01" },
      AUTH,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("is before period_start");
    expect(calls).toHaveLength(0);
  });

  it("returns an exact (case-insensitive) name match without writing", async () => {
    const calls = stub([{ ...winter, name: "Spring 2027", id: 42 }]);
    const r = await runAddBillingPeriod({ company_id: 1, name: "spring 2027 " }, AUTH);
    const out = JSON.parse(r.content[0].text);
    expect(out.created).toBe(false);
    expect(out.billing_period.id).toBe(42);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("creates, omits unset dates, sends no pagination, and warns about a single date", async () => {
    const calls = stub([winter], {
      status: 200,
      body: { id: 43, name: "Autumn 2027", active: true, period_start: "2027-09-06", period_end: null },
    });
    const r = await runAddBillingPeriod({ company_id: 1, name: "Autumn 2027", period_start: "2027-09-06" }, AUTH);
    const out = JSON.parse(r.content[0].text);
    expect(out.created).toBe(true);
    expect(out.billing_period).toEqual({
      id: 43,
      name: "Autumn 2027",
      active: true,
      period_start: "2027-09-06",
      period_end: null,
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "Autumn 2027", period_start: "2027-09-06" });
    for (const c of calls) {
      const q = new URL(c.url).searchParams;
      expect(q.has("page")).toBe(false);
      expect(q.has("page_size")).toBe(false);
    }
    expect(out.warnings.join(" ")).toContain("Only one end of the range");
    expect(out.warnings.join(" ")).toContain("priority-registration");
  });

  it("warns about an overlapping period but still creates", async () => {
    stub([winter], { status: 200, body: { id: 44, name: "Late Winter", active: true } });
    const r = await runAddBillingPeriod(
      { company_id: 1, name: "Late Winter", period_start: "2026-03-01", period_end: "2026-04-30" },
      AUTH,
    );
    const out = JSON.parse(r.content[0].text);
    expect(out.created).toBe(true);
    expect(out.warnings.join(" ")).toContain('Overlaps with existing billing period "Winter 2026"');
  });

  it("reports an unknown outcome on 5xx and tells the model a retry is safe", async () => {
    stub([], { status: 500, body: { error: "boom" } });
    const r = await runAddBillingPeriod({ company_id: 1, name: "Spring 2027" }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("may or may not exist");
  });

  it("refuses to create when the pre-flight read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, text: async () => "bad gateway" }) as unknown as Response),
    );
    const r = await runAddBillingPeriod({ company_id: 1, name: "Spring 2027" }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("nothing was created");
  });
});

describe("overlapping", () => {
  it("treats a missing bound as open and ignores dateless periods", () => {
    const recs = [
      { id: 1, name: "A", period_start: "2026-01-01", period_end: "2026-02-01" },
      { id: 2, name: "B", period_start: null, period_end: null },
      { id: 3, name: "C", period_start: "2027-01-01", period_end: null },
    ];
    expect(overlapping(recs, "2026-01-15", "2026-01-20").map((o) => o.name)).toEqual(["A"]);
    expect(overlapping(recs, "2028-01-01", undefined).map((o) => o.name)).toEqual(["C"]);
    expect(overlapping(recs, undefined, undefined)).toEqual([]);
  });
});
