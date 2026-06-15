# Business dashboard — data contract (demo ↔ live)

The dashboard (`artifacts/business-dashboard.html`) is written against a fixed in-memory shape
(`const EMBEDDED` in `demo-embedded.js`). Phase 6 swaps the demo for live api-v1 data **without
changing the render code** — the live fetch layer must assemble an object of the same shape.

This doc is the contract: the object keys, each row's fields, and which api-v1 endpoint feeds it.
Gaps and the underlying tables are in `artifacts/endpoint-gap-analysis.md`.

## Top-level object

```
EMBEDDED = {
  periods:         ["2026-01-01", … "2026-05-01"],   // month starts, ascending
  companyAll:      [ companyRow,  … ],   // one per period
  coursesAll:      [ courseRow,   … ],   // period × programme
  locationsAll:    [ locationRow, … ],   // period × venue
  schedulesAll:    [ scheduleRow, … ],   // period × class
  instructorsAll:  [ instructorRow, … ], // period × instructor
  trialsAll:       [ trialRow,    … ],   // period × programme (+place)
  retentionAll:    [ retentionRow,… ],   // period
  registrationsAll:[ regRow,      … ],   // registration-level (window "came back")
  replacements:    { …snapshot… }        // point-in-time make-up demand/supply
}
```

Every `*All` row carries `period` (`YYYY-MM-01`) + its id (`course_id` / `place_id` /
`schedule_id` / `user_id`). The frontend filters to `[from,to]` and aggregates (SUM for flow
metrics, LAST for stock metrics).

## Row shapes → source

| Key | Row fields (beyond ids+period) | Source | Endpoint |
|---|---|---|---|
| `companyAll` | active_schedules, current_enrollments, new_enrollments, enrollments, cancellations, received_payments, net_revenue, unpaid_enrollments, unpaid_debt, cash/card/transfer/direct_debit _sum+_count, refunds, discounts, **currency** | `business_company_overview` (+ `companies.currency`) | `GET /business/{company}/summary?from&to` |
| `coursesAll` | name, active_schedules, active_locations, instructors, current/new/enrollments, cancellations, sessions, sessions_with_attendance, received_payments, net_revenue, churn_rate, **unpaid_enrollments\***, **capacity\*** | `business_course_overview` (+ `courses.name`; *gap fields) | `GET /business/{company}/courses?from&to` |
| `locationsAll` | name, active_courses, instructors, current/new/enrollments, cancellations, sessions, received_payments, net_revenue, churn_rate, **sessions_with_attendance\***, **unpaid\*** | `business_location_overview` (+ `places.name`; *gap fields) | `GET /business/{company}/locations?from&to` |
| `schedulesAll` | name, course_id, current/new/enrollments, cancellations, sessions, sessions_with_attendance, received_payments, net_revenue, unpaid_enrollments, instructors, churn_rate, **capacity\***, **place_id\*** | `business_schedule_overview` (+ `schedules.name`,`.capacity`; *gap fields) | `GET /business/{company}/schedules?from&to` |
| `instructorsAll` | name, active_schedules, current/new/enrollments, cancellations, sessions, sessions_with_attendance, received_payments, net_revenue, churn_rate | `business_instructor_overview` (+ `users.name`) | `GET /business/{company}/instructors?from&to` |
| `trialsAll` | course_id, place_id, trial_started, trial_ended, trial_won, trial_lost, trial_type, unit_price_trial | `Report_Trials` / `v_trial_funnel_expanded` (+ `courses.trial_type`,`unit_price_trial`) | `GET /business/{company}/trials?from&to[&location_id&course_id]` |
| `retentionAll` | new_clients, returning, reactivated, lost | computed from `registrations` (`next`, `user_id`, `created`, `billing_period_id`) | `GET /business/{company}/retention?from&to` |
| `registrationsAll` | user_id, created, course_id | `registrations` (window "came back") | included in `/retention` (rows or windowed count) |
| `replacements` | summary + per-course demand/supply/ratio/status/elastic/hotspots | `credit_demand_supply_reports` (spec SDD-20260520-001) | `GET /credits?action=demand_supply` |

`*` = field not currently on the overview table — see gap analysis (add column or source from the
live table).

## Names / meta

Numeric ids → display names come from a single meta read:
`GET /business/{company}/meta` → `{ company:{name,currency}, courses:{id:name}, places:{id:name},
schedules:{id:name}, instructors:{id:name}, company_logo? }`.

`company_logo` (optional) is the client's logo for the dashboard header chip. It MUST be a
`data:image/...` URI (suggest ≤50 KB, source `companies.logo` / Sites_Storage `company_logo`) —
the artifact sandbox loads no external images, so a URL would render broken and is ignored
client-side.

## Fetch-layer contract (frontend side)

`business-dashboard.html` carries `DATA_MODE` (`'demo'` default). When `'live'`, `bootData()` calls
the endpoints above (through the MCP bridge / API base), assembles the `EMBEDDED`-shaped object, and
hands it to the existing `loadEmbeddedData(...)`. On any fetch error it falls back to demo and shows
an inline notice. Field names must match this contract exactly; if an MCP wrapper renames anything,
adapt the unwrap in `bootData()`, not the render code.

## Verify-numbers (acceptance)

For one company + one month: dashboard KPI == direct `SELECT` from the matching `business_*_overview`
row; occupancy uses `schedules.capacity`; trial rate == won/started; retention new/returning/lost
reconcile with `registrations`.
