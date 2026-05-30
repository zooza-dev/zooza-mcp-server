import { describe, it, expect } from "vitest";
import { extractCompanies } from "./companies.js";

/**
 * Regression coverage for the session/whoami divergence bug: api-v1's
 * JWT-aware /v1/user response nests the company list under `user.companies`
 * (and sometimes `user.user_companies`). whoami probed those keys; the old
 * session-store copy did not, so the session ended up with zero companies
 * while whoami reported several — and omitting `company_id` returned a
 * misleading "No companies available". Both call sites now share THIS
 * function, so these cases lock the behaviour in one place.
 */
describe("extractCompanies", () => {
  it("reads companies nested under user.companies (the bug that bit us)", () => {
    const raw = { user: { companies: [{ id: 1, name: "Zooza Local" }, { id: 77, name: "ZOOZA CZ" }] } };
    expect(extractCompanies(raw)).toEqual([
      { id: 1, name: "Zooza Local" },
      { id: 77, name: "ZOOZA CZ" },
    ]);
  });

  it("reads companies under user.user_companies", () => {
    const raw = { user: { user_companies: [{ id: 2, name: "Baby Balance" }] } };
    expect(extractCompanies(raw)).toEqual([{ id: 2, name: "Baby Balance" }]);
  });

  it("still reads a top-level companies array and data.companies", () => {
    expect(extractCompanies({ companies: [{ id: 5, name: "Top" }] })).toEqual([{ id: 5, name: "Top" }]);
    expect(extractCompanies({ data: { companies: [{ id: 6, name: "Nested" }] } })).toEqual([
      { id: 6, name: "Nested" },
    ]);
  });

  it("falls back to company_id / company_name keys", () => {
    const raw = { user: { companies: [{ company_id: "84", company_name: "ZOOZA RO" }] } };
    expect(extractCompanies(raw)).toEqual([{ id: 84, name: "ZOOZA RO" }]);
  });

  it("accepts a bare array of numeric ids", () => {
    expect(extractCompanies({ companies: [1, 77] })).toEqual([
      { id: 1, name: "company 1" },
      { id: 77, name: "company 77" },
    ]);
  });

  it("returns an empty list for missing / malformed input", () => {
    expect(extractCompanies(null)).toEqual([]);
    expect(extractCompanies({})).toEqual([]);
    expect(extractCompanies({ user: {} })).toEqual([]);
    expect(extractCompanies({ companies: [{ name: "no id" }] })).toEqual([]);
  });
});
