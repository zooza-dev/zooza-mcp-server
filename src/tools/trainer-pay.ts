import type { EventPay, RawEventRecord, TrainerPay } from "./types.js";

/**
 * Trainer pay per session, read from api-v1 (spec ZMCP-20261029-001).
 *
 * api-v1 owns the pay rule (`api-v1/class/Trainer_Pay.php`, spec API-20261028-008) and
 * returns the calculated figure on `GET /events?filter=filter&load_pay=1` as a `pay`
 * sub-resource (`class/Zooza/Collection/Events.php:271-280`). The trainer report uses
 * the same code, so the figure equals the report's. We only map it — never re-derive it:
 * since API-20261028-008 a rate's `unit_amount` no longer explains the figure.
 *
 * Meaning of the raw values (`Trainer_Pay.php:for_request`, `:for_events`):
 * - `pay` key absent → `load_pay` was not honoured; `pay: null` → the session has no
 *   rate type, or the caller may not see financial data. Neither is ever shown as 0.
 * - `to_pay: 0` → the trainer has no rate for the session's rate type (the report pays 0).
 * - `to_pay: null` → hidden from this caller (a trainer caller sees only their own).
 * - payees are the session's current `trainer_id` and its own `trainers_events`; roster-only
 *   and substituted-away trainers have no entry.
 */

/** True when the API did not attach `pay` to some row — i.e. it ignored `load_pay`. */
export function payMissing(records: RawEventRecord[]): boolean {
  return records.some((r) => !("pay" in r));
}

/** Session-level pay, or null when the API returned none (or no key at all). */
export function projectEventPay(r: RawEventRecord): EventPay | null {
  const p = r.pay;
  if (!p) return null;
  return {
    rate_type_id: p.rate_type_id,
    rate_type: p.rate_type ?? null,
    payout_percentage: p.payout_percentage,
    minutes: p.minutes,
    main_trainer: p.main_trainer ? toTrainerPay(p.main_trainer.to_pay) : null,
  };
}

/** One additional trainer's pay on the session, matched by trainer_id. null when the
 *  session has no pay or the API listed no entry for this trainer. */
export function additionalTrainerPay(r: RawEventRecord, trainerId: number): TrainerPay | null {
  const entry = r.pay?.additional_trainers?.find((t) => t.trainer_id === trainerId);
  return entry ? toTrainerPay(entry.to_pay) : null;
}

function toTrainerPay(toPay: number | null | undefined): TrainerPay {
  return { amount: typeof toPay === "number" ? toPay : null };
}
