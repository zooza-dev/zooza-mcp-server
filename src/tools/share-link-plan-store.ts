import { randomUUID } from "node:crypto";

/**
 * In-memory plan store for classes_add_share_link (ZMCP-20261009-005).
 *
 * Same 15-min / single-use contract as invoice-plan-store.ts and its siblings —
 * mirrored deliberately so the eventual merge (ZMCP-20260824-001 scope note) stays
 * mechanical.
 */

export interface ShareLinkPlan {
  company_id: number;
  schedule_id: number;
  application_id: number;
  /** YYYY-MM-DD, or null = never expires. */
  expires: string | null;
}

interface StoredPlan {
  plan: ShareLinkPlan;
  expiresAt: number;
  used: boolean;
}

export const SHARE_LINK_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function savePlan(plan: ShareLinkPlan, now: number = Date.now()): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `shl_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + SHARE_LINK_PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(SHARE_LINK_PLAN_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: ShareLinkPlan }
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
