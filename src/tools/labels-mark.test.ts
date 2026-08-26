import { describe, expect, it } from "vitest";
import { runLabelsMark } from "./labels-mark.js";

const AUTH = { apiKey: "k", legacyToken: "t", company: "1" } as never;

describe("labels_mark — input validation (pre-network)", () => {
  it("rejects an unsupported object_type with the supported-types teaching message", async () => {
    const r = await runLabelsMark(
      { company_id: 1, object_type: "event", object_id: 5, label: "x", present: true },
      AUTH,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("course, schedule or registration");
  });

  it("requires present as a boolean", async () => {
    const r = await runLabelsMark(
      { company_id: 1, object_type: "registration", object_id: 5, label: "converted" },
      AUTH,
    );
    expect(r.isError).toBe(true);
  });
});
