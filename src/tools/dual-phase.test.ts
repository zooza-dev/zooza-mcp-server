import { describe, expect, it } from "vitest";
import { resolveDualPhase } from "./dual-phase.js";

describe("resolveDualPhase — preview phase", () => {
  it("treats a call with no token as a preview", () => {
    expect(resolveDualPhase({ course_id: 7, section: "trial" })).toEqual({ kind: "preview" });
  });

  it("treats an empty or whitespace token as no token", () => {
    // An LLM echoing back an empty string must not be read as an apply call.
    expect(resolveDualPhase({ token: "" })).toEqual({ kind: "preview" });
    expect(resolveDualPhase({ token: "   " })).toEqual({ kind: "preview" });
  });

  it("tolerates undefined args", () => {
    expect(resolveDualPhase(undefined)).toEqual({ kind: "preview" });
    expect(resolveDualPhase(null)).toEqual({ kind: "preview" });
  });

  it("rejects `confirmed` on the preview phase", () => {
    // Accepting it here would teach the model to send it pre-emptively, which
    // would hollow out the assertion on the apply phase.
    const r = resolveDualPhase({ course_id: 7, confirmed: true });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("only applies when applying");
    }
  });

  it("rejects `confirmed: false` on the preview phase too", () => {
    expect(resolveDualPhase({ course_id: 7, confirmed: false }).kind).toBe("error");
  });
});

describe("resolveDualPhase — apply phase", () => {
  it("accepts token + confirmed", () => {
    expect(resolveDualPhase({ token: "crs_p_abc", confirmed: true })).toEqual({
      kind: "apply",
      token: "crs_p_abc",
    });
  });

  it("rejects a token without `confirmed`", () => {
    const r = resolveDualPhase({ token: "crs_p_abc" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("confirmed: true");
    }
  });

  it("rejects `confirmed: false`", () => {
    expect(resolveDualPhase({ token: "crs_p_abc", confirmed: false }).kind).toBe("error");
  });

  it("rejects a truthy non-boolean `confirmed`", () => {
    // Strict === true: "yes" / 1 must not pass as an approval assertion.
    expect(resolveDualPhase({ token: "t", confirmed: "yes" }).kind).toBe("error");
    expect(resolveDualPhase({ token: "t", confirmed: 1 }).kind).toBe("error");
  });

  it("rejects preview fields sent alongside a token", () => {
    const r = resolveDualPhase({ token: "t", confirmed: true, section: "trial", changes: {} });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("`changes`");
      expect(r.message).toContain("`section`");
      expect(r.message).toContain("token, confirmed");
    }
  });

  it("names only the caller-facing fields as accepted, not wrapper-injected ones", () => {
    const r = resolveDualPhase({ token: "t", confirmed: true, section: "trial" });
    if (r.kind !== "error") throw new Error("expected error");
    // company_id is tolerated but is not something the model should be told to send.
    expect(r.message).not.toContain("company_id");
  });

  it("ignores keys whose value is undefined", () => {
    // Clients routinely serialise absent optionals as explicit undefined.
    expect(resolveDualPhase({ token: "t", confirmed: true, section: undefined })).toEqual({
      kind: "apply",
      token: "t",
    });
  });
});

describe("resolveDualPhase — wrapper-injected company_id", () => {
  it("tolerates company_id on the apply phase", () => {
    // resolveCompanyId (index.ts) injects this BEFORE the handler runs, so it is
    // present whether or not the model sent it and the handler cannot tell them
    // apart. Rejecting it would break every apply call in the single-company case.
    expect(resolveDualPhase({ token: "t", confirmed: true, company_id: 42 })).toEqual({
      kind: "apply",
      token: "t",
    });
  });

  it("still returns only the token, so the caller cannot read company_id from here", () => {
    // The apply path must take its company from the stored plan. This assertion
    // documents that intent: the decision object deliberately carries no company.
    const r = resolveDualPhase({ token: "t", confirmed: true, company_id: 999 });
    expect(r).not.toHaveProperty("company_id");
  });
});

describe("resolveDualPhase — per-tool extra apply fields", () => {
  it("accepts a declared extra field", () => {
    expect(
      resolveDualPhase({ token: "t", confirmed: true, confirm_large_send: true }, [
        "confirm_large_send",
      ]),
    ).toEqual({ kind: "apply", token: "t" });
  });

  it("rejects that same field when the tool has not declared it", () => {
    expect(resolveDualPhase({ token: "t", confirmed: true, confirm_large_send: true }).kind).toBe(
      "error",
    );
  });

  it("lists declared extras in the rejection message", () => {
    const r = resolveDualPhase({ token: "t", confirmed: true, audience: {} }, [
      "confirm_large_send",
    ]);
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.message).toContain("token, confirmed, confirm_large_send");
  });
});
