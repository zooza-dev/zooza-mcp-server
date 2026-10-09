import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { getPlan, type InvoicePlanItem, markPlanUsed, savePlan } from "./invoice-plan-store.js";
import type { ApiListResponse } from "./types.js";

// payments_send_invoice — issue the invoice / payment confirmation for bookings and
// email it to the client (GitHub #22). The same action as "create invoice" on a
// registration's invoices tab in the Zooza app (app components/update_invoice).
//
// api-v1 contract (customer_invoices.php):
//  - GET  /customer_invoices/preview?order_type=course&order_id=R[&start&end]
//    → {period_start, period_end, debt, paid, …} (__preview, :413-469). With no
//    dates the period runs from the day after the last invoice's period_end (or the
//    booking's creation) to the latest payment (Customer_Invoices.php:722-862) — i.e.
//    "payments since the last invoice".
//  - POST /customer_invoices {order_id, order_type:"course", skip_queue, start, end,
//    notify_customer} (__create_invoice, :196-318). skip_queue generates the document
//    in the company's invoicing engine now and runs transfer_document_to_box(), whose
//    send_notifications() emails the company and — unless notify_customer is false —
//    the client, PDF attached (Customer_Invoices.php:2929-3055, 3557-3642).
//  - The invoice AMOUNT is what was CHARGED in the period (abs(debt) — Invoicing/Item.php
//    :189, :540); what was paid only decides whether it reads as settled. So the preview
//    shows both, and skips bookings with nothing charged or nothing paid in the period
//    (the engine would happily issue a 0 € invoice — seen on api-test, T2026-004).
//  - An invoice is an accounting document with a number from the engine's series; it
//    cannot be undone from here. Hence dual-phase, and a period that overlaps an earlier
//    invoice is flagged: the same charges would be invoiced twice.
//  - There is no "re-send an existing invoice" endpoint; this tool only issues new ones.

const MAX_REGISTRATIONS = 25;
const PREVIEW_CONCURRENCY = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const paymentsSendInvoiceTitle = "Issue an invoice (payment confirmation) for bookings and email it";

export const paymentsSendInvoiceDescription =
  "Issue the invoice / payment confirmation for one or more bookings (max 25) and email it to the client with " +
  "the PDF — the Zooza app's \"create invoice\" action. Each invoice covers what was charged since that booking's " +
  "last invoice, unless you pass period_start/period_end. Call it TWICE: first without a token → a preview per " +
  "booking (period, invoice amount, paid, earlier invoices, warnings, skipped); show it and get a yes; then call with the " +
  "token and confirmed:true. Invoices get a number in the company's invoicing system and cannot be undone here. " +
  "Bookings with nothing charged or paid in the period are skipped. Resolve registration_ids with bookings_find.";

export const paymentsSendInvoiceInputSchema = {
  company_id: companyIdSchema,
  registration_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_REGISTRATIONS)
    .optional()
    .describe(`Bookings to invoice (1-${MAX_REGISTRATIONS}). Preview call only.`),
  period_start: z
    .string()
    .regex(DATE, "period_start must be YYYY-MM-DD")
    .optional()
    .describe("Invoice charges from this date (YYYY-MM-DD). Default: day after the last invoice."),
  period_end: z
    .string()
    .regex(DATE, "period_end must be YYYY-MM-DD")
    .optional()
    .describe("…up to this date (YYYY-MM-DD). Default: the latest payment."),
  send_to_client: z
    .boolean()
    .optional()
    .describe("Default true — email the invoice PDF to the client. false = issue only."),
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
};

const previewSchema = z.object({
  company_id: z.number().int().positive().optional(),
  registration_ids: z.array(z.number().int().positive()).min(1).max(MAX_REGISTRATIONS),
  period_start: z.string().regex(DATE).optional(),
  period_end: z.string().regex(DATE).optional(),
  send_to_client: z.boolean().optional(),
});

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

interface RawPreview {
  period_start?: string;
  period_end?: string;
  debt?: number | string;
  paid?: number | string;
}

interface RawInvoice {
  id?: number;
  invoice_no?: string | null;
  period_start?: string;
  period_end?: string;
  total_gross?: number | string | null;
  currency?: string;
  created?: string;
  engine_return_code?: string | null;
  engine_error_code?: string | null;
}

export async function runPaymentsSendInvoice(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "apply") return applyPlan(decision.token, auth);
  return previewPlan(rawInput, auth);
}

