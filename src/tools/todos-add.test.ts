import { describe, expect, it } from "vitest";
import { runTodosAdd } from "./todos-add.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;

describe("todos_add — input validation (pre-network)", () => {
  it("requires entity_id when entity_type is set", async () => {
    const r = await runTodosAdd(
      { company_id: 1, message: "call them", to_user_id: 12, entity_type: "registration" },
      AUTH,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("entity_id is required");
  });

  it("requires message and to_user_id", async () => {
    const r = await runTodosAdd({ company_id: 1, message: "call them" }, AUTH);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("message and to_user_id");
  });

  it("rejects an unknown entity_type", async () => {
    const r = await runTodosAdd(
      { company_id: 1, message: "x", to_user_id: 12, entity_type: "inbound_reply", entity_id: 5 },
      AUTH,
    );
    expect(r.isError).toBe(true);
  });
});
