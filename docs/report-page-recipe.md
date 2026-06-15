# Report page recipe — adding a page to the reports app

How to add one page to `artifacts/business-dashboard.html` (spec ZMCP-20260612-001).
A page = **one registry descriptor + one render function**. Nothing else. If you find
yourself editing more than those two places (plus the manifest cross-check), stop — you
are doing it wrong.

## Before you write anything: the manifest check

Open `artifacts/capability-manifest.json`. The page's data needs must resolve to fields
with `"status": "available"`.

- Field is `"gap"` → the chart would silently show fake/missing data in live mode.
  Either design the page to degrade (show "—" and stay inert, like the Unpaid column
  does), or don't build it.
- Combination not listed (wrong grain, wrong dimension) → it cannot be built. Tell the
  user exactly what's missing, quoting the manifest's `not_available` entry. **Never
  improvise a chart over data the manifest doesn't list.**
- Demo data lives in `artifacts/demo-embedded.js` — if the field exists in the manifest
  but not in demo data, regenerate demo via `artifacts/gen_demo.py` (seed 42) or extend it.

## Step 1 — the descriptor

Find `const PAGES = [` in the artifact (search anchor: `PAGES REGISTRY`). Append:

```js
{ id:'my_page', kind:'answer', question:'Plain-language question this answers?',
  needs:['locationsAll.current_enrollments'], render:ansMyPage },
```

- `id` — snake_case, stable forever (it's the MCP tool's `view` value and the URL hash).
- `question` — what a client would actually ask, in activity-brand language. This text
  IS the landing-page menu button. No jargon, no metric names.
- `needs` — the `EMBEDDED` keys/fields you read, named exactly as in the capability
  manifest (`dataset.field` or whole `dataset`).
- `kind:'answer'` for focused pages. (`'tab'` pages also exist but adding a dashboard
  tab is a bigger job — KPIs, sections, renderAll — and is rarely what a new question needs.)

Then add the page id to one `GROUPS` bucket inside `ansHome()` (Money / People /
Classes & space / The full picture) so the landing menu shows it.

## Step 2 — the render function

Add `function ansMyPage(){...}` next to the other `ans*` functions. Contract: return
`{ head, body }`.

- `head` — one or two sentences with the **key numbers bolded** (`<strong>`), reading
  the client's real data. This is the data-aware caption — it must change when the data
  changes. Pattern: lead with the answer, then the consequence.
  ("You have **27** unpaid bookings across **9** classes. Start at the top of the list.")
- `body` — optional `.ans-block` sections: `.ans-title` heading + `.ans-table` table
  (or `occupancyBars()` style visuals). Worst-first ordering; cap lists at ~15 rows.
- **Empty state is mandatory.** First line: if there's nothing to show, return a
  friendly all-clear head and empty body. Look at `ansUnpaid()` for the canonical shape.

### Conventions that apply to every page (from the dashboard tracker)

- Read from `DATA.*` (period-filtered aggregates: `DATA.schedules`, `DATA.courses`,
  `DATA.locations`, `DATA.instructors`, `DATA.trials`, `DATA.retention`,
  `DATA.registrations`, `DATA.replacements`) — never from `EMBEDDED`/`DATA.raw`
  directly. That's what makes the period picker work on your page for free.
- Names via `courseName()` / `placeName()` / `scheduleName()` + `escapeHtml()` —
  never raw ids, never unescaped names.
- Money via `fmtCur()`, counts via `fmt()`, percentages via `fmtPct()`.
- Thresholds from `TRIGGERS` — don't invent new magic numbers; if you need a new
  threshold, add it to `TRIGGERS` with a comment.
- If you add a Chart.js chart (tab pages): reuse `valAxis()` + `catTicks()` for axes,
  `METRIC_COLORS` per metric (enrollments orange, revenue teal-blue, sessions purple,
  churn red), log-scale convention for count/money bars, and a `setNote()` caption.
- All text in **activity-brand language** — never generic "studio" (see repo CLAUDE.md).

## Step 3 — verify (structurally — do NOT render in the agent sandbox)

```bash
python3 -c "
import re
html = open('artifacts/business-dashboard.html').read()
open('/tmp/bd-script.js','w').write('\n'.join(re.findall(r'<script>(.*?)</script>', html, re.S)))
"
node --check /tmp/bd-script.js
```

Then grep-verify: descriptor present in `PAGES`, render fn defined, page id in a
`GROUPS` bucket, no leftover `console.log`. Rendering in the sandbox throws canvas
errors that don't reflect real problems (`artifacts/README.md`) — verify in a real
browser or via the operator instead.

## Step 4 — bookkeeping

- If the page exposes a NEW metric/dimension combination, add it to
  `artifacts/capability-manifest.json` (and `endpoint-gap-analysis.md` if it has a gap).
- Update the VIEW list in the artifact's top config comment.
- Mention the new page id in the PR — it becomes a valid `view` for the MCP tool.
