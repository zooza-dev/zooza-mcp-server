import { randomUUID } from "node:crypto";

/**
 * In-memory plan store for payments_add_plan (ZMCP-20260824-005).
 *
 * Fourth instance of the same 15-min / single-use contract — see
 * course-settings-plan-store.ts, message-plan-store.ts and update-plan-store.ts.
 * ZMCP-20260824-001 scope note already flags generalising these into one store;
 * this file deliberately mirrors them rather than inventing a fifth shape, so the
 * eventual merge is mechanical.
 */

export interface PaymentPlanApplication {
  company_id: number;
  registration_id: number;
  /** Group-level `payment_schedules` row id — NOT a payment template id. */
  payment_schedule_id: number;
  /** Booking TOTAL, sent upstream as `debt`. Undefined = let Zooza price it. */
  total_price?: number;
  start?: string;
  include_sessions_in_first_payment?: boolean;
  warnings: string[];
}

interface StoredPlan {
  plan: PaymentPlanApplication;
  expiresAt: number;
  used: boolean;
}

export const PAYMENT_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function savePlan(
  plan: PaymentPlanApplication,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `pay_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + PAYMENT_PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(PAYMENT_PLAN_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: PaymentPlanApplication }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/** Validates without consuming — the token is burned only after the write lands. */
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
