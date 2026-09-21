import { randomUUID } from "node:crypto";

/**
 * In-memory store for edit plans produced by the *_prepare_update tools and
 * consumed by the *_commit_update tools (classes_update ZMCP-20260702-001 and
 * sessions_update ZMCP-20260702-002). Module-level on purpose: index.ts builds
 * a fresh McpServer per HTTP request, so a request-scoped store would lose the
 * token between the prepare call and the commit call.
 *
 * Mirrors message-plan-store.ts (comms prepare/commit). Single-instance only —
 * swap the Map for Redis behind these functions when the server goes multi-node.
 */

/** Edit plan for classes_update. `schedule_payloads` are the exact bodies
 *  to send: each carries `id` + the changed schedule fields + any canonical
 *  `update_mode_*` cascade keys (already resolved from session_scope). */
export interface ClassesUpdatePlan {
  kind: "classes";
  company_id: number;
  schedule_payloads: Array<Record<string, unknown> & { id: number }>;
  /** Human-readable echo re-shown on commit / re-surfaced by the skill. */
  summary: Record<string, unknown>;
}

/** Edit plan for sessions_update. `event_payloads` are the per-event
 *  bodies for the PUT /events batch: each carries `id` + changed fields (+ notify
 *  when requested). `date` values are already absolute `Y-m-d H:i:s`. */
export interface SessionsUpdatePlan {
  kind: "sessions";
  company_id: number;
  event_payloads: Array<Record<string, unknown> & { id: number }>;
  summary: Record<string, unknown>;
}

/** Add plan for sessions_update's ADD-MODE (ZMCP-20260827-004). `create_events`
 *  are the ready-to-send bodies for a single POST /events batch — each already
 *  carries schedule_id, course_id, trainer/place/room defaults resolved from the
 *  schedule, absolute `date_string` + `time_string` (minutes) + duration, and
 *  `billable: true`. Kept separate from SessionsUpdatePlan because commit POSTs
 *  (creates) rather than PUTs (edits). */
export interface SessionsAddPlan {
  kind: "sessions_add";
  company_id: number;
  schedule_id: number;
  create_events: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
}

/** Cancellation plan for sessions_cancel (ZMCP-20260921-001). `event_payloads` are
 *  the exact PUT /events rows: each carries `id`, `status: 'unplanned'`,
 *  `billable: false`, the reasons and — on a single-session cancel — the
 *  replacement fields. The resolved id list lives HERE and never in the apply
 *  call's args, so a token cannot be replayed against a wider scope.
 *  `verify_replacement` tells the apply phase to check `replaced_by` on the
 *  read-back, because api-v1 swallows a failed make-up creation. */
export interface SessionsCancelPlan {
  kind: "sessions_cancel";
  company_id: number;
  event_payloads: Array<Record<string, unknown> & { id: number }>;
  verify_replacement: boolean;
  summary: Record<string, unknown>;
}

/** Plan for trainers_add_helpers (ZMCP-20260908-001). A bulk fan-out with no
 *  upstream transaction, so the plan is stored per CLASS and applied in order:
 *  roster PUTs first, then the session PUTs, then the class-level DELETEs.
 *
 *  The roster-before-sessions order is load-bearing, not stylistic: api-v1's
 *  Event::add_trainer_to_event() copies `role` from trainers_schedules and
 *  inserts even when the row is missing, producing a role-NULL assignment.
 *  `update_mode` on a roster write is "all"/"upcoming" for an UNRESTRICTED
 *  assignment (api-v1 fans out to the events itself, so there are no
 *  event_writes for it) and "schedule" for a restricted one (roster only). */
export interface HelpersPlan {
  kind: "helpers";
  company_id: number;
  classes: Array<{
    schedule_id: number;
    name: string;
    roster_writes: Array<{
      trainer_id: number;
      role: string;
      update_mode: "all" | "upcoming" | "schedule";
    }>;
    event_writes: Array<{
      event_id: number;
      additional_trainers: Array<{ trainer_id: number; is_active: boolean }>;
    }>;
    roster_deletes: number[];
  }>;
  summary: Record<string, unknown>;
}

export type UpdatePlan =
  | ClassesUpdatePlan
  | SessionsUpdatePlan
  | SessionsAddPlan
  | SessionsCancelPlan
  | HelpersPlan;

interface StoredPlan {
  plan: UpdatePlan;
  expiresAt: number;
  used: boolean;
}

export const UPDATE_PLAN_TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredPlan>();

function prune(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function saveUpdatePlan(
  plan: UpdatePlan,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `upd_${plan.kind}_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + UPDATE_PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(UPDATE_PLAN_TTL_MS / 1000) };
}

export type UpdatePlanLookup =
  | { ok: true; plan: UpdatePlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/** Validates a token WITHOUT consuming it. The commit tool marks it used only
 *  after the upstream write succeeds, so a transport failure leaves the token
 *  valid for one retry. */
export function getUpdatePlan(token: string, now: number = Date.now()): UpdatePlanLookup {
  const entry = store.get(token);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= now) {
    store.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (entry.used) return { ok: false, reason: "used" };
  return { ok: true, plan: entry.plan };
}

export function markUpdatePlanUsed(token: string): void {
  const entry = store.get(token);
  if (entry) entry.used = true;
}

/** Test helper — never call from tool code. */
export function clearUpdatePlanStore(): void {
  store.clear();
}
