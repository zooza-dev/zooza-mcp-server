---
name: report-compose
title: Compose a custom report the client owns
description: Build a focused, single-question report artifact for an activity-brand client using their REAL data. Use whenever a client asks to see / show / build a report, dashboard, chart, or visual of their business numbers (occupancy, unpaid, churn, attendance, trials, retention, revenue, "how are we doing"). The client should feel they created this report — compose it live around their data and brand, one question per page. Never show the full multi-tab dashboard; never invent numbers.
---

# Compose a custom report the client owns

The client asks a business question; you build them a small report that answers exactly
that — with their real numbers and their brand. They should feel **they** created it
(Claude built it for them, on the spot), not that they opened a pre-made product. You are
the composer; Zooza supplies the invisible scaffolding (data + components).

## The one unbreakable rule

**Every number comes from `reports_get_data`. You never invent, estimate, or recompute a
figure, and you never draw a chart before calling it.** If the tool returns no rows, say
so plainly and stop — a fabricated report is worse than no report. (This is why the data
tool exists: it pre-computes the headline figures so you only render them.)

## Flow

1. **Find the question.** Map the client's words to one view:
   `occupancy` (empty seats), `unpaid` (money owed), `churn` (leaving), `attendance`
   (not showing up), `trials` (converting), `retention` (coming back),
   `clients_by_location` (per venue), `summary` (overall). Vague? Ask ONE narrowing
   question — never make them name a metric. (The `report-discovery` skill has the full
   symptom→view tree.)
2. **Get the real data.** Call `reports_get_data` with the `view` (+ `from`/`to` if they
   named a period). Use its `headline`, `rows`, `note`, `currency` verbatim.
3. **Compose a focused artifact** — one question, nothing else. Use the component kit
   below. Title it after their question, brand it (their logo/colour from `whoami`'s
   `branding`), end with the tool's `note` as the plain-language takeaway.
4. **Hand them ownership.** Name it as theirs ("Your occupancy report"), then offer:
   *"Want me to save this so you can re-open it any time?"* In Cowork, persist it as a
   live artifact (see "Make it live & owned"). Offer refinements — "add last month",
   "just programme X" — by re-calling `reports_get_data` and recomposing.

Never render the full multi-tab dashboard to a client. One page answers one question.

## Component kit

Self-contained HTML, everything inline, light mode. **No charting library and no CDN** —
the Cowork sandbox blocks external CDNs (cdnjs *and* jsdelivr both fail). Draw charts with
plain SVG / CSS. Drop `reports_get_data` values straight in — no math in the page.

**Page shell + brand + caption:**
```html
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light;--accent:#FA6900}      /* swap to branding.primary_color */
  body{font-family:'DM Sans',-apple-system,system-ui,sans-serif;background:#f0f2f5;color:#191919;margin:0;padding:24px}
  .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #ececf3;border-radius:14px;padding:24px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
  .head{display:flex;align-items:center;gap:12px;border-bottom:3px solid var(--accent);padding-bottom:12px;margin-bottom:18px}
  .head img{height:28px}                            /* client logo (data: URI) */
  h1{font-size:18px;margin:0}
  .note{margin-top:16px;color:#374151;font-size:15px;line-height:1.5}
  .kpi{display:flex;gap:24px;flex-wrap:wrap;margin:4px 0 18px}
  .kpi b{font-size:24px;color:var(--accent);display:block} .kpi span{color:#6b7280;font-size:12px}
  .bar{display:grid;grid-template-columns:150px 1fr 52px;align-items:center;gap:10px;margin:5px 0;font-size:13px}
  .bar .label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151}
  .track{background:#eef0f4;border-radius:6px;height:14px;overflow:hidden}
  .fill{height:100%;background:var(--accent)}
  .bar .val{text-align:right;font-variant-numeric:tabular-nums;color:#6b7280}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:14px}
  th{text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #e5e7eb}
  td{padding:8px;border-bottom:1px solid #f3f4f6}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .em{font-weight:700;color:var(--accent)}
</style></head><body><div class="card">
  <div class="head"><h1>Occupancy — your classes</h1></div>
  <div id="kpi" class="kpi"></div>
  <div id="bars"></div>
  <div class="note">PASTE reports_get_data.note HERE</div>
</div>
<script>/* fetch + render with plain SVG/CSS — see below. No CDN, no library. */</script>
</body></html>
```

