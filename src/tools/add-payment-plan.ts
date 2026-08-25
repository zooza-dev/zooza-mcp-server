import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { getPlan, markPlanUsed, savePlan } from "./payment-plan-store.js";

/**
 * Apply a payment plan to one booking (spec ZMCP-20260824-005).
 *
 * A template is NOT inherited by a booking. It is copied onto the class as a
 * `payment_schedules` row, and that row must then be applied to the registration.
 * Skipping this step is why registration 52815 sat at payment_schedule_id = 0 with a
 * perfectly good plan on its class and EUR 0 owed.
 */

export const addPaymentPlanTitle = "Apply a payment plan to a booking";

export const addPaymentPlanDescription =
  "Put a booking on a payment plan — the instalment calendar the client actually pays against. A plan attached to " +
  "a programme or class is NOT inherited by bookings; each booking has to have it applied, and until then the " +
  "client owes nothing and sees no payment schedule.\n\n" +
  "TWO CALLS. First WITHOUT `token`: writes nothing and returns the TOTAL plus the instalment dates and how many " +
  "sessions each one covers. Zooza's preview does not expose per-instalment amounts before the plan exists — " +
  "divide the total by the instalment count when telling the user, and say it is the expected split. Show that to " +
  "the operator, then call again with `token` + `confirmed: true` to apply.\n\n" +
  "`total_price` is the WHOLE amount for this booking, not a per-session price. Say \"EUR 200 for the term split " +
  "into 4\" and pass total_price: 200 — Zooza does the division. Omit it to let Zooza price the booking from the " +
  "class instead. (This is the opposite of `unit_price` on classes_add_course, which IS per session.)\n\n" +
  "You do not need a plan id: the tool lists the plans available on the booking's own class and picks the only " +
  "one automatically. WARNING — if the booking already has a plan, applying another REPLACES it and rebuilds the " +
  "ledger; the preview says so.";

export const addPaymentPlanInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  registration_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required on the FIRST call. The booking, from bookings_find (`registration_id`)."),
  payment_schedule_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Usually omit. The id of a plan ON THE BOOKING'S CLASS — NOT a payment template id. Leave it out and the " +
        "tool lists what the class offers and auto-selects a single one; only pass it when several exist and the " +
        "user picked one.",
    ),
  total_price: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "The TOTAL for this booking — the whole sum the client pays, which Zooza splits across the instalments. " +
        "Not a per-session price. Omit to let Zooza calculate it from the class.",
    ),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD. Anchors the instalment dates. Omit to use the class start."),
  include_sessions_in_first_payment: z
    .boolean()
    .optional()
    .describe("Rolls sessions already elapsed into the first instalment instead of billing them separately."),
};

const previewInput = z.object({
  company_id: z.number().int().positive().optional(),
  registration_id: z.number().int().positive(),
  payment_schedule_id: z.number().int().positive().optional(),
  total_price: z.number().nonnegative().optional(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  include_sessions_in_first_payment: z.boolean().optional(),
});

interface RegistrationRecord {
  id: number;
  schedule_id?: number;
  course_id?: number;
  payment_schedule_id?: number | string;
  payments_managed_by?: number | string;
  [k: string]: unknown;
}

interface GroupPlan {
  id: number;
  schedule_type?: string;
  frequency?: string;
  value?: number | string;
  active?: boolean | number;
  payment_schedule_template?: { name?: string } | null;
}

interface Instalment {
  scheduled_at?: string;
  date?: string;
  amount?: number | string;
  value?: number | string;
}

export async function runAddPaymentPlan(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "apply") return applyPlan(decision.token, auth);
  return previewPlan(rawInput, auth);
}

