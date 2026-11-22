import { describe, expect, it } from "vitest";
import { runGetTerminology } from "./get-terminology.js";

async function canonicalNames(query: string): Promise<string[]> {
  const r = await runGetTerminology({ query });
  const body = JSON.parse(r.content[0].text) as { matches: Array<{ canonical_en: string }> };
  return body.matches.map((m) => m.canonical_en);
}

describe("get_terminology — term vs block", () => {
  it('ranks Billing period first for "term" (its synonym), not entries that merely contain "termín"', async () => {
    expect((await canonicalNames("term"))[0]).toBe("Billing period");
  });

  it('"semester" resolves to Billing period', async () => {
    expect((await canonicalNames("semester"))[0]).toBe("Billing period");
  });

  it('"term" is no longer a synonym of Block', async () => {
    const r = await runGetTerminology({ query: "block" });
    const body = JSON.parse(r.content[0].text) as {
      matches: Array<{ id: string; synonyms: string[] }>;
    };
    const block = body.matches.find((m) => m.id === "block");
    expect(block?.synonyms).not.toContain("term");
  });
});
