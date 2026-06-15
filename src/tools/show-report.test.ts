import { describe, expect, it } from "vitest";
import {
  parsePagesRegistry,
  readArtifactHtml,
  renderArtifactHtml,
  runShowReport,
} from "./show-report.js";

/**
 * reports_show_report (spec ZMCP-20260612-002). The registry is parsed from the
 * REAL artifact file — these tests double as the drift guard between the tool
 * and artifacts/business-dashboard.html: if the PAGES descriptor shape changes,
 * parsing breaks here before it breaks in production.
 */

const text = (r: { content: Array<{ type: "text"; text: string }> }) =>
  r.content[0]?.text ?? "";

describe("parsePagesRegistry", () => {
  it("extracts every page kind from the real artifact", () => {
    const pages = parsePagesRegistry(readArtifactHtml());
    const ids = pages.map((p) => p.id);
    // Anchors, not an exhaustive list — new pages must NOT break this test.
    for (const id of ["home", "dashboard", "summary", "unpaid", "clients_by_location"]) {
      expect(ids).toContain(id);
    }
    expect(pages.find((p) => p.id === "home")?.kind).toBe("answer");
    expect(pages.find((p) => p.id === "summary")?.kind).toBe("tab");
    expect(pages.find((p) => p.id === "dashboard")?.kind).toBe("dashboard");
    // Every page carries a non-empty client-facing question.
    for (const p of pages) expect(p.question.length).toBeGreaterThan(0);
    // Ids unique.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns [] when the registry block is absent", () => {
    expect(parsePagesRegistry("<html>no registry</html>")).toEqual([]);
  });
});

describe("renderArtifactHtml", () => {
  it("the BRANDING placeholder exists exactly once in the artifact", () => {
    const html = readArtifactHtml();
    expect(html.split("const BRANDING = null;").length - 1).toBe(1);
  });

  it("injects branding JSON in place of the placeholder", () => {
    const out = renderArtifactHtml({
      name: "Test Brand",
      logo_data_uri: "data:image/png;base64,AAAA",
      primary_color: "#3aa39d",
    });
    expect(out).not.toContain("const BRANDING = null;");
    expect(out).toContain('"primary_color":"#3aa39d"');
    expect(out).toContain('"logo_data_uri":"data:image/png;base64,AAAA"');
  });

  it("escapes script-terminating sequences in injected values", () => {
    const out = renderArtifactHtml({
      name: "</script><script>alert(1)</script>",
      logo_data_uri: "data:image/png;base64,AAAA",
      primary_color: null,
    });
    // The injected JSON must not be able to close the inline <script> block.
    expect(out).not.toContain('"name":"</script>');
    expect(out).toContain("\\u003c/script");
  });

  it("serves the unbranded artifact when there is nothing to inject", () => {
    expect(renderArtifactHtml(null)).toContain("const BRANDING = null;");
    expect(
      renderArtifactHtml({ name: "X", logo_data_uri: null, primary_color: null }),
    ).toContain("const BRANDING = null;");
  });

  it("inlines the demo dataset — the served resource must be self-contained", () => {
    const out = renderArtifactHtml(null);
    expect(out).not.toContain('<script src="demo-embedded.js">');
    expect(out).toContain("const EMBEDDED");
  });
});

describe("runShowReport", () => {
  it("defaults to the home landing page", async () => {
    const r = await runShowReport({});
    expect(r.isError).toBeUndefined();
    const d = JSON.parse(text(r));
    expect(d.view).toBe("home");
    expect(d.data_mode).toBe("demo");
    expect(d.open.hash).toBe("#home");
    expect(d.artifact.resource).toBe("zooza://artifacts/business-dashboard");
  });

  it("builds a view+period hash", async () => {
    const r = await runShowReport({ view: "unpaid", from: "2026-01-01", to: "2026-03-01" });
    const d = JSON.parse(text(r));
    expect(d.open.hash).toBe("#unpaid&from=2026-01-01&to=2026-03-01");
    expect(d.period).toEqual({ from: "2026-01-01", to: "2026-03-01" });
    expect(d.kind).toBe("answer");
    // Browser URL is the primary delivery path (chat hosts can't fetch MCP
    // resources model-side); derived from the configured resource URL origin.
    if (d.open.url) expect(d.open.url).toMatch(/\/reports#unpaid&from=/);
  });

  it("teaches via the page catalog on unknown view", async () => {
    const r = await runShowReport({ view: "nonsense" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Unknown view "nonsense"');
    expect(text(r)).toContain("unpaid"); // catalog lists real pages
    expect(text(r)).toContain("Where is money outstanding?");
  });

  it("rejects non-month-start dates", async () => {
    const r = await runShowReport({ view: "unpaid", from: "2026-03-05", to: "2026-04-01" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("YYYY-MM-01");
    expect(text(r)).toContain('from="2026-03-05"');
  });

  it("rejects from after to", async () => {
    const r = await runShowReport({ view: "unpaid", from: "2026-05-01", to: "2026-01-01" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Swap them");
  });

  it("rejects a half-open period", async () => {
    const r = await runShowReport({ view: "unpaid", from: "2026-01-01" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("both from and to");
  });
});
