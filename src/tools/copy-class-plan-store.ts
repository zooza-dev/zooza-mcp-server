import { randomUUID } from "node:crypto";

/**
 * In-memory store for the batch bodies produced by `classes_copy_class`'s preview
 * phase and consumed by its apply phase (spec ZMCP-20261122-001).
 *
 * Module-level on purpose, mirroring booking-copy-plan-store.ts: index.ts builds a
 * fresh McpServer per HTTP request, so a request-scoped store would lose the token
 * between the two calls. Single-instance only — swap the Map for Redis behind these
 * functions when the server goes multi-node.
 *
 * Its own store, not a `kind` on another one, so a token minted by one tool can never
 * be looked up by another.
 */

export interface ClassCopyPlan {
  company_id: number;
  /**
   * The EXACT body api-v1's preflight_check previewed, price already mapped. Apply
   * POSTs it unchanged to `POST schedules/copy` — nothing is recomputed.
   */
  body: Record<string, unknown>;
  /** The target billing period, for the apply's "check progress" text. */
  target: { id: number; name: string };
}

interface StoredPlan {
  plan: ClassCopyPlan;
  expiresAt: number;
  used: boolean;
}

export const CLASS_COPY_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function saveClassCopyPlan(
  plan: ClassCopyPlan,
  now: number = Date.now(),
): { token: string; expires_at: string } {
  prune(now);
  const token = `ccp_${randomUUID()}`;
  const expiresAt = now + CLASS_COPY_PLAN_TTL_MS;
  store.set(token, { plan, expiresAt, used: false });
  return { token, expires_at: new Date(expiresAt).toISOString() };
}

export type ClassCopyPlanLookup =
  | { ok: true; plan: ClassCopyPlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Validates a token WITHOUT consuming it. The apply decides when to burn it: on
 * success, and on a 5xx/transport failure — the job may exist, so a blind repeat must
 * be impossible. Only a 4xx (api-v1 refused before writing) leaves it valid.
 */
export function getClassCopyPlan(token: string, now: number = Date.now()): ClassCopyPlanLookup {
  const entry = store.get(token);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= now) {
    store.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (entry.used) return { ok: false, reason: "used" };
  return { ok: true, plan: entry.plan };
}

export function markClassCopyPlanUsed(token: string): void {
  const entry = store.get(token);
  if (entry) entry.used = true;
}

/** Test helper — never call from tool code. */
export function clearClassCopyPlanStore(): void {
  store.clear();
}