**Conventions (visual language from `artifacts/business-dashboard.html`):** one colour per
metric — enrollments `#FA6900`, revenue `#3aa39d`, sessions `#8b5cf6`, churn `#ff3000`.
Truncate long labels (full name in the `title=` tooltip). Every chart gets a one-line
"what this means" caption — use the tool's `note`. The dashboard's charts are Chart.js;
ignore the library, lift only the colours and captions — here we draw with SVG/CSS.

**KPIs + a bar list from `rows` — no library:**
```js
// headline KPIs
document.getElementById('kpi').innerHTML =
  `<div><b>${DATA.headline.overall_occupancy_pct}%</b><span>occupancy</span></div>` +
  `<div><b>${DATA.headline.total_filled}/${DATA.headline.total_capacity}</b><span>seats filled</span></div>` +
  `<div><b>${DATA.headline.classes_under_70pct}/${DATA.headline.class_count}</b><span>under 70% full</span></div>`;

// one CSS bar per class — occupancy_pct drives the fill width, filled/capacity is the label
const bars = document.getElementById('bars');
DATA.rows.forEach(r => {
  const pct = Math.max(0, Math.min(100, r.occupancy_pct));
  const row = document.createElement('div'); row.className = 'bar';
  row.innerHTML =
    `<div class="label" title="${r.programme} — ${r.name}">${r.name}</div>` +
    `<div class="track"><div class="fill" style="width:${pct}%"></div></div>` +
    `<div class="val">${r.filled}/${r.capacity}</div>`;
  bars.appendChild(row);
});
```

CSS bars cover every bar/occupancy view with zero dependencies. For a donut (e.g. churn
split) use one inline `<svg>` with `<circle>` arcs — still no library. Never reach for a CDN.

## Make it live & owned (Cowork)

In Cowork the artifact refreshes itself — no token, no expiry. Two things bite if you skip
them (both verified the hard way):

1. **Use the EXACT tool name from this session's tool list** — it is
   `mcp__<connector-id>__reports_get_data` with an opaque connector id, NOT `mcp__zooza__`.
   Read it off your own available tools; never hardcode the prefix.
2. **`callMcpTool` returns the MCP envelope, not the data.** The data is a JSON string in
   `content[0].text` — unwrap and parse it.

```js
const TOOL = 'mcp__<connector-id>__reports_get_data';   // exact name from YOUR tool list
const res  = await window.cowork.callMcpTool(TOOL, { view:'occupancy', company_id: COMPANY_ID });
if (res.isError) throw new Error(res.content?.[0]?.text || 'tool error');
const DATA = JSON.parse(res.content[0].text);           // {view, headline, rows[], note, currency, ...}
```

Put that call at the top so the panel's built-in Reload pulls fresh numbers, then persist via
`create_artifact` titled as the client's report. That turns "a report Claude showed me" into
"my report I re-open every Monday" — the ownership moment. (Tool results reach the artifact
text-only — the bridge rejects image/non-text content blocks, so the server ships them plain.)

Outside Cowork (plain chat / browser), call `reports_get_data` yourself and bake the values
into the page as a static snapshot; offer to rebuild it whenever they want fresh numbers.

## Ownership checklist

- [ ] Titled after the client's own question, in their words.
- [ ] Their logo + accent colour applied (from `whoami` `branding`).
- [ ] One question only — no extra tabs, no full dashboard.
- [ ] Caption = the tool's `note`; every figure traceable to `reports_get_data`.
- [ ] Offered to save it (Cowork live artifact) and to refine the period/scope.
- [ ] Activity-brand language throughout — never generic "studio".
