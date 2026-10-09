import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { rebuildRegistrationUrl, runFindClasses } from "./find-classes.js";
import type { RawScheduleRecord } from "./types.js";

// ZMCP-20261009-008 (#30, #20): registration_url rebuilt from live columns,
// billing_period_id surfaced and filterable.

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

function row(over: Partial<RawScheduleRecord>): RawScheduleRecord {
  return { id: 5, course_id: 2, place_id: 3988, room_id: 0, ...over };
}

describe("rebuildRegistrationUrl", () => {
  it("rebuilds course/place/room from the live row when the stored URL is stale", () => {
    const url = rebuildRegistrationUrl(
      row({ __calc__registration_url: "https://x.zooza.site/registration?schedule_id=5&course_id=1&place_id=52_0" }),
    );
    expect(url).toBe("https://x.zooza.site/registration?schedule_id=5&course_id=2&place_id=3988_0");
  });

  it("returns empty string when nothing is stored", () => {
    expect(rebuildRegistrationUrl(row({ __calc__registration_url: "" }))).toBe("");
    expect(rebuildRegistrationUrl(row({}))).toBe("");
  });

  it("keeps foreign widget params and uses the room id", () => {
    const url = rebuildRegistrationUrl(
      row({
        room_id: 7,
        __calc__registration_url: "https://w.example/reg?lang=sk&schedule_id=5&course_id=1&place_id=52_0",
      }),
    );
    expect(url).toBe("https://w.example/reg?lang=sk&schedule_id=5&course_id=2&place_id=3988_7");
  });
});

describe("runFindClasses — billing_period_id", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(records: unknown[]): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        urls.push(String(input));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: records, total: records.length }),
        } as unknown as Response;
      }),
    );
    return urls;
  }

  it("pipe-joins an array filter and reports each class's billing period", async () => {
    const urls = stub([
      { id: 1, billing_periods_schedules: { id: 9, billing_period_id: 371, schedule_id: 1, company_id: 1 } },
      { id: 2, billing_periods_schedules: [{ billing_period_id: "433" }] },
      { id: 3 },
    ]);
    const res = await runFindClasses({ company_id: 1, billing_period_id: [371, 433] }, AUTH);
    expect(res.isError).toBeUndefined();
    expect(new URL(urls[0]).searchParams.get("billing_period_id")).toBe("371|433");
    const out = JSON.parse(res.content[0].text) as { matches: Array<{ billing_period_id: number }> };
    expect(out.matches.map((m) => m.billing_period_id)).toEqual([371, 433, 0]);
  });

  it("accepts a single id", async () => {
    const urls = stub([]);
    await runFindClasses({ company_id: 1, billing_period_id: 371 }, AUTH);
    expect(new URL(urls[0]).searchParams.get("billing_period_id")).toBe("371");
  });
});
