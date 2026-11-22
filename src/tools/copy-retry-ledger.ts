// Owner decision 2026-11-22: a class whose copy failed with a TEMPORARY error is
// re-previewed and applied once more without asking the operator again; they already
// approved exactly that copy. A second temporary failure goes back to the operator, so an
// agent never loops on the same error. Anything the operator could act on (capacity, a
// client already in the class, a programme mismatch) always goes back to them.
//
// "Temporary" is api-v1's call, not the model's: since 6c023963 (handoff
// zooza-mcp-to-api-v1-20261122-002) a step that fails on a database error carries
// `error.key: "internal_error"` and `error.data: { value: "db_error", db_error, retryable,
// attempts }`. `retryable: true` means a deadlock or lock wait api-v1's own retries could
// not clear, safe to retry unchanged. Nothing else is temporary: `insert_failed` used to be
// the deadlock's disguise (jobs 597 → 604), but now means a real problem (e.g. a session
// with no venue or instructor, class/Events.php:337).
//
// The ledger is in memory, like the plan store: a server restart forgets it, which at
// worst allows one extra retry.

export function isTemporaryStepError(key: string | null | undefined, data: unknown): boolean {
  if (key !== "internal_error" || !data || typeof data !== "object") return false;
  return (data as { retryable?: unknown }).retryable === true;
}

const TTL_MS = 60 * 60 * 1000;

/** `${company}:${source class}` → the job ids that failed it with a temporary error. */
const failures = new Map<string, { jobs: Set<number>; at: number }>();

/**
 * Records a temporary failure of `sourceId` in `jobId` and says whether a retry is still
 * allowed: true for the first job that failed this class, false once a second job has.
 * Idempotent per job, so reading the same job twice does not use up the retry.
 */
export function noteTemporaryFailure(companyId: string, sourceId: number, jobId: number, now = Date.now()): boolean {
  const key = `${companyId}:${sourceId}`;
  const entry = failures.get(key);
  if (!entry || now - entry.at > TTL_MS) {
    failures.set(key, { jobs: new Set([jobId]), at: now });
    return true;
  }
  entry.jobs.add(jobId);
  entry.at = now;
  return entry.jobs.size <= 1;
}

/** Test hook. */
export function resetRetryLedger(): void {
  failures.clear();
}
