---
name: class-management
description: Guided flow for creating a new Zooza class — interview the user, accumulate session patterns, commit. Used in conjunction with the preview_schedule, preview_events, and commit_class MCP tools.
---

# Class management

When the user wants to **create a new class** (synonyms: "set up a class", "schedule a course", "add a Monday/Wednesday class", "start a new training group"), enter this guided flow. Do **not** try to construct the full class in one tool call — the user almost certainly hasn't told you everything yet.

## The shape of a class

A "class" in Zooza is a *schedule* of a course at a venue, with a series of *sessions* (events). Real classes rarely fit a single recurrence rule. Typical patterns you'll meet:

- "12 sessions every Monday at 1pm" — single weekly recurrence, count mode.
- "Mondays and Wednesdays at 1pm until end of June" — multi-weekday in one block, until-date mode.
- "Mondays at 1pm with Martin, Wednesdays at 2pm with Jana" — two blocks, different trainers.
- "Weekly Monday + a one-off joint training on July 15" — block + ad-hoc date.

The user's pattern is assembled across multiple turns. Gather it iteratively.

## The flow

### Step 1 — Resolve the class shell

**Precondition:** by this point you should already know which `company_id` to work in (the session bootstrap covers this — call `whoami` first if you somehow skipped it). Pass `company_id` to every `find_*`, `preview_*` and `commit_*` call below.

Ask the user (one combined prompt is fine), and resolve each via the matching `find_*` tool before passing to `preview_schedule`:

- **Which course?** If they name it (or use any substring), call `find_courses({ company_id, name: <substring> })`. Render matches as `id | name | target_audience | price | schedules_count`. One match → confirm with the user; multiple → ask them to pick; zero → broaden the search or accept that no such course exists. If they gave a numeric id upfront, accept it without calling `find_courses`.
- **At which venue?** Call `find_places({ company_id, name: <substring> })` (or `{ company_id, city: <substring> }` for multi-venue companies). Render `id | name | city | street | rooms` — rooms come pre-inlined. If the operator names a specific room, surface its capacity in the confirmation.
- **Primary trainer?** If the user names a person (or a substring), call `find_trainers({ company_id, name: <substring> })` and render `id | full_name | email`. Active team members only by default; pass `include_inactive: true` only if the operator explicitly asks for a former trainer. Note: api-v1 returns ANY company team member who could be assigned (`owner`, `member`, `external_member`, `assistant`, `main_member`) — not a separate "trainer" role.

  If the user **doesn't name a trainer** (e.g. "leave it open", "we'll figure it out", "no trainer yet", or simply skips the question), don't pick a real person — offer Zooza's three built-in placeholders and ask the user to pick:

  | id | placeholder | when to use |
  | --- | --- | --- |
  | `9000000000001` | **To be decided** | the operator will assign a real trainer later — default for "we don't know yet" |
  | `9000000000002` | **Trainer unassigned** | the operator explicitly does not want to assign anyone (e.g. self-led class, walk-in studio time) |
  | `9000000000003` | **Guest trainer** | sessions will be run by visiting / rotating guests rather than a fixed staff trainer |

  These ids are hardcoded constants — do not look them up via `find_trainers`. If the user gives no signal at all, default to `9000000000001` ("To be decided") and tell the user that's what you picked so they can override.

Composite trainer lookups: if the operator says *"who teaches at Centrum Rafael?"* or *"who teaches Yoga?"*, call `find_trainers({ place_id })` or `find_trainers({ course_id })` respectively — both filters compose.

Capture any other inputs the user already mentioned (capacity, prices, schedule_type, `online_registration`, `billing_period_id`).

Call `preview_schedule` with those inputs. Render the resolved shell as a compact table:

| Field | Value | Note |
| --- | --- | --- |
| Course | (course_name) (id N) | |
| Venue | (place_name) (id N) | |
| Primary trainer | (name or "To be decided") | |
| Capacity | N | default for `target_audience=groups` is 10 |
| Unit price | €N | copied from course |
| Online registration | true/false | controls whether the class is published publicly |
| Billing period | (id or "fallback") | |
| Payment templates | (rendered names) | |

Then list `warnings[]` verbatim under a short heading. **Treat every warning as a question to the user, not a footnote** — in particular:

- If a warning mentions `online_registration` defaulting to true, explicitly ask: *"Should this class be published on the public website for online enrollment, or kept private?"*
- If a warning mentions `billing_period_id` falling back, call `find_billing_periods({ company_id })` (returns all active periods, typically 1–30 per company) and offer them as a table (`id | name | active`). Ask the operator to pick. If the company has only one active period, name it and ask "use this one?"

Ask the user to **confirm the shell** before adding sessions. If they want to change a default, capture the change and re-call `preview_schedule`.

### Step 2 — Loop: collect session patterns

Ask: **"What's the session pattern?"**

Translate the user's natural-language answer into the `preview_events` input. **Prefer `count` mode when the user names a number of sessions** — it avoids guessing a `to_date`.