async function previewPlan(rawInput: unknown, auth: ZoozaAuth) {
  const parsed = previewInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);
  const warnings: string[] = [];

  let reg: RegistrationRecord;
  try {
    reg = await getOne<RegistrationRecord>(`/registrations/${input.registration_id}`, callAuth);
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status === 404) {
      return errorResult(
        `Booking ${input.registration_id} not found for this company. Resolve it with bookings_find first.`,
      );
    }
    return errorResult(upstreamMessage(error, "load the booking"));
  }

  // Refused upstream anyway (Registration.php:4905-4909) — catch it here so the user
  // learns the reason instead of a generic apply failure.
  if (toInt(reg.payments_managed_by) > 0) {
    return errorResult(
      "This booking's payments are managed by another account, so Zooza refuses to rebuild its ledger. Applying a " +
        "plan has to happen on the managing booking instead.",
    );
  }

  const scheduleId = toInt(reg.schedule_id);
  if (!scheduleId) {
    return errorResult(
      `Booking ${input.registration_id} is not attached to a class, so there is no plan to apply. Check it with bookings_find.`,
    );
  }

  const existing = toInt(reg.payment_schedule_id);
  if (existing > 0) {
    warnings.push(
      `This booking is ALREADY on payment plan ${existing}. Applying another REPLACES it and rebuilds the ` +
        "booking's ledger — previously scheduled instalments are cleared. Only continue if the operator asked to " +
        "change the plan.",
    );
  }

  let plans: GroupPlan[];
  try {
    plans = await getList<GroupPlan>(`/schedules/${scheduleId}/payment_schedules`, callAuth);
  } catch (error) {
    return errorResult(upstreamMessage(error, "list the plans on this booking's class"));
  }
  const active = plans.filter((p) => p.active !== false && p.active !== 0);
  if (active.length === 0) {
    return errorResult(
      `The class behind booking ${input.registration_id} has no payment plan to apply. Create one with ` +
        "setup_add_payment_template (pass that class's course_id to attach it), then run this again.",
    );
  }

  let chosen: GroupPlan;
  if (input.payment_schedule_id !== undefined) {
    const match = active.find((p) => p.id === input.payment_schedule_id);
    if (!match) {
      return errorResult(
        `Plan ${input.payment_schedule_id} is not one of this class's plans. Available: ` +
          `${active.map((p) => `${p.id} (${planLabel(p)})`).join("; ")}. Note this is a plan id on the CLASS, not a payment template id.`,
      );
    }
    chosen = match;
  } else if (active.length === 1) {
    chosen = active[0];
  } else {
    return errorResult(
      `This class offers ${active.length} payment plans — ask the operator which one, then pass its ` +
        `payment_schedule_id: ${active.map((p) => `${p.id} (${planLabel(p)})`).join("; ")}.`,
    );
  }

  // Upstream preview: the real instalment calendar, computed the same way the apply
  // call will compute it. `debt` is a TOTAL here (Payment_Schedule.php:2734-2755).
  let preview: Record<string, unknown>;
  try {
    const query: Record<string, string | number | undefined> = {};
    if (input.total_price !== undefined) query.debt = input.total_price;
    if (input.start !== undefined) query.start = input.start;
    const raw = await getOne<Record<string, unknown>>(
      `/schedules/${scheduleId}/payment_schedules/${chosen.id}`,
      callAuth,
      query,
    );
    preview = (raw.payments_preview as Record<string, unknown>) ?? {};
  } catch (error) {
    return errorResult(upstreamMessage(error, "preview the instalments"));
  }

  const instalments = (preview.installments as Instalment[] | undefined) ?? [];
  const total = toNum(preview.net_price ?? preview.base_price);
  const priceSettings = (preview.price_settings as Record<string, unknown> | undefined) ?? {};

  if (instalments.length === 0 || total === 0) {
    // Almost always the non-billable-sessions defect: api-v1 filters to billable = 1
    // only when billable_events > 0, so a class with billable_events set and no
    // billable sessions prices at exactly zero (fixed for new classes in 0.5.1).
    warnings.push(
      `This plan currently produces ${instalments.length} instalment(s) totalling ${total}. That usually means the ` +
        `class has no BILLABLE sessions (billable units seen: ${toNum(priceSettings.total_units)}) while its ` +
        "billable_events is set — Zooza then prices the class at zero. Fix the class's sessions or its " +
        "billable_events before applying, or pass total_price to set the amount for this booking directly.",
    );
  }

  const { token, expires_in_seconds } = savePlan({
    company_id: input.company_id!,
    registration_id: input.registration_id,
    payment_schedule_id: chosen.id,
    total_price: input.total_price,
    start: input.start,
    include_sessions_in_first_payment: input.include_sessions_in_first_payment,
    warnings,
  });

  const result = {
    token,
    expires_in_seconds,
    booking: { registration_id: input.registration_id, schedule_id: scheduleId, current_plan_id: existing || null },
    plan: { id: chosen.id, label: planLabel(chosen) },
    total,
    instalment_count: instalments.length,
    // api-v1's schedule-level preview returns each instalment's date and session
    // count but leaves `value` at 0 — the per-instalment amounts only materialise
    // once the plan is attached to the booking. Verified 2026-08-24 with and without
    // both `debt` and `order_id`. Reporting that 0 as an amount would be a lie, so
    // the split is derived and labelled as expected.
    expected_per_instalment:
      instalments.length > 0 ? Math.round((total / instalments.length) * 100) / 100 : 0,
    instalments: instalments.map((i, n) => ({
      n: n + 1,
      date: i.scheduled_at ?? i.date ?? null,
      sessions_covered: toNum((i as { events?: number | string }).events),
    })),
    warnings,
    next_step:
      "Show the total and these instalment dates to the operator, using expected_per_instalment as the amount each. " +
      "After they confirm, call payments_add_plan again with `token` and `confirmed: true` — and nothing else. To " +
      "change the amount or start date, call again WITHOUT a token.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

async function applyPlan(token: string, auth: ZoozaAuth) {
  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This payment plan preview is ${lookup.reason}. Run payments_add_plan again without a token to rebuild it.`,
    );
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);

  const body: Record<string, unknown> = { payment_schedule_id: plan.payment_schedule_id };
  if (plan.total_price !== undefined) body.debt = plan.total_price;
  if (plan.start !== undefined) body.start = plan.start;
  if (plan.include_sessions_in_first_payment !== undefined) {
    body.include_sessions_in_first_payment = plan.include_sessions_in_first_payment;
  }
  // registration_fee is deliberately never sent — api-v1 would post a separate
  // registration-fee charge as a side effect of applying a plan.

  try {
    await zoozaFetch<unknown>(
      `/registrations/${plan.registration_id}/payment_schedules`,
      { method: "POST", body },
      callAuth,
    );
  } catch (error) {
    // Token survives: nothing was written, so one retry is safe.
    return errorResult(upstreamMessage(error, "apply the payment plan"));
  }

  // api-v1 returns an empty body on success, so confirm the plan actually landed
  // rather than trusting the 200.
  let applied: number | null = null;
  try {
    const reg = await getOne<RegistrationRecord>(`/registrations/${plan.registration_id}`, callAuth);
    applied = toInt(reg.payment_schedule_id) || null;
  } catch {
    // Verification is best-effort; the write already succeeded.
  }

  markPlanUsed(token);

  const result = {
    applied: true,
    registration_id: plan.registration_id,
    payment_schedule_id: plan.payment_schedule_id,
    confirmed_on_booking: applied,
    warnings:
      applied === null
        ? [...plan.warnings, "Applied, but the booking could not be re-read to confirm — check it with bookings_find."]
        : applied !== plan.payment_schedule_id
          ? [...plan.warnings, `Applied, but the booking now reports plan ${applied}. Verify in the Zooza app.`]
          : plan.warnings,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function planLabel(p: GroupPlan): string {
  const name = p.payment_schedule_template?.name;
  const shape = `${p.schedule_type ?? "?"}/${p.frequency ?? "?"}${p.value ? ` x${p.value}` : ""}`;
  return name ? `${name} — ${shape}` : shape;
}

async function getOne<T>(
  path: string,
  auth: ZoozaAuth,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const raw = await zoozaFetch<{ data?: T } | T>(path, query ? { query } : {}, auth);
  return ((raw as { data?: T })?.data ?? raw) as T;
}

async function getList<T>(path: string, auth: ZoozaAuth): Promise<T[]> {
  const raw = await zoozaFetch<{ data?: T[] } | T[]>(path, {}, auth);
  const d = (raw as { data?: T[] })?.data ?? raw;
  return Array.isArray(d) ? d : [];
}

function upstreamMessage(error: unknown, what: string): string {
  if (error instanceof ZoozaApiError) {
    if (error.status === 403) {
      return `api-v1 rejected the request: this account is not allowed to ${what}.`;
    }
    if (error.status >= 500) {
      return `Zooza API error (${error.status}) — could not ${what}. Nothing was changed; retry once.`;
    }
    return `Could not ${what} (api-v1 ${error.status}: ${error.humanMessage}).`;
  }
  return error instanceof Error ? error.message : String(error);
}

function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
