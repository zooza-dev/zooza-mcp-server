---
name: report-discovery
title: Lead a client from a vague worry to the right report
description: Routing interview for the Zooza client reports app. Clients rarely ask for a metric by name — they describe a symptom ("feels like fewer kids coming", "money seems tight"). This skill maps symptom → metric → report page, opens the right page, and handles the case where the data doesn't exist yet. Use whenever an activity-brand operator asks a business question about their numbers, performance, or "how are we doing".
---

# Report discovery — symptom → metric → page

Clients of activity brands don't know report names and shouldn't have to. Your job:
hear the worry, find the metric behind it, open the page that answers it. The pages
live in the reports artifact (`artifacts/business-dashboard.html`); valid page ids are
the `PAGES` registry entries. What data exists is defined by
`artifacts/capability-manifest.json` — consult it before promising anything.

## Opening move

If the client's question is vague or this is their first time: open `view: "home"` —
the landing page shows what currently needs attention plus a question menu. Often the
trigger list IS the answer to "how are we doing?".

If the question maps cleanly below: open that page directly. Don't interview when you
don't need to.

## The routing tree

**Money worries** — "tight", "owed", "where does money go", "did we earn more?"
- Someone hasn't paid / outstanding balances → `unpaid`
- Where revenue comes from, payment methods, refunds → `payments`
- Overall money picture, this period vs last → `summary`

**People worries** — "fewer kids", "people leaving", "empty feeling", "are they happy?"
- Members cancelling / leaving → `churn`
- Do clients come back next term → `retention`
- People enrolled but not showing up → `attendance`
- Are trial sessions turning into members → `trials` (detail: `trials_tab`)
- How many clients at each venue → `clients_by_location`

**Space & schedule worries** — "half-empty classes", "can't fit make-ups", "which slots work?"
- Empty seats / capacity → `occupancy`
- Make-up credits vs free slots → `replacements` (detail: `replacements_tab`)
- Per-class performance → `schedules`
- Per-instructor performance → `instructors`

**The full picture** — "show me everything", monthly review ritual
- `dashboard` (all tabs), or per-entity tabs: `courses`, `locations`, `insights`

Ambiguous symptom → ask ONE clarifying question framed as a choice, not a blank:
"Is the worry more about people leaving, or people not paying?" Then route. Never ask
the client to name a metric.

## Period selection

Every page respects the in-app period picker (month-grain, presets + from/to).
If the client names a window ("since January", "last 3 months"), tell them the page
opened on it / how to set it. Billing-period and daily grain are NOT available — if
asked, say so plainly (see manifest `grains`) and offer whole months as the closest cut.

## When no page fits

1. Check the capability manifest. Data available → build the page with the
   `report-page-new` skill (one descriptor + one render fn), then open it. The page is
   permanent — next client gets it free.
2. Data is a `gap` or in `not_available` → tell the client exactly what's missing and
   why, in plain words, and offer the nearest available answer. **Never improvise a
   chart over data the manifest doesn't list, and never show a number you can't source.**
3. Log unanswerable questions via `submit_feedback` — real client demand drives which
   api-v1 endpoints get built next.

## Tone rules

- Activity-brand language; mirror the client's own vocabulary for their programmes and
  venues (use `get_terminology` if unsure).
- Lead with the answer the page shows ("3 classes are below 60% attendance — opening
  the attendance report"), not with navigation mechanics.
- One page at a time. If two pages are relevant, open the more urgent one and mention
  the other.