async function previewPlan(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = previewSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}. ` +
        "registration_ids is required on the preview call.",
    );
  }
  const input = parsed.data;
  if (input.period_start && input.period_end && input.period_start > input.period_end) {
    return errorResult("period_start is after period_end.");
  }
  const callAuth = withCompany(auth, input.company_id!);
  const ids = [...new Set(input.registration_ids)];

  const rows = await mapLimit(ids, PREVIEW_CONCURRENCY, (id) => previewOne(id, input, callAuth));

  const ready = rows.filter((r): r is ReadyRow => r.status === "ready");
  const skipped = rows.filter((r) => r.status !== "ready");
  if (ready.length === 0) {
    return errorResult(
      `Nothing to invoice: ${skipped.map((s) => `${s.registration_id} (${s.reason})`).join("; ")}.`,
    );
  }

  const sendToClient = input.send_to_client ?? true;
  const { token, expires_in_seconds } = savePlan({
    company_id: input.company_id!,
    send_to_client: sendToClient,
    items: ready.map((r) => ({
      registration_id: r.registration_id,
      period_start: r.period_start,
      period_end: r.period_end,
      invoice_amount: r.invoice_amount,
    })),
  });

  const result = {
    token,
    expires_in_seconds,
    send_to_client: sendToClient,
    to_invoice: ready.map(({ status: _s, ...r }) => r),
    total_invoiced: round2(ready.reduce((n, r) => n + r.invoice_amount, 0)),
    skipped: skipped.map(({ registration_id, reason }) => ({ registration_id, reason })),
    next_step:
      `Show the operator each booking's period, invoice_amount, paid/outstanding, any warnings (an overlap means ` +
      `double invoicing), and the skipped list. ` +
      `${ready.length} invoice(s) will be issued in the company's invoicing system` +
      (sendToClient ? " and emailed to the clients" : " (not emailed)") +
      ". After they confirm, call payments_send_invoice again with `token` and `confirmed: true` only.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

interface ReadyRow {
  status: "ready";
  registration_id: number;
  period_start: string;
  period_end: string;
  /** What the invoice will bill — charged in the period. */
  invoice_amount: number;
  paid: number;
  outstanding: number;
  earlier_invoices: Array<{ invoice_no: string | null; period: string; total: number | null; created: string }>;
  warnings?: string[];
}

type PreviewRow = ReadyRow | { status: "skipped"; registration_id: number; reason: string };

