import { randomUUID } from "node:crypto";

/**
 * In-memory plan store for payments_send_invoice (ZMCP-20261009-003).
 *
 * Same 15-min / single-use contract as payment-plan-store.ts and its siblings —
 * mirrored deliberately so the eventual merge (ZMCP-20260824-001 scope note) stays
 * mechanical.
 */

export interface InvoicePlanItem {
  registration_id: number;
  /** Exact period the preview showed — sent as start/end so the invoice matches it. */
  period_start: string;
  period_end: string;
  invoice_amount: number;
}

export interface InvoicePlan {
  company_id: number;
  items: InvoicePlanItem[];
  send_to_client: boolean;
}

interface StoredPlan {
  plan: InvoicePlan;
  expiresAt: number;
  used: boolean;
}

export const INVOICE_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function savePlan(plan: InvoicePlan, now: number = Date.now()): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `inv_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + INVOICE_PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(INVOICE_PLAN_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: InvoicePlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

export function getPlan(token: string, now: number = Date.now()): PlanLookup {
  const entry = store.get(token);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= now) {
    store.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (entry.used) return { ok: false, reason: "used" };
  return { ok: true, plan: entry.plan };
}

export function markPlanUsed(token: string): void {
  const entry = store.get(token);
  if (entry) entry.used = true;
}

/** Test helper — never call from tool code. */
export function clearPlanStore(): void {
  store.clear();
}
