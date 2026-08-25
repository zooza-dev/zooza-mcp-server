import { randomUUID } from "node:crypto";
import type { SectionName } from "./course-settings-model.js";

/**
 * In-memory store for course-settings plans produced by
 * classes_update_course_settings and consumed by
 * classes_update_course_settings (ZMCP-20260805-001). Module-level on
 * purpose: index.ts creates a fresh McpServer per HTTP request, so anything
 * request-scoped would lose the token between the prepare call and the
 * commit call.
 *
 * Single-instance only (fine for the current one-container deployment).
 * When the server goes multi-instance, swap the Map for Redis behind the
 * same three functions — same caveat as message-plan-store.ts.
 */

/** One row of the current → proposed diff shown to the user by prepare. */
export interface SettingsDiffEntry {
  field: string;
  /** Human label for the field (e.g. "Online booking" for online_registration). */
  label: string;
  current: unknown;
  proposed: unknown;
}

export interface CourseSettingsPlan {
  /** Frozen at prepare time — commit takes no company_id (comms precedent). */
  company_id: number;
  course_id: number;
  section: SectionName;
  /**
   * Exact PUT /v1/courses/{course_id} body: changed fields only, plus the
   * guard echoes (current feedback flags always; current
   * fees_included_in_price when price is present — see spec Approach).
   */
  put_body: Record<string, unknown>;
  diff: SettingsDiffEntry[];
  /** Warning texts already attached by prepare, echoed back by commit. */
  warnings: string[];
}

interface StoredPlan {
  plan: CourseSettingsPlan;
  expiresAt: number;
  used: boolean;
}

export const PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function savePlan(
  plan: CourseSettingsPlan,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `crs_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(PLAN_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: CourseSettingsPlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Validates a token WITHOUT consuming it. The commit tool marks the token used
 * only after the upstream PUT succeeds, so a transport failure leaves the
 * token valid for one retry (documented in the tool's error catalog).
 */
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
