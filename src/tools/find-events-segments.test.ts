import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindEvents } from "./find-events.js";

const AUTH: ZoozaAuth = { mode: "legacy", apiKey: "k", company: "1", legacyToken: "t", baseUrl: "https://api.test" };

describe("sessions_find_events — block names from the materialised column", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("splits __schedule_segments__name on '|' (api-v1 Materialization.php:421), keeping commas inside names", async () => {
    const event = { id: 9, schedule_id: 42, date: "2026-10-13 13:43:00", duration: 45, status: "scheduled", __schedule_segments__name: "Fasa|Mon, Group 1" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname;
        const body = path.endsWith("/events") ? { total: 1, data: [event] } : { total: 0, data: [] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
      }),
    );
    const r = await runFindEvents({ company_id: 1, schedule_id: 42 }, AUTH);
    expect(r.isError).toBeFalsy();
    const segments = r.structuredContent?.events[0]?.segments;
    expect(segments).toEqual(["Fasa", "Mon, Group 1"]);
  });
});
