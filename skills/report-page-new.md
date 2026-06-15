---
name: report-page-new
title: Add a new report page to the client reports app
description: Author one new page in the Zooza client reports artifact (business-dashboard.html) when a client's question has no existing page but the capability manifest says the data exists. Walks the strict recipe — capability check, registry descriptor, render function, landing-menu entry, structural verification. Use when the user asks for a report/chart/view the reports app doesn't have yet.
---

# Add a new report page

You are adding a page to the client reports app (`artifacts/business-dashboard.html`,
spec ZMCP-20260612-001). A page is **one registry descriptor + one render function** —
the full recipe with code shapes and conventions is `docs/report-page-recipe.md`.
Read it before editing. This skill is the operational checklist around it.

## Step 0 — should this page exist at all?

1. **Check the registry first.** Search `const PAGES = [` — if an existing page already
   answers the question (even partially), open that page instead of building a near-twin.
   Prefer extending an existing page's render fn over adding a sibling.
2. **Check `artifacts/capability-manifest.json`.** Every field the page needs must be
   `"status": "available"`.
   - `"gap"` → build only if the page degrades gracefully (inert "—" cells), and say so.
   - Not listed / wrong grain (daily, billing-period) / wrong dimension → **STOP.**
     Tell the user precisely what's missing, quoting the manifest's `not_available`
     reason and what would unblock it. Offer the nearest available alternative
     ("I can show this monthly per programme — daily isn't available"). Never chart
     data the manifest doesn't list.
3. If the data gap matters to the client, log the demand: `submit_feedback` with the
   question that couldn't be answered. This feeds api-v1 endpoint priority.

## Step 1 — write the page

Follow `docs/report-page-recipe.md` exactly:

- [ ] Descriptor appended to `PAGES` (snake_case `id`, client-language `question`,
      `needs` matching manifest field names, `render` fn reference).
- [ ] Page id added to one `GROUPS` bucket in `ansHome()` (landing menu).
- [ ] Render fn returns `{head, body}`; head has the key numbers in `<strong>`,
      reads real data, changes when data changes.
- [ ] Empty state handled first.
- [ ] Reads `DATA.*` aggregates (period picker works for free), names via
      `courseName`/`placeName`/`scheduleName` + `escapeHtml`, money via `fmtCur`,
      thresholds from `TRIGGERS`.
- [ ] Activity-brand language everywhere (no generic "studio").

## Step 2 — verify structurally

Extract the inline script and `node --check` it; grep the four anchors (descriptor,
render fn, GROUPS entry, config-comment VIEW list). Do **not** open the artifact in the
agent sandbox — canvas errors there are false alarms (`artifacts/README.md`). Ask the
operator to verify visually, or check in a real browser.

## Step 3 — bookkeeping

- [ ] New metric/dimension combinations added to the capability manifest.
- [ ] Artifact top config comment lists the new VIEW id.
- [ ] PR mentions the new page id — it becomes a valid `view` for the reports MCP tool.

The page is permanent: the next client who asks this question gets it with zero build.
