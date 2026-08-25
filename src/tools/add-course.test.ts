import { describe, expect, it } from "vitest";
import { runAddCourse } from "./add-course.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;
const call = (args: Record<string, unknown>) =>
  runAddCourse({ company_id: 1, name: "X", programme_kind: "full_duration", ...args }, AUTH);

describe("classes_add_course — price ambiguity", () => {
  it("refuses a bare unit_price on an instalment programme and tells the model what to ask", async () => {
    // "jednotkova cena 300" nearly always means the whole run. Guessing cost three
    // real courses; the tool now forces the question instead.
    const r = await call({ payment_collection: "installments", unit_price: 300 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("per lesson, or for the whole course");
    expect(r.content[0].text).toContain("6000");
    expect(r.content[0].text).toContain("total_price");
  });

  it("accepts unit_price once the operator has confirmed it is per session", async () => {
    // Reaches the network layer, which means validation let it through.
    const r = await call({
      payment_collection: "installments",
      unit_price: 15,
      unit_price_is_per_session: true,
    });
    expect(r.content[0].text).not.toContain("per lesson, or for the whole course");
  });

  it("refuses a total and a per-session price together", async () => {
    const r = await call({
      payment_collection: "installments",
      unit_price: 15,
      unit_price_is_per_session: true,
      total_price: 300,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not both");
  });

  it("asks for a price when neither is given", async () => {
    const r = await call({ payment_collection: "installments" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("total_price");
  });

  it("does not gate pay_as_you_go, where per-session is the whole point", async () => {
    const r = await call({ programme_kind: "pay_as_you_go", unit_price: 8 });
    expect(r.content[0].text).not.toContain("per lesson, or for the whole course");
  });
});
