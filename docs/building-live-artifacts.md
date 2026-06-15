# Building live artifacts for Zooza MCP

A **live artifact** is a single self-contained HTML page that Cowork persists across
sessions. Every time it's opened it calls Zooza MCP tools for fresh data and renders
charts, tables, and KPIs. Think of it as turning a one-off answer into a dashboard
the operator can re-open any morning — no Zooza login required.

This guide explains how to author one, wire it to Zooza tools, and ship it in this
repo. Reference implementation: [`artifacts/business-dashboard.html`](../artifacts/business-dashboard.html) — the business dashboard artifact.

---

## How a live artifact actually runs

The HTML runs inside a **sandboxed light-mode view** in the Cowork sidebar. Inside it
you get a `window.cowork` bridge:

| API | What it does |
|---|---|
| `window.cowork.callMcpTool(name, args)` | Calls any Zooza MCP tool you declared. Returns a Promise. Reads are transparently **cached**. |
| `window.cowork.askClaude(prompt, data[])` | Runs a quick Haiku pass over data you just fetched — summaries, classifications, natural-language digests. |
| `window.cowork.runScheduledTask(taskId)` | Triggers one of the user's scheduled tasks (needs a user click). |

Hard constraints (the sandbox enforces them — design around them up front):

- **No network** except three allow-listed CDNs: Chart.js 4.5.0, Grid.js 5.0.2,
  Mermaid 11.10.0. Use the exact `<script>` tags with `integrity`/`crossorigin`.
  Anything else must be inlined.
- **Everything in one file.** Inline all CSS/JS; use `data:` URLs for images.
- **Light mode.** Set `:root { color-scheme: light }`, light background, dark text.
- **No auth in the page.** Credentials live in the MCP server's `.env`
  (`X-ZOOZA-API-KEY` etc.). The page never sees a token — it just calls tools.
- **Don't build a reload button.** The artifact header already has one.
- `localStorage` persists across reloads, so you may remember filter/sort choices.

---

## The one rule that saves you: probe before you build

MCP wrappers rename parameters and reshape output relative to the raw api-v1
endpoint. **Never assume the response shape** — call the tool once in chat, look at
the actual JSON, and build your parser around what you observed.

```
You (in chat): call find_events with from/to for the next 14 days
→ inspect: is it res.events? res.data[]? what are the field names on each row?
→ THEN write the unwrap line in the artifact to match.
```

In the scaffold this is the line to adapt:

```js
const rows = res?.events ?? res?.data ?? res?.results ?? (Array.isArray(res) ? res : []);
```

Pin it to whatever the real payload uses once you've seen it.

---

## Zooza tools worth charting

Pick the tools whose output changes over time — that's what makes an artifact worth
re-opening. Most useful for dashboards:

| Tool | Good for |
|---|---|
| `find_events` | Upcoming sessions, fill rate, sessions-per-day, capacity heatmap. Returns `attendance_counts` (`going`, `attended`, `noshow`, `canceled`, `waitlist`), `capacity`, denormalised `trainer_name`/`place_name`. |
| `get_attendance_roster` | Live per-session roster; attended vs no-show trends. |
| `find_courses` | Programme/Class catalogue; counts per programme. |
| `find_billing_periods` | Revenue/term windows for time-series. |
| `find_trainers` / `find_places` | Group-by dimensions (per-trainer, per-room load). |

Scope to "my" data by passing `trainer_id` = `whoami.identity.user_id`. Without it,
`find_events` returns **every** trainer's events in the company.

For multi-company users, every call needs an explicit `company_id` (from
`whoami.available_companies[].id`).

---

## The fully-qualified tool name

Inside the page a tool is addressed as `mcp__<server>__<toolname>`, e.g.
`mcp__zooza__find_events`. The `<server>` prefix is whatever the Zooza connector is
registered as in the Cowork session. The scaffold isolates this in one constant:

```js
const ZOOZA_SERVER = "zooza";
const tool = (name) => `mcp__${ZOOZA_SERVER}__${name}`;
```

When you register the artifact, list the exact tool names you call in `mcp_tools`.

---

## Authoring workflow, end to end

1. **Probe** the Zooza tool(s) in chat; record the real response shape.
2. **Copy the scaffold** to a new file under `artifacts/` and edit the `// EDIT`
   markers: the tool call + args, the unwrap line, the KPI calculations, the chart,
   and the table columns.
3. **Write it to a workspace file** so it can be read back and verified.
4. **Register it** from chat:
   ```
   create_artifact(
     id: "zooza-sessions",
     html_path: "artifacts/zooza-sessions.html",
     description: "Upcoming Zooza sessions, fill rate, sessions-per-day.",
     mcp_tools: ["mcp__zooza__find_events"]
   )
   ```
5. **Open it** in the sidebar, hit the built-in Reload, confirm fresh data.
6. Optionally pair it with a **scheduled task** (e.g. a 6am digest) — the artifact is
   the "look again" surface, the schedule is the push.

---

## Shipping it in this repo (GitHub)

Live artifacts live under `artifacts/` so they version alongside the tools and skills
they depend on. Convention:

```
artifacts/
  business-dashboard.html   # the business dashboard artifact (reference implementation)
  demo-embedded.js          # anonymized demo data it renders
```

To publish a change:

```bash
git checkout -b artifact/<view-name>
git add artifacts/zooza-<view>.html docs/building-live-artifacts.md
git commit -m "feat(artifacts): add <view> live artifact"
git push -u origin artifact/<view-name>
# open a PR against the default branch
```

Notes for this repo specifically:

- Keep all customer-facing text in **activity-brand** language (see `CLAUDE.md`):
  "activity brand / activity provider", never generic "studio" / "studio owner".
- An artifact references tools, so its lifecycle is tied to the tool specs (`ZMCP-…`).
  If a tool's output shape changes, the artifact's unwrap line may need updating —
  call that out in the PR.
- The audit log records the MCP-level calls the artifact makes (tool + args +
  result), which is handy for debugging a misbehaving view.

---

## Common pitfalls

- **Blank page / "Couldn't load":** the unwrap line doesn't match the real payload —
  re-probe and fix it. The scaffold already wraps the call in `try/catch` and shows
  the error inline.
- **Chart never renders:** you loaded a CDN that isn't allow-listed, or used the
  script tag without `integrity`. Only the three listed libs work.
- **Empty data for "my classes":** missing `trainer_id`. **Wrong company:** missing
  `company_id` on a multi-company account.
- **Dark, unreadable view:** you didn't set light-mode colors. The sidebar is light.
