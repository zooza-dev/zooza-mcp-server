import { describe, it, expect } from "vitest";
import { resolveBaseUrl } from "./region.js";

/**
 * Region → api-v1 base URL routing (ZMCP-20260529-003). Env is set in
 * vitest.config.ts: ZOOZA_API_BASE_EU and ZOOZA_API_BASE_UK are configured,
 * ASIA is not. The JWT `region` claim arrives lower-case ("eu"); env keys are
 * upper-case (ZOOZA_API_BASE_EU). There is no global fallback — an unmatched
 * region returns null and the caller rejects the request.
 */
describe("resolveBaseUrl", () => {
  it("resolves a configured region case-insensitively", () => {
    expect(resolveBaseUrl("eu")).toBe("http://test-eu/v1");
    expect(resolveBaseUrl("EU")).toBe("http://test-eu/v1");
    expect(resolveBaseUrl("uk")).toBe("http://test-uk/v1");
  });

  it("trims a trailing slash from the env value", () => {
    // ZOOZA_API_BASE_UK is set with a trailing slash; it must be stripped.
    expect(resolveBaseUrl("uk")).toBe("http://test-uk/v1");
  });

  it("returns null for a valid-shaped region with no configured env var", () => {
    expect(resolveBaseUrl("asia")).toBeNull();
  });

  it("returns null for absent region", () => {
    expect(resolveBaseUrl(null)).toBeNull();
    expect(resolveBaseUrl(undefined)).toBeNull();
    expect(resolveBaseUrl("")).toBeNull();
  });

  it("returns null for malformed region codes (fails /^[A-Z]{2,4}$/)", () => {
    expect(resolveBaseUrl("e")).toBeNull(); // too short
    expect(resolveBaseUrl("europe")).toBeNull(); // too long
    expect(resolveBaseUrl("e1")).toBeNull(); // non-letter
    expect(resolveBaseUrl("e u")).toBeNull(); // whitespace
  });
});
