import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { RequestAuthContext } from "../auth/types.js";
import { ZoozaApiError } from "../zooza.js";
import {
  defaultRange,
  fetchBusinessDashboard,
  fetchDemandSupply,
  focusReplacements,
  focusReport,
  REPORT_VIEWS,
} from "../reports-data.js";

/**
 * reports_get_data — the REAL-numbers source for LLM-composed client reports
 * (spec ZMCP-20260612-003). Returns a focused, pre-aggregated data slice for one
 * question: server-computed headline figures + chart-ready rows + a data-aware
 * caption. The LLM composes presentation around these values and MUST NOT invent or
 * recompute numbers. No upstream HTML — pure JSON, so it works through the Cowork
 * window.cowork.callMcpTool bridge (live, refreshable, no token).
 */

export const getReportDataTitle = "Get real report data for a business question";

export const getReportDataDescription =
  `Return the REAL, pre-aggregated numbers for ONE business question about an activity brand — and the basis for SHOWING it. This is how you show an operator a report / dashboard / chart of their business numbers (occupancy, unpaid, churn, attendance, trials, retention, revenue, "how are we doing", per programme / venue / instructor): call this, then COMPOSE a focused report as an ARTIFACT in the conversation that renders in the side panel — do NOT hand the user a link or open a browser page. Views: ${REPORT_VIEWS.join(", ")}. Use view="replacements" for ANY question about make-up / replacement credits — "unused make-ups", "expiring make-ups", "credits", "náhrady / náhradné hodiny", "are we overloaded on make-ups", make-up demand vs available slots per programme (this IS the credits report; Zooza HAS make-up credits even though they are not in the business_dashboard views). The result has \`headline\` (computed key figures), \`rows\` (chart/table-ready, named, capped), \`note\` (a data-aware caption), \`currency\`, and \`period\`. RULES: every number you show the user MUST come from this result verbatim — never invent, estimate, or recompute figures, and never draw a chart without calling this first. Render charts with inline SVG/CSS — no external CDN or chart library (the artifact sandbox blocks them). If a view returns no rows, say so plainly. Follow get_skill("report-compose").`;

export const getReportDataInputSchema = {
  view: z
    .string()
    .optional()
    .describe(`Question to pull data for. One of: ${REPORT_VIEWS.join(", ")}. Default "summary".`),
  from: z.string().optional().describe('First month YYYY-MM-01. Both from+to or neither (default: last 6 months).'),
  to: z.string().optional().describe("Last month YYYY-MM-01."),
  company_id: z.number().int().optional().describe("Resolved from the session when omitted."),
};

const inputSchema = z.object(getReportDataInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function err(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const MONTH = /^\d{4}-\d{2}-01$/;

export async function runGetReportData(
  rawInput: unknown,
  ctx: RequestAuthContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const view = input.view ?? "summary";
  if (!REPORT_VIEWS.includes(view)) {
    return err(`Unknown view "${view}". Valid: ${REPORT_VIEWS.join(", ")}.`);
  }
  if ((input.from == null) !== (input.to == null)) {
    return err("Provide both from and to, or neither.");
  }
  if (input.from && input.to) {
    if (!MONTH.test(input.from) || !MONTH.test(input.to)) {
      return err('from/to must be first-of-month YYYY-MM-01 (e.g. "2026-03-01").');
    }
    if (input.from > input.to) return err(`from (${input.from}) is after to (${input.to}). Swap them.`);
  }
  const range = input.from && input.to ? { from: input.from, to: input.to } : defaultRange();
  const companyId = input.company_id as number; // guaranteed by resolveCompanyId wrapper
  const auth = withCompany(ctx.auth, companyId);

  try {
    if (view === "replacements") {
      const ds = await fetchDemandSupply(auth);
      const focused = focusReplacements(ds, range);
      return { content: [{ type: "text", text: JSON.stringify(focused, null, 2) }] };
    }
    const payload = await fetchBusinessDashboard(auth, range);
    const focused = focusReport(payload, view, range);
    return { content: [{ type: "text", text: JSON.stringify(focused, null, 2) }] };
  } catch (e) {
    const msg = e instanceof ZoozaApiError ? e.humanMessage : e instanceof Error ? e.message : String(e);
    return err(`Could not load report data from Zooza: ${msg}. Tell the user the data is temporarily unavailable — do NOT substitute made-up numbers.`);
  }
}
