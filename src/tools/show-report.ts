import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { RequestAuthContext } from "../auth/types.js";
import { config } from "../config.js";
import { mintReportToken } from "../reports-token.js";

/**
 * reports_show_report — spec ZMCP-20260612-002 (Phase 2 of ZMCP-20260612-001).
 *
 * Validates a requested report page against the artifact's PAGES registry and returns
 * a render directive (which artifact resource to open, what VIEW/hash to set). The
 * registry is parsed from artifacts/business-dashboard.html itself — single source of
 * truth, so a page added via the report-page-recipe becomes a valid `view` with zero
 * tool changes. No upstream api-v1 calls in the demo-data milestone.
 */

export const ARTIFACT_FILE = "artifacts/business-dashboard.html";
export const ARTIFACT_RESOURCE_URI = "zooza://artifacts/business-dashboard";

const ARTIFACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ARTIFACT_FILE,
);

export const showReportTitle = "Open the client reports app on a page";

export const showReportDescription =
  'INTERNAL / DEV ONLY — not the client deliverable. Returns a link that opens the full multi-tab dashboard EXAMPLE app in a browser (a reference/component library), scoped to a page + optional month range. Do NOT use this to answer an operator who wants to SEE their numbers: to show a report/dashboard/chart, call reports_get_data and COMPOSE a focused artifact in the conversation (side panel) — see get_skill("report-compose"). This tool exists only for inspecting the example dashboard and is normally not even registered (ZOOZA_ENABLE_REPORT_LINK). It never invents numbers, but a browser link is the wrong surface for clients.';

export const showReportInputSchema = {
  view: z
    .string()
    .optional()
    .describe(
      'Page id from the reports registry, e.g. "unpaid", "churn", "occupancy", "home", "dashboard". Default "home". Unknown ids return the full page catalog to pick from.',
    ),
  from: z
    .string()
    .optional()
    .describe('First month of the range as YYYY-MM-01 ("since March" → "2026-03-01"). Provide both from and to, or neither.'),
  to: z
    .string()
    .optional()
    .describe("Last month of the range as YYYY-MM-01. Provide both from and to, or neither."),
  company_id: z
    .number()
    .int()
    .optional()
    .describe("Accepted for forward-compatibility with live data mode; unused while the artifact renders demo data."),
};

const inputSchema = z.object(showReportInputSchema);

export interface ReportPage {
  id: string;
  kind: "dashboard" | "tab" | "answer";
  question: string;
}

let cachedPages: ReportPage[] | null = null;

/** Read the artifact HTML — exported so index.ts can serve it as an MCP resource. */
export function readArtifactHtml(): string {
  return readFileSync(ARTIFACT_PATH, "utf-8");
}

const BRANDING_PLACEHOLDER = "const BRANDING = null;";
const DEMO_SCRIPT_TAG = '<script src="demo-embedded.js"></script>';
const DEMO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "artifacts", "demo-embedded.js");

/**
 * Serve the artifact as ONE self-contained file:
 * 1. Inline the demo dataset — on disk the HTML references demo-embedded.js via a
 *    relative <script src>, which cannot resolve when the resource HTML renders
 *    standalone in the Cowork sandbox.
 * 2. Bake in the session company's branding (logo data URI + primary color from the
 *    whoami cache — see auth/branding.ts) by replacing the `const BRANDING = null;`
 *    placeholder; `</` is escaped so the JSON can never terminate the inline <script>.
 * Each step soft-falls-back to the file as-is.
 */
export function renderArtifactHtml(branding: {
  name: string | null;
  logo_data_uri: string | null;
  primary_color: string | null;
} | null): string {
  let html = readArtifactHtml();
  try {
    const demo = readFileSync(DEMO_PATH, "utf-8");
    html = html.replace(DEMO_SCRIPT_TAG, `<script>\n${demo}\n</script>`);
  } catch {
    // demo file missing — leave the src tag; live mode (?live=1) still works
  }
  if (!branding || (!branding.logo_data_uri && !branding.primary_color)) return html;
  const payload = JSON.stringify({
    name: branding.name,
    logo_data_uri: branding.logo_data_uri,
    primary_color: branding.primary_color,
  }).replace(/</g, "\\u003c");
  return html.replace(BRANDING_PLACEHOLDER, `const BRANDING = ${payload};`);
}

/**
 * Parse the PAGES registry out of the artifact's inline script. The recipe
 * (docs/report-page-recipe.md) fixes the descriptor shape, so a line regex is
 * reliable: { id:'unpaid', kind:'answer', question:'Where is money outstanding?', …
 */
