import type { ZoozaAuth } from "../auth/types.js";
import { zoozaFetch } from "../zooza.js";
import { unwrapList } from "./common.js";
import type {
  ApiListResponse,
  EventPay,
  RawEventRecord,
  RawTrainerRateRecord,
  RawTrainerRateTypeRecord,
  TrainerPay,
} from "./types.js";

/**
 * Trainer pay per session, mirroring api-v1's trainer report (spec ZMCP-20261009-011).
 *
 * api-v1 stores NO pay on the session or on the helper link (`Event_Trainer.php:26`,
 * `Schedule_Trainer.php:26` have no rate column). The report derives it at read time
 * (`api-v1/class/Report_Trainer.php:101-106` main trainer, `:186-191` additional):
 *
 *   to_pay = trainer_rates.unit_amount × event.trainer_payout_percentage
 *            × (rate type 'fixed' ? 1 : minutes)
 *   minutes = event.duration > 0 ? event.duration : schedule.duration
 *
 * - the rate TYPE comes from the SESSION (`event.trainer_rate_type_id`); the AMOUNT is
 *   that trainer's own row in `trainer_rates` for that type (join `:150`, `:234-235`).
 *   No row → the report pays 0.
 * - `trainer_payout_percentage` is a 0..1 FRACTION, not 0..100 — api-v1 clamps it to
 *   [0, 1] on write (`events.php:2073-2085`) and zeroes it when a session is cancelled
 *   (`events.php:1652-1654`, `class/Event.php:661`).
 * - the main-trainer row is ROUND(…, 2) (`:101`, `:106`); additional-trainer rows are
 *   not rounded (`:186-191`). We mirror both, so a figure here equals the report's.
 *
 * Verified live 2026-10-09 against GET /users/{id}/report (see the spec's Notes).
 */

export interface TrainerPayTable {
  /** False when either lookup failed or came back truncated — callers must then
   *  emit no pay rather than a misleading 0. */
  available: boolean;
  unitAmount(trainerId: number, rateTypeId: number): number | null;
  rateKind(rateTypeId: number): string | null;
}

export const EMPTY_PAY_TABLE: TrainerPayTable = {
  available: false,
  unitAmount: () => null,
  rateKind: () => null,
};

/** True when any row on the page carries a session rate type — lets callers skip
 *  both rate lookups for pages where pay cannot apply. */
export function hasAnyRateType(records: RawEventRecord[]): boolean {
  return records.some((r) => toNum(r.trainer_rate_type_id) > 0);
}

/**
 * Load every trainer rate and rate type for the company: two small GETs, run in
 * parallel. GET /v1/trainer_rates returns the company's whole rate table in one
 * page (24 rows on the reference instance, default page_size 1000). Never throws —
 * a caller without permission to read rates (api-v1 gates them behind
 * `manage_places`, `common.php:167`) gets `available: false`.
 */
export async function loadTrainerPayTable(auth: ZoozaAuth): Promise<TrainerPayTable> {
  try {
    const [ratesRaw, typesRaw] = await Promise.all([
      zoozaFetch<ApiListResponse<RawTrainerRateRecord> | RawTrainerRateRecord[]>(
        "/trainer_rates",
        {},
        auth,
      ),
      zoozaFetch<ApiListResponse<RawTrainerRateTypeRecord> | RawTrainerRateTypeRecord[]>(
        "/trainer_rates/types",
        {},
        auth,
      ),
    ]);
    const rates = unwrapList<RawTrainerRateRecord>(ratesRaw);
    const types = unwrapList<RawTrainerRateTypeRecord>(typesRaw);
    if (rates.total > rates.records.length || types.total > types.records.length) {
      return EMPTY_PAY_TABLE;
    }
    const amounts = new Map<string, number>();
    for (const r of rates.records) {
      const amount = toNum(r.unit_amount, NaN);
      if (r.trainer_id && r.rate_id && Number.isFinite(amount)) {
        amounts.set(`${r.trainer_id}:${r.rate_id}`, amount);
      }
    }
    const kinds = new Map<number, string>();
    for (const t of types.records) kinds.set(t.id, t.type ?? "");
    return {
      available: true,
      unitAmount: (trainerId, rateTypeId) => amounts.get(`${trainerId}:${rateTypeId}`) ?? null,
      rateKind: (rateTypeId) => kinds.get(rateTypeId) ?? null,
    };
  } catch {
    return EMPTY_PAY_TABLE;
  }
}

/** Session-level pay inputs, or null when the session has no rate type or the
 *  rate table could not be read. */
export function projectEventPay(r: RawEventRecord, table: TrainerPayTable): EventPay | null {
  const rate_type_id = toNum(r.trainer_rate_type_id);
  if (!table.available || rate_type_id <= 0) return null;
  const eventMinutes = toNum(r.duration);
  const minutes = eventMinutes > 0 ? eventMinutes : toNum(r.schedule?.duration);
  const trainerId = r.trainer_id ?? 0;
  return {
    rate_type_id,
    rate_type: table.rateKind(rate_type_id),
    payout_percentage: toNum(r.trainer_payout_percentage),
    minutes,
    main_trainer: trainerId > 0 ? trainerPay(trainerId, r, table, true) : null,
  };
}

/** One trainer's pay on one session. `main` selects the report's rounding rule. */
export function trainerPay(
  trainerId: number,
  r: RawEventRecord,
  table: TrainerPayTable,
  main: boolean,
): TrainerPay | null {
  const rateTypeId = toNum(r.trainer_rate_type_id);
  if (!table.available || rateTypeId <= 0) return null;
  const unit_amount = table.unitAmount(trainerId, rateTypeId);
  if (unit_amount === null) return { unit_amount: null, amount: 0 };
  const eventMinutes = toNum(r.duration);
  const minutes = eventMinutes > 0 ? eventMinutes : toNum(r.schedule?.duration);
  const factor = table.rateKind(rateTypeId) === "fixed" ? 1 : minutes;
  const raw = unit_amount * toNum(r.trainer_payout_percentage) * factor;
  // 2 dp for the main trainer as the report does; otherwise only strip float noise
  // (0.1667 × 60 = 10.002000000000001) — inputs carry at most 4 dp each.
  return { unit_amount, amount: round(raw, main ? 2 : 8) };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function toNum(v: number | string | undefined | null, fallback = 0): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
