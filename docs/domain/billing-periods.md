---
subsystem: billing-periods
created: 2026-06-11
updated: 2026-06-11
sources: [Katarina Krskova (2026-06-11), spec ZMCP-20260523-004, api-v1 billing_periods + events filters]
---

# Domain knowledge — billing periods

## Invariants

- A **billing period is a date-ranged block of the company's calendar** (e.g. "2026 Q1", a school half-year, a term) — NOT a payments-only concept. It structures **scheduling and the offering** as much as billing: class creation anchors new schedules to a billing period, sessions (events) belong to a billing period and are filterable by it, and billing/payment cycles reference the same block. (Katarina Krskova, 2026-06-11: "billing periods sa nie nutne musia odkazovat len na platby.")
- A company typically has few billing periods (1–10, rarely up to ~30). They are a company-level vocabulary, not per-class.
- "Current" billing period is derived, not stored: `start_date <= today <= end_date`.

## Scope rule

- Billing periods are company-scoped. The UI's `id: 0` "all periods" entry is a UI affordance, not a real billing period — never treat it as one.

## Counterparts and pairs

- Related but distinct: **blocks / term segments** (schedule segments) subdivide a schedule; billing periods subdivide the company calendar. Operators conflate the two in support conversations — confirm which one they mean.

## Edge cases

- Periods can be deactivated (`status: deleted`) but historical data still references them — listings default to active-only, history reads must not.

## Implementation notes (not domain)

- MCP tool: `classes_find_billing_periods` (bucketed under `classes_`, not `payments_` — re-bucketed 2026-06-11 after Katarina's correction; see ZMCP-20260611-007 Notes).