| User says | Map to |
| --- | --- |
| "12 sessions every Monday at 1pm starting May 25" | `from_date: "2026-05-25"`, `blocks: [{weekdays: ["mon"], cadence: "weekly", count: 12, time_minutes: 780, duration: <from shell>, billable: true}]` |
| "every Monday at 1pm from May 25 to Aug 31" | `from_date: "2026-05-25"`, `blocks: [{weekdays: ["mon"], cadence: "weekly", until_date: "2026-08-31", time_minutes: 780, duration: <from shell>, billable: true}]` |
| "Mondays and Wednesdays at 1pm, 10 sessions" | one block with `weekdays: ["mon","wed"]`, `count: 10` |
| "first Friday of each month, 6 sessions" | `blocks: [{weekdays: ["fri"], cadence: "monthly", count: 6, ...}]` |
| "July 4 at 17:00 as a one-off" | `additional_dates: [{date_string: "2026-07-04", time_minutes: 1020, duration: <from shell>, billable: true}]` |
| "every other Tuesday with trainer Jana, 8 sessions" | block with `cadence: "biweekly"`, `weekdays: ["tue"]`, `count: 8`, `trainer_id: <Jana's id>` |

Rules:
- Each block needs **exactly one** of `count` or `until_date`. Don't pass both.
- The top-level `to_date` is only a *fallback* for blocks that omit both — prefer being explicit per block.
- `place_id` always comes from the resolved shell. Pass it on every `preview_events` call.

Call `preview_events`. Render the returned events as a markdown table, **grouped by month**:

```
### May 2026
| Day | Date | Time | Duration | Billable | Trainer |
| --- | --- | --- | --- | --- | --- |
| Mon | 2026-05-25 | 13:00 | 60 min | ✓ | Martin |

### June 2026
| Day | Date | Time | Duration | Billable | Trainer |
...
```

If `skipped[]` is non-empty, list those separately:

> ⚠ Holidays skipped: 2026-05-30 (national holiday — Constitution Day), 2026-07-14 (custom — "Studio closed").

**Append the returned events to a running list** in your memory. Track *all* events accumulated so far across multiple `preview_events` calls. The order in the table should be chronological (sort by `date_string` then `time_minutes`).

Then ask: **"Any more sessions to add, or are we done?"**

If more: collect the next pattern, call `preview_events` again, append to the running list, re-render the **combined** table (the user sees the full picture growing). If the new pattern produces dates that collide with existing ones (same date + time), flag the collision and ask the user to resolve.

If done: move to Step 3.

### Step 3 — Final confirmation and commit

Show the user the **full accumulated table** one more time with the schedule shell summarised at the top. Include the total session count. Ask one last "OK to create?"

On yes: call `commit_class` with:

- `schedule`: the resolved shell from Step 1
- `events`: the full accumulated array (each event needs `date_string`, `time_minutes`, `duration`, `billable`, optionally `trainer_id` if overriding the primary)
- `payment_schedule_template_ids`: from the resolved shell

On error from `commit_class`, surface the api-v1 message verbatim and offer to retry. **If the schedule was created but events failed**, the error message will say so — tell the user explicitly, give them the schedule id, and offer either to retry `POST /v1/events` (we don't have a direct tool yet — note this) or to delete the orphan schedule.

On success, render:

```
Created class **{name}** (schedule {id}). **{N} sessions** posted.

**Admin:** {admin_url}
**Registration:** {registration_url}
```

If `registration_url_active === false`, append " (not live yet — publish the class via the admin URL to activate)" to the Registration line. If either URL came back `null` (api-v1 hiccup or older version), say so plainly rather than printing the literal "null". Then offer to start another class.

## Disambiguation rules

- **Trainer name → id.** If the user names a trainer ("with Martin"), look up via `find_trainers({ name: "Martin" })` and disambiguate on multiple matches. If the user doesn't name a trainer, do NOT call `find_trainers` — offer the three placeholder ids from Step 1 (`9000000000001` To be decided, `9000000000002` Trainer unassigned, `9000000000003` Guest trainer) and let the user choose; default to `9000000000001` only if they decline to pick.
- **Course / venue ambiguity.** Never guess. List candidates and ask.
- **Time formats.** Convert "1pm" → `780` minutes, "13:30" → `810`. If the user gives a time outside reasonable working hours (before 6am or after 11pm), confirm before previewing.
- **Date phrasing.** "next Monday", "every Monday in May", "from June through August" — resolve to ISO dates using today's date as the anchor. Always show the resolved `from_date` (and `until_date`, if used) back to the user before previewing.
- **Monthly cadence reminder.** `cadence: "monthly"` means *first occurrence of the chosen weekday in each month*, not "same day-of-month". The preview will reflect this, but proactively warn the user when they say "monthly starting May 25" because May's first Monday may already be before that date and get skipped.

## Edge cases

- **Lead-collection classes** (`schedule_type: "lead_collection"`) have no events. If the user says "I just want to gauge interest" or "no fixed dates yet, just collecting signups," set `schedule_type: "lead_collection"` and **skip Step 2 entirely**. Go straight from Step 1 to Step 3 with `events: []`.
- **Pricing-copied warning.** If `preview_schedule.warnings` includes a price-copied-from-course note, mention it. If the user intended `0` for some price, they can override explicitly.
- **Capacity vs room capacity.** Non-blocking warning; show verbatim and let the user decide.
- **`count_unreachable_in_window`.** api-v1 caps the search at 2 years. If the user asks for a session count that can't fit (e.g. "monthly cadence, 50 sessions" → 4+ years), the call errors with this message — explain the cap and ask whether to reduce the count or use `until_date` instead.
- **Calendar shift between preview and commit.** Not a v1 concern (we don't expose `skip_*` flags yet), but if you ever do: call `preview_events` once more right before commit with the same inputs to verify the dates haven't changed underneath you.
