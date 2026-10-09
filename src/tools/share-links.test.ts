import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPlanStore, getPlan, savePlan } from "./share-link-plan-store.js";
import {
  classEnded,
  pickWidget,
  registrationWidgets,
  runClassesAddShareLink,
  runClassesListShareLinks,
  shareLinkBody,
} from "./share-links.js";

const auth = { mode: "legacy", apiKey: "", company: "1", legacyToken: "", baseUrl: "http://api.test" } as never;

const APPS = {
  total: 3,
  data: [
    {
      id: 2,
      type: "widget",
      active: true,
      domain: "widgets-test.zooza.app",
      api_key: "secret",
      widgets: [
        { type: "profile", url: "https://widgets-test.zooza.app/x/profile" },
        { type: "registration", url: "https://widgets-test.zooza.app/x" },
      ],
    },
    { id: 12, type: "widget", active: true, domain: "zooza.sk", widgets: [] },
    { id: 1, type: "application", active: true, domain: "test.zooza.app", widgets: [{ type: "registration", url: "https://a" }] },
  ],
};
const SECOND_WIDGET = {
  id: 7,
  type: "widget",
  active: true,
  domain: "zooza.sk",
  widgets: [{ type: "registration", url: "https://zooza2.zooza.site/registration" }],
};
const SCHEDULE = { id: 50, name: "Juniors Mon", course_id: 9, status: "active", end: "2027-03-29", time: 600, total_events: 20 };

type Call = { method: string; path: string; body?: unknown };

function mockApi(opts: { apps?: unknown; schedule?: unknown; post?: () => Response } = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") {
      return opts.post?.() ?? new Response(JSON.stringify({ id: 31, link: "https://w/x?share=abc", expires: "2026-10-16 14:00:00", status: "active" }));
    }
    if (url.pathname.endsWith("/applications")) return new Response(JSON.stringify(opts.apps ?? APPS));
    if (url.pathname.endsWith("/share_links")) {
      return new Response(
        JSON.stringify({
          total: 1,
          data: [{ id: 31, application_id: 2, link: "https://w/x?share=abc", status: "expired", expires: "2026-10-01 10:00:00", created: "2026-09-24 10:00:00", __calc__opened: 4, __calc__used: 1, token: "abc" }],
        }),
      );
    }
    return new Response(JSON.stringify(opts.schedule ?? SCHEDULE));
  });
  return calls;
}

function out(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 9, 14, 0)); // 2026-10-09 14:00 local
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearPlanStore();
});

describe("classes_add_share_link preview", () => {
  it("performs only GETs, defaults expiry to today + 7 days and auto-picks the single registration widget", async () => {
    const calls = mockApi();
    const r = await runClassesAddShareLink({ company_id: 1, schedule_id: 50 }, auth);
    expect(r.isError).toBeUndefined();
    const o = out(r);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(o.link_expires).toBe("2026-10-16");
    expect(o.registration_widget).toEqual({
      application_id: 2,
      name: "widgets-test.zooza.app",
      registration_url: "https://widgets-test.zooza.app/x",
    });
    expect(o.class).toMatchObject({ schedule_id: 50, name: "Juniors Mon", status: "active" });
    expect(JSON.stringify(o)).not.toContain("secret");
    expect(getPlan(o.token)).toEqual({
      ok: true,
      plan: { company_id: 1, schedule_id: 50, application_id: 2, expires: "2026-10-16" },
    });
  });

  it("refuses a past date and today", async () => {
    const calls = mockApi();
    for (const expires of ["2026-10-01", "2026-10-09"]) {
      const r = await runClassesAddShareLink({ company_id: 1, schedule_id: 50, expires }, auth);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("after today");
    }
    expect(calls).toHaveLength(0);
  });

  it("null expires = never expires; warns the class ends first", async () => {
    mockApi();
    const o = out(await runClassesAddShareLink({ company_id: 1, schedule_id: 50, expires: null }, auth));
    expect(o.link_expires).toBeNull();
    expect(o.expiry_note).toBe("never expires");
    expect(o.warnings[0]).toContain("ends 2027-03-29");
  });

  it("lists the choices instead of guessing when there are several registration widgets", async () => {
    mockApi({ apps: { total: 2, data: [...APPS.data, SECOND_WIDGET] } });
    const r = await runClassesAddShareLink({ company_id: 1, schedule_id: 50 }, auth);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("2 registration widgets");
    expect(r.content[0].text).toContain('"application_id":7');
    expect(r.content[0].text).toContain('"application_id":2');
  });

  it("uses an explicit application_id and rejects one that is not a registration widget", async () => {
    mockApi({ apps: { total: 2, data: [...APPS.data, SECOND_WIDGET] } });
    const ok = out(await runClassesAddShareLink({ company_id: 1, schedule_id: 50, application_id: 7 }, auth));
    expect(ok.registration_widget.application_id).toBe(7);
    const bad = await runClassesAddShareLink({ company_id: 1, schedule_id: 50, application_id: 1 }, auth);
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("application_id 1 is not a registration widget");
  });

  it("warns when the class is inactive or already ended", async () => {
    mockApi({ schedule: { ...SCHEDULE, status: "inactive", end: "2026-09-01" } });
    const o = out(await runClassesAddShareLink({ company_id: 1, schedule_id: 50 }, auth));
    expect(o.warnings).toHaveLength(2);
    expect(o.warnings[0]).toContain("inactive");
    expect(o.warnings[1]).toContain("already ended");
  });
});

