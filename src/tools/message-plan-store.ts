import { randomUUID } from "node:crypto";

/**
 * In-memory store for message plans produced by comms_prepare_message and
 * consumed by comms_commit_message. Module-level on purpose: index.ts creates
 * a fresh McpServer per HTTP request, so anything request-scoped would lose
 * the token between the prepare call and the commit call.
 *
 * Single-instance only (fine for the current one-container deployment).
 * When the server goes multi-instance, swap the Map for Redis behind the
 * same three functions — see ZMCP-20260611-001 Notes.
 */

export interface MessagePlan {
  company_id: number;
  channel: "email";
  /** Query params frozen for both the count estimate and the message_jobs `params` object. */
  audience_params: Record<string, string | number>;
  /** Human-readable echo of the filters for the commit result. */
  audience_echo: Record<string, unknown>;
  subject: string;
  body: string;
  template_type?: string;
  marketing: boolean;
  guests: boolean;
  bcc?: string;
  schedule_at?: { date: string; hour: number; minute: number };
  recipient_count: number;
  /**
   * Set by comms_commit_message once the upstream job has been CREATED but came
   * back `pending_approval` (audience above the company's approval threshold).
   * Its presence means "the job exists; a second, explicit operator confirmation
   * is needed to release it" — the second commit call approves this job id
   * instead of creating a duplicate. Stays unset for under-threshold sends,
   * which complete in a single call.
   */
  created_job_id?: number;
}

interface StoredPlan {
  plan: MessagePlan;
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
  plan: MessagePlan,
  now: number = Date.now(),
): { token: string; expires_in_seconds: number } {
  prune(now);
  const token = `msg_p_${randomUUID()}`;
  store.set(token, { plan, expiresAt: now + PLAN_TTL_MS, used: false });
  return { token, expires_in_seconds: Math.floor(PLAN_TTL_MS / 1000) };
}

export type PlanLookup =
  | { ok: true; plan: MessagePlan }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Validates a token WITHOUT consuming it. The commit tool marks the token used
 * only after the upstream POST succeeds, so a transport failure leaves the
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

/**
 * Records the created (but not-yet-approved) job id on a plan whose audience
 * exceeded the company's approval threshold. The token is intentionally NOT
 * consumed here — it must survive to the second commit call that approves the
 * job after the operator's explicit second confirmation.
 */
export function recordPlanJob(token: string, jobId: number): void {
  const entry = store.get(token);
  if (entry) entry.plan.created_job_id = jobId;
}

/** Test helper — never call from tool code. */
export function clearPlanStore(): void {
  store.clear();
}
