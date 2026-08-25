import { randomUUID } from "node:crypto";

/**
 * Plan store for setup_update_course_templates (ZMCP-20260824-006).
 * Same 15-min / single-use contract as the other four stores — see the note in
 * payment-plan-store.ts about generalising them.
 */

export interface CourseTemplatesChange {
  company_id: number;
  course_id: number;
  to_attach: number[];
  to_detach: number[];
  warnings: string[];
}

interface StoredPlan {
  plan: CourseTemplatesChange;
  expiresAt: number;
  used: boolean;
}

export const COURSE_TEMPLATES_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function savePlan(
  plan: CourseTemplatesChange,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `tpl_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + COURSE_TEMPLATES_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(COURSE_TEMPLATES_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: CourseTemplatesChange }
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
