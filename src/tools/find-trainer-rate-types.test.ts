import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoozaAuth } from "../auth/types.js";
import { runFindTrainerRateTypes } from "./find-trainer-rate-types.js";

/**
 * Covers classes_find_resource (kind:'trainer_rate_type') (ZMCP-20260703-001): the missing lookup that
 * turns a named pay rate into the trainer_rate_type_id the update tools require.
 * Mocks global fetch so the real endpoint path, envelope unwrap, name filter,
 * and projection execute.
 */

const AUTH: ZoozaAuth = {
  mode: "legacy",
  apiKey: "k",
  company: "1",
  legacyToken: "t",
  baseUrl: "https://api.test",
};

interface FetchCall {
  url: string;
  path: string;
  method: string;
}
let calls: FetchCall[] = [];

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
function fail(status: number, body: unknown = {}): Response {
  return { ok: false, status, text: async () => JSON.stringify(body) } as unknown as Response;
}
function installFetch(handler: (call: FetchCall) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const call: FetchCall = {
        url,
        path: new URL(url).pathname,
        method: (init?.method ?? "GET").toUpperCase(),
      };
      calls.push(call);
      return handler(call);
    }),
  );
}
function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const RATE_TYPES = {
  data: [
    { id: 3, company_id: 1, name: "Hourly", minutes: 60, type: "per_hour" },
    { id: 5, company_id: 1, name: "Per class", minutes: 0, type: "per_session" },
  ],
  total: 2,
};

describe("classes_find_resource (kind:'trainer_rate_type')", () => {
  it("hits GET /trainer_rates/types and projects {id, name, minutes, type}", async () => {
    installFetch(({ path }) => {
      if (path === "/trainer_rates/types") return ok(RATE_TYPES);
      throw new Error(`unexpected ${path}`);
    });
    const res = await runFindTrainerRateTypes({ company_id: 1 }, AUTH);
    expect(res.isError).toBeFalsy();
    expect(calls[0].path).toBe("/trainer_rates/types");
    const out = parse(res);
    expect(out.total).toBe(2);
    expect(out.matches).toEqual([
      { id: 3, name: "Hourly", minutes: 60, type: "per_hour" },
      { id: 5, name: "Per class", minutes: 0, type: "per_session" },
    ]);
  });

  it("filters by name substring (case-insensitive) MCP-side", async () => {
    installFetch(() => ok(RATE_TYPES));
    const res = await runFindTrainerRateTypes({ company_id: 1, name: "hour" }, AUTH);
    const out = parse(res);
    expect(out.total).toBe(1);
    expect((out.matches as Array<{ id: number }>)[0].id).toBe(3);
  });

  it("tolerates a bare array response and missing optional fields", async () => {
    installFetch(() => ok([{ id: 9, name: "Flat" }]));
    const res = await runFindTrainerRateTypes({ company_id: 1 }, AUTH);
    const out = parse(res);
    expect(out.matches).toEqual([{ id: 9, name: "Flat", minutes: null, type: null }]);
  });

  it("surfaces an api-v1 error as an actionable message", async () => {
    installFetch(() => fail(500, { message: "boom" }));
    const res = await runFindTrainerRateTypes({ company_id: 1 }, AUTH);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("trainer rate types");
  });
});