describe("classes_add_share_link apply", () => {
  it("sends exactly one POST from the stored plan and burns the token after it lands", async () => {
    const calls = mockApi();
    const { token } = savePlan({ company_id: 1, schedule_id: 50, application_id: 2, expires: "2026-10-16" });
    const r = await runClassesAddShareLink({ company_id: 999, token, confirmed: true }, auth);
    expect(calls).toEqual([{ method: "POST", path: "/schedules/50/share_links", body: { application_id: 2, expires: "2026-10-16" } }]);
    expect(out(r)).toMatchObject({ share_link_id: 31, schedule_id: 50, link: "https://w/x?share=abc", status: "active" });
    expect(getPlan(token)).toEqual({ ok: false, reason: "used" });
    const again = await runClassesAddShareLink({ token, confirmed: true }, auth);
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("is used");
  });

  it("keeps the token when the POST fails (nothing was written)", async () => {
    mockApi({ post: () => new Response(JSON.stringify({ errors: ["insert_failed"] }), { status: 400 }) });
    const { token } = savePlan({ company_id: 1, schedule_id: 50, application_id: 2, expires: null });
    const r = await runClassesAddShareLink({ token, confirmed: true }, auth);
    expect(r.isError).toBe(true);
    expect(getPlan(token).ok).toBe(true);
  });

  it("dual-phase guards: confirmed without token, inputs with token, missing confirmed, unknown token", async () => {
    const calls = mockApi();
    const a = await runClassesAddShareLink({ schedule_id: 50, confirmed: true }, auth);
    expect(a.content[0].text).toContain("`confirmed` only applies");
    const { token } = savePlan({ company_id: 1, schedule_id: 50, application_id: 2, expires: null });
    const b = await runClassesAddShareLink({ token, confirmed: true, expires: "2026-12-01" }, auth);
    expect(b.content[0].text).toContain("`expires` cannot be sent together with a token");
    const c = await runClassesAddShareLink({ token }, auth);
    expect(c.content[0].text).toContain("Set confirmed: true");
    const d = await runClassesAddShareLink({ token: "shl_p_nope", confirmed: true }, auth);
    expect(d.content[0].text).toContain("is unknown");
    expect([a, b, c, d].every((r) => r.isError)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("classes_list_share_links", () => {
  it("projects the class's links without the raw token field", async () => {
    const calls = mockApi();
    const o = out(await runClassesListShareLinks({ company_id: 1, schedule_id: 50 }, auth));
    expect(calls).toEqual([{ method: "GET", path: "/schedules/50/share_links", body: undefined }]);
    expect(o.links).toEqual([
      {
        id: 31,
        link: "https://w/x?share=abc",
        status: "expired",
        expires: "2026-10-01 10:00:00",
        opened: 4,
        used: 1,
        created: "2026-09-24 10:00:00",
        application_id: 2,
      },
    ]);
  });
});

describe("helpers", () => {
  it("shareLinkBody mirrors the app's create payload", () => {
    expect(shareLinkBody(2, null)).toEqual({ application_id: 2, expires: null });
  });

  it("registrationWidgets keeps widget-type projects with a registration URL", () => {
    expect(registrationWidgets(APPS.data).map((w) => w.application_id)).toEqual([2]);
  });

  it("pickWidget errors when the company has none", () => {
    const r = pickWidget([], undefined);
    expect(r.ok).toBe(false);
  });

  it("classEnded follows Schedule::ended — no sessions never ends; end + time decides", () => {
    const now = new Date(2026, 9, 9, 14, 0);
    expect(classEnded({ total_events: 0, end: "2026-01-01" }, now)).toBe(false);
    expect(classEnded({ total_events: 3, end: "2026-10-09", time: 600 }, now)).toBe(true); // 10:00 today
    expect(classEnded({ total_events: 3, end: "2026-10-09", time: 900 }, now)).toBe(false); // 15:00 today
  });
});