export function parsePagesRegistry(html: string): ReportPage[] {
  const start = html.indexOf("const PAGES = [");
  const end = start >= 0 ? html.indexOf("];", start) : -1;
  if (start < 0 || end < 0) return [];
  const block = html.slice(start, end);
  const pages: ReportPage[] = [];
  const re =
    /\{\s*id:'([a-z0-9_]+)',\s*kind:'(dashboard|tab|answer)',(?:\s*tab:'[a-z0-9_]+',)?\s*question:'([^']*)'/g;
  for (const m of block.matchAll(re)) {
    pages.push({ id: m[1], kind: m[2] as ReportPage["kind"], question: m[3] });
  }
  return pages;
}

function loadPages(): ReportPage[] {
  if (cachedPages) return cachedPages;
  const pages = parsePagesRegistry(readArtifactHtml());
  if (pages.length === 0) {
    throw new Error("empty registry");
  }
  cachedPages = pages;
  return pages;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const MONTH_START = /^\d{4}-\d{2}-01$/;

export async function runShowReport(
  rawInput: unknown,
  ctx?: RequestAuthContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  let pages: ReportPage[];
  try {
    pages = loadPages();
  } catch {
    return errorResult(
      `registry_unavailable: the reports artifact (${ARTIFACT_FILE}) could not be read on this server, so pages cannot be validated. Tell the operator the artifact file is missing from the deployment.`,
    );
  }

  const view = input.view ?? "home";
  const page = pages.find((p) => p.id === view);
  if (!page) {
    const catalog = pages.map((p) => `${p.id} — "${p.question}"`).join(", ");
    return errorResult(
      `Unknown view "${view}". Valid pages: ${catalog}. Pick the page whose question matches the user's intent and call again with that id.`,
    );
  }

  const { from, to } = input;
  if ((from == null) !== (to == null)) {
    return errorResult(
      "Provide both from and to, or neither (the artifact then defaults to the latest month).",
    );
  }
  if (from != null && to != null) {
    const bad = [
      ["from", from],
      ["to", to],
    ].filter(([, v]) => !MONTH_START.test(v as string));
    if (bad.length) {
      return errorResult(
        `Invalid period: from/to must be the first of a month as YYYY-MM-01 (e.g. "2026-03-01"). Got ${bad
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ")}.`,
      );
    }
    if (from > to) {
      return errorResult(
        `Invalid period: from (${from}) is after to (${to}). Swap them.`,
      );
    }
  }

  const hash =
    `#${page.id}` + (from && to ? `&from=${from}&to=${to}` : "");

  // LIVE mode: mint a short-lived browser token bound to the caller's auth + company
  // (company_id is guaranteed by the resolveCompanyId wrapper in index.ts). The /reports
  // page uses it to pull real api-v1 data through GET /reports/data — credentials stay
  // server-side. Without a caller context (defensive), the link serves demo data.
  const companyId = (input.company_id as number | undefined) ?? null;
  let token: string | null = null;
  if (ctx && companyId) {
    token = mintReportToken(
      ctx.claims?.sub ?? "legacy",
      companyId,
      withCompany(ctx.auth, companyId),
    );
  }
  const dataMode = token ? "live" : "demo";
  const url = publicReportsUrl((token ? `?token=${token}` : "") + hash);
  const directive = {
    view: page.id,
    kind: page.kind,
    question: page.question,
    period: from && to ? { from, to } : null,
    data_mode: dataMode,
    open: {
      // Browser link first — chat hosts generally cannot fetch MCP resources
      // model-side, so the reliable path is the user clicking this.
      url,
      hash,
      how: url
        ? `Give the user this markdown link to open the report in their browser: [${page.question}](${url}). Do NOT try to fetch the URL or the resource yourself.${token ? " The link carries a 30-minute access token for the user's live company data; after it expires, call this tool again for a fresh link." : ""} Hosts that support rendering MCP resources can render \`artifact.resource\` instead (same page, plus session branding).`
        : `Render the artifact HTML from \`artifact.resource\` with the URL hash below, or ask the operator for the deployment's public /reports URL.`,
    },
    artifact: {
      resource: ARTIFACT_RESOURCE_URI,
      file: ARTIFACT_FILE,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(directive, null, 2) }],
  };
}

/** Public browser URL for the /reports route, derived from the configured resource URL
 *  (same origin logic as the connector icon). Empty string when unconfigured. */
function publicReportsUrl(hash: string): string {
  try {
    return new URL(config.auth.resourceUrl).origin + "/reports" + hash;
  } catch {
    return "";
  }
}
