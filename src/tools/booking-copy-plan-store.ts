import { randomUUID } from "node:crypto";

/**
 * In-memory store for the copy/move plans produced by `bookings_copy_booking`'s
 * preview phase and consumed by its apply phase (spec ZMCP-20260901-001).
 *
 * Module-level on purpose, mirroring update-plan-store.ts: index.ts builds a
 * fresh McpServer per HTTP request, so a request-scoped store would lose the
 * token between the two calls. Single-instance only — swap the Map for Redis
 * behind these functions when the server goes multi-node.
 *
 * Why a separate store rather than a `kind` on UpdatePlan: the plan here is not
 * an edit diff, it is a frozen upstream request body plus the money summary the
 * operator approved. Sharing the update store would mean a token minted by one
 * tool could be looked up by another, and the `kind` guard is the only thing
 * standing in the way. The repo already keeps one store per domain (message,
 * payment, course-settings, course-templates, update) — this follows that.
 */

export interface BookingCopyPlan {
  company_id: number;
  /** Which api-v1 action this applies: `copy` creates a booking, `move` relocates one. */
  action: "copy" | "move";
  /**
   * The EXACT body to POST to /registrations, frozen at preview time. Nothing is
   * recomputed on apply — what the operator approved is what gets sent.
   */
  body: Record<string, unknown>;
  /** The source booking id, so a `move` can echo back the unchanged id. */
  registration_id: number;
  /** Human-readable echo re-shown on apply / re-surfaced by the skill. */
  summary: Record<string, unknown>;
}

interface StoredPlan {
  plan: BookingCopyPlan;
  expiresAt: number;
  used: boolean;
}

export const BOOKING_COPY_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function saveBookingCopyPlan(
  plan: BookingCopyPlan,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `cpy_${plan.action}_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + BOOKING_COPY_PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(BOOKING_COPY_PLAN_TTL_MS / 1000) };
}

export type BookingCopyPlanLookup =
  | { ok: true; plan: BookingCopyPlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Validates a token WITHOUT consuming it. The apply phase decides when to burn
 * it: on success, and also on a 5xx/transport failure — the write may have gone
 * through and `copy` is not idempotent, so a blind retry must be impossible. Only
 * a 4xx (api-v1 refused before writing) leaves the token valid.
 */
export function getBookingCopyPlan(
  token: string,
  now: number = Date.now(),
): BookingCopyPlanLookup {
  const entry = store.get(token);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= now) {
    store.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (entry.used) return { ok: false, reason: "used" };
  return { ok: true, plan: entry.plan };
}

export function markBookingCopyPlanUsed(token: string): void {
  const entry = store.get(token);
  if (entry) entry.used = true;
}

/** Test helper — never call from tool code. */
export function clearBookingCopyPlanStore(): void {
  store.clear();
}