async function previewOne(
  id: number,
  input: z.infer<typeof previewSchema>,
  auth: ZoozaAuth,
): Promise<PreviewRow> {
  const query: Record<string, string | number> = { order_type: "course", order_id: id };
  if (input.period_start) query.start = input.period_start;
  if (input.period_end) query.end = input.period_end;
  try {
    const [preview, invoicesRaw] = await Promise.all([
      zoozaFetch<RawPreview>("/customer_invoices/preview", { query }, auth),
      zoozaFetch<ApiListResponse<RawInvoice> | RawInvoice[]>(
        "/customer_invoices",
        { query: { order_type: "course", order_id: id, page_size: 50 } },
        auth,
      ),
    ]);
    const invoices = unwrapList<RawInvoice>(invoicesRaw).records;
    const periodStart = pickStr(preview?.period_start);
    const periodEnd = pickStr(preview?.period_end);
    const paid = toNum(preview?.paid);
    const charged = Math.abs(toNum(preview?.debt));
    if (!periodStart || !periodEnd) {
      return { status: "skipped", registration_id: id, reason: "Zooza returned no invoice period" };
    }
    const span = `${day(periodStart)} – ${day(periodEnd)}`;
    const hint = invoices.length ? " — already invoiced? pass period_start/period_end to choose the period" : "";
    if (charged <= 0) {
      return { status: "skipped", registration_id: id, reason: `nothing charged in ${span}${hint}` };
    }
    if (paid <= 0) {
      return { status: "skipped", registration_id: id, reason: `no payment in ${span}${hint}` };
    }
    const warnings: string[] = [];
    for (const i of invoices) {
      const no = pickStr(i.invoice_no ?? undefined);
      if (!no || !i.period_start || !i.period_end) continue;
      if (day(i.period_start) <= day(periodEnd) && day(i.period_end) >= day(periodStart)) {
        warnings.push(`Period overlaps invoice ${no} (${day(i.period_start)} – ${day(i.period_end)}) — those charges would be invoiced twice.`);
      }
    }
    // create_invoice REUSES an invoice row that the engine never processed
    // (empty_invoice_exists, Customer_Invoices.php:690-720) instead of making a new one.
    const pending = invoices.find((i) => !pickStr(i.engine_return_code ?? undefined) && !pickStr(i.engine_error_code ?? undefined));
    // get_billing_cycle_start() starts the default period after the LAST invoice row,
    // failed ones included (Customer_Invoices.php:722-760) — so a failed attempt moves
    // the default past charges that were never invoiced.
    const latest = invoices[0];
    if (!input.period_start && latest && pickStr(latest.engine_error_code ?? undefined)) {
      warnings.push(
        `The last invoice attempt failed (${latest.engine_error_code}); the default period starts after it. Pass ` +
          `period_start to cover its period (${day(latest.period_start)} – ${day(latest.period_end)}).`,
      );
    }
    if (pending) {
      warnings.push(`An unfinished invoice (id ${pending.id}) exists; Zooza will complete that one instead of creating a new one.`);
    }
    return {
      status: "ready",
      registration_id: id,
      period_start: periodStart,
      period_end: periodEnd,
      invoice_amount: charged,
      paid,
      outstanding: round2(Math.max(0, charged - paid)),
      earlier_invoices: invoices.map((i) => ({
        invoice_no: pickStr(i.invoice_no ?? undefined) ?? null,
        period: `${day(i.period_start)} – ${day(i.period_end)}`,
        total: i.total_gross === null || i.total_gross === undefined ? null : toNum(i.total_gross),
        created: pickStr(i.created) ?? "",
      })),
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return { status: "skipped", registration_id: id, reason: `api-v1 ${error.status}: ${error.humanMessage}` };
    }
    return { status: "skipped", registration_id: id, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function applyPlan(token: string, auth: ZoozaAuth): Promise<ToolResult> {
  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This invoice preview is ${lookup.reason}. Run payments_send_invoice again without a token to rebuild it.`,
    );
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);
  // Burn the token BEFORE writing: invoices are not idempotent, so a retry of a
  // half-finished batch must go through a fresh preview, which then shows the new
  // invoices and skips what was already invoiced.
  markPlanUsed(token);

  const issued: Array<Record<string, unknown>> = [];
  const failed: Array<{ registration_id: number; error: string }> = [];
  // Sequential on purpose — one engine series, numbers handed out in order.
  for (const item of plan.items) {
    try {
      const inv = await zoozaFetch<RawInvoice>(
        "/customer_invoices",
        { method: "POST", body: invoiceBody(item, plan.send_to_client) },
        callAuth,
      );
      issued.push({
        registration_id: item.registration_id,
        invoice_id: inv?.id ?? null,
        invoice_no: pickStr(inv?.invoice_no ?? undefined) ?? pickStr(inv?.engine_return_code ?? undefined) ?? null,
        total: inv?.total_gross === null || inv?.total_gross === undefined ? null : toNum(inv.total_gross),
        currency: pickStr(inv?.currency) ?? null,
      });
    } catch (error) {
      failed.push({ registration_id: item.registration_id, error: invoiceError(error) });
    }
  }

  const result = {
    issued,
    failed,
    emailed_to_clients: plan.send_to_client && issued.length > 0,
    ...(failed.length
      ? {
          next_step:
            "Some invoices failed. Before retrying, run a fresh preview for those bookings — an invoice may have " +
            "been created despite the error, and the preview will show it.",
        }
      : {}),
  };
  return { ...(issued.length === 0 ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** api-v1 reports an engine failure twice: error_log_raw carries only the engine name
 *  ("xero"), errors[] the engine's own message ("XERO-Forbidden") — customer_invoices.php
 *  :291-304. ZoozaApiError.humanMessage prefers the former, so add the latter here.
 *  Seen live on api-test 2026-10-09. */
export function invoiceError(error: unknown): string {
  if (!(error instanceof ZoozaApiError)) return error instanceof Error ? error.message : String(error);
  const details: string[] = [];
  try {
    const body = JSON.parse(error.responseText) as { errors?: unknown[] };
    for (const entry of body.errors ?? []) {
      const values = typeof entry === "string" ? [entry] : entry && typeof entry === "object" ? Object.values(entry) : [];
      for (const v of values) {
        if (typeof v === "string" && v && v !== error.humanMessage && !details.includes(v)) details.push(v);
      }
    }
  } catch {
    // not JSON — humanMessage already carries the raw text
  }
  return `api-v1 ${error.status}: ${[error.humanMessage, ...details].join(" — ")}`;
}

/** POST body for one invoice — mirrors the app's create call (update_invoice.js). */
export function invoiceBody(item: InvoicePlanItem, sendToClient: boolean): Record<string, unknown> {
  return {
    order_id: item.registration_id,
    order_type: "course",
    skip_queue: true,
    start: item.period_start,
    end: item.period_end,
    notify_customer: sendToClient,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function day(v: string | undefined): string {
  return (v ?? "").slice(0, 10);
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
