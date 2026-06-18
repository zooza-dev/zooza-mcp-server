---
name: schedule-optimization
title: Plan a new billing period's timetable
description: Guided flow for building a whole weekly timetable OVERVIEW for a new billing period (school year / term). Two modes — optimise from scratch (forecast + constraint solver) or roll over the current period (copy as-is, advance courses by a client progression map, or apply small edits), with a shared validator and repair. Produces a reviewable overview only; a separate tool creates the classes. Uses predict_demand, build_timetable, and the find_* tools.
---

# Schedule optimisation — new billing-period timetable

> **Terminology is pre-loaded in your context.** This skill operates on Zooza's
> Programme → Class → Session hierarchy. A **Class** is the recurring weekly group
> you place on the grid; a **Session** is a single dated meeting generated *later*
> by `preview_events`. If the user uses non-standard terms ("kurz", "rozvrh",
> "skupina"), resolve them to canonical Zooza terms first; use `get_terminology`
> if unsure.

Enter this flow when the operator wants to **build or rebuild a whole timetable
for a new period** — synonyms: "plan next term", "set up the new school year's
schedule", "rebuild the rozvrh", "we're starting September, organise all the
classes", "optimise our weekly schedule". This is *not* the single-class flow
(that's `class-management`); this places *many* classes at once and resolves
conflicts between them.

## What this skill is (and the model behind it)

This is the **class–teacher timetabling problem**: assign every Class a
(weekday + start-time, room, trainer) so nobody and no room is double-booked,
skills/capacities/availabilities hold, and classes land in historically strong
slots. It is **not** a job-shop problem. The full mathematical model and a runnable
prototype live in `research/timetable-optimization/` (`MODEL.md`). You don't need the
maths to run this skill, but cite it if the operator asks "how does this decide?".

The work is **two stages, kept separate**:

1. **Forecast** (`predict_demand`) — read history, estimate each class's expected
   enrolment and which slots it historically filled.
2. **Build** (`build_timetable`) — take those numbers as fixed input and produce the
   overview, in one of two **modes**.

Never ask the solver to guess demand, and never ask the forecaster to resolve
conflicts. Run them in order.

**Two important framings:**

- **You produce an overview, not classes.** `build_timetable` never writes anything.
  The deliverable is a reviewable timetable the operator signs off on; a *separate*
  tool (`create_classes_from_timetable`, not yet built) turns the approved overview
  into real classes. Say this up front so the operator iterates freely.
- **Most periods are a copy, not a blank slate.** Before forecasting from scratch,
  ask whether they want to **roll over** the current period (see Step 0). Optimising
  everything fresh is the exception; copying-with-changes is the norm.

## The flow

### Step 0 — Bootstrap and scope

**Precondition:** know which `company_id` to work in (call `whoami` first if you
skipped the session bootstrap). Pass `company_id` to every call below when the
user has more than one company.

Establish scope with the operator before doing anything expensive:

- **Optimise fresh, or roll over the current period?** Ask first — it decides the
  whole flow. "Should I start the new timetable from scratch, or copy your current
  period and adjust it?" If they want to copy, go to **Step 0b (rollover)**; the
  forecast/optimise steps below are for the from-scratch path.
- **Which new billing period** are we planning for? Call
  `find_billing_periods({ company_id })` and have them pick the target period
  (`id | name | active`). Capture its **start and end dates** — they bound Session
  materialisation and the required-count maths below.
- **Holidays / region.** Note the company's region; the regional holiday calendar
  (plus any company-specific closures) removes dates from the period. You need it
  both to materialise Sessions correctly and to compute how many Sessions each
  weekday can actually deliver.
- **Which classes / programmes** go in the timetable? Either they list them, or
  call `find_courses({ company_id })` and confirm the set of Programmes whose
  classes should be scheduled. Capture each class's required **programme skill**,
  **duration**, **capacity**, and any **required Session count** (some clients buy a
  fixed number, e.g. 13, that must fit in the period).
- **What's the weekly grid?** Ask for the planning window — which weekdays, what
  start/end time of day, and slot granularity. **Default to 15-min slots**: real
  durations are often 45/60 min and starts fall on :15/:45, which a 30-min grid
  can't represent. Call `list_schedule_patterns` to confirm valid weekday / time
  formats. Weekdays must be 3-letter lowercase.

### Step 0b — Rollover (only if they're copying the current period)

Most operators rebuild a period by copying the last one and changing a little. Three
strategies, all calling `build_timetable({ mode: "rollover", rollover: {...} })`:

1. **Which source period?** If they didn't name one, **ask** — don't assume. Pass it
   as `source_billing_period_id`.
2. **Pick the strategy:**
   - **`as_is`** — copy every class unchanged. The tool still *re-validates* against
     the new period (holidays differ, a trainer may have left), so surface any flags.
   - **`progression`** — each course advances one level (Wed 09:00 "Mini 1" → "Mini
     2"), keeping its slot, room and trainer. **You cannot infer the hierarchy** —
     ask the operator to specify the mapping (old course → new course, with the new
     demand/capacity). Pass it as `progression_map`.
   - **`edits`** — copy as-is, then apply a short list of manual tweaks ("swap Anna
     and Petra", "move Tuesday ballet to Thursday"). Translate each into an `edits`
     entry (`swap_trainer` / `swap_slot` / `move`).
3. **Read the result.** The tool clones, applies the strategy, then runs the **same
   validator** as the optimise path. For `progression` especially, expect flags — a
   remap silently assumes the new course still fits the old slot/room/trainer, which
   often breaks: the advanced level may outgrow its room (capacity), or the kept
   trainer may not be qualified for the new course. The tool repairs what it can
   (re-placing only the flagged rows) and returns anything it can't as
   `needs_action`. Present flags and `needs_action` plainly and offer fixes (e.g.
   "Toddler Movement has no qualified trainer — assign one or pick a different
   course"). Then jump to **Step 4** (review) — rollover skips forecasting.

If they chose rollover, skip Steps 1–3 (you only need resources/forecast for the
from-scratch path) unless a repair needs data you don't yet have.

### Step 1 — Gather resources (the find_* tools)

Resolve the three resource sets the optimiser needs. Do this once, up front.

- **Trainers:** `find_trainers({ company_id })` (add `course_id`/`place_id` filters
  if the operator scopes it). For each you need their **skills** (qualification) and
  their **availability** — but availability arrives in four shapes, all of which map
  to one list of rules (`polarity` = allow / block / prefer, with an optional
  `programme` scope):

  | What you find | How to capture it |
  | --- | --- |
  | An availability export with `available = 0` rows | `block` windows (invert against the working day) |
  | Rows with `available = 1`, sometimes `name = "babies – 3m"` | `allow` windows, course-scoped via `programme` |
  | A free-text note ("only mornings", "not Mondays") | parse into `allow`/`block`/`prefer` windows |
  | **Nothing set up at all** (very common) | infer from history and confirm — see below |

  Semantics to keep straight: `block` always wins; if a trainer has *any* `allow`
  rule it becomes a whitelist (available only inside the allows); a course-scoped
  `allow` grants only that programme — which is exactly how you encode "John only
  teaches X, only mornings".

  **When a trainer has no availability configured (the common case), don't silently
  assume open-by-default.** Look at what they actually taught in the *current* period
  (`find_events` over it), derive their implied availability from those realised
  slots, show it back, and **ask**: "Martina has no availability set — last period she
  taught Mon/Wed afternoons. Use that as her availability, or is something different
  this term?" Only fall back to fully-open if the operator says so. This turns a silent
  assumption into a confirmed input.
- **Rooms / venues:** `find_places({ company_id })` — rooms come inlined with
  capacities. Capture each room's **capacity** and **available slots**. Also ask
  about **venue × class capacity reductions** — "this room only holds N for *that*
  class" (floor space, safety ratio); capture these as `capacity_overrides`. Capacity
  is a property of the Class/schedule, reduced per venue — not a Programme attribute.
- **Continuity (optional but valuable):** for each returning class, note which
  trainer taught it last period (so the solver can keep cohorts with their
  trainer). `find_events` over the *previous* period reveals this.

Render what you gathered as compact tables and let the operator correct it. Wrong
availability or capacity in → wrong timetable out, so this confirmation matters.

### Step 1b — Collect client time rules (optional, per class)

Some classes have real-world timing limits the data can't infer and the operator
knows by heart: *"the 3–6-month baby class has to be mornings, before their midday
sleep"*, *"1st-grade language can't start before 13:00 — they're still at school"*,
*"toddlers only on weekdays, never after 17:00"*. **Proactively ask** whether any
class has such a constraint; it's optional, so most classes won't.

Translate each plain-language rule into the class's `time_rules` object (passed in
Step 3):

| Operator says | `time_rules` |
| --- | --- |
| "no earlier than 13:00" | `{ earliest_start: "13:00" }` |
| "must be done by 11:00" | `{ latest_end: "11:00" }` |
| "mornings only, finish by 11" | `{ windows: [{ from: "09:00", to: "11:00" }] }` |
| "only Mon and Wed" | `{ allowed_days: ["mon","wed"] }` |
| "Saturdays 9–11 only" | `{ windows: [{ days: ["sat"], from: "09:00", to: "11:00" }] }` |
| "we'd *prefer* mornings but it's not a hard rule" | add `hard: false` (becomes a preference, not a restriction) |

Keep the operator's own wording in `note` so the constraint is traceable later.
Default is `hard: true` (a real restriction — the class cannot be placed outside
the window). Use `hard: false` only when the operator explicitly says it's a
preference. A class with no rule is unconstrained in time.

### Step 2 — Forecast demand

Call `predict_demand` with the class set, the grid, and `lookback_periods`
(default 1). It returns, per class:

- `expected_enrolment` — feeds the room-capacity test.
- `pref[slot]` — the desirability score per grid slot, learned from history.
- a `confidence` / history note.

Render a short summary: expected enrolment per class and each class's top 2–3
historical slots. **Surface every warning** — especially brand-new classes with no
history (the forecaster falls back to a programme-level or flat prior; tell the
operator those placements are guesses, not history).

If the operator disagrees with a forecast number (e.g. "Swim Squad will be bigger
this year, we've been advertising"), let them override `expected_enrolment` or nudge
`pref` before optimising.

### Step 3 — Optimise

Call `build_timetable` with:

- `grid` from Step 0,
- `period` from Step 0 (`start_date`, `end_date`, `region`/`holidays`) — drives the
  deliverable-Session maths and Session materialisation,
- `classes` (each with `programme_skill`, `duration_minutes`, `demand`, `capacity`
  and `pref` from Step 2, plus `preferred_trainer_id` for continuity, `locked_slot`
  for any class the operator wants pinned, `sessions_required` for any class with a
  fixed Session count, and `time_rules` from Step 1b for any timing constraint),
- `trainers` (with their `availability` rules), `rooms`, and `capacity_overrides`
  from Step 1,
- optional `weights` (continuity bonus, compactness penalty) — defaults are fine
  unless the operator has a clear preference like "minimise how many days each
  trainer comes in",
- `allow_drops` — default `false` (full timetable or a diagnosis); set `true` only
  if the operator says "schedule what you can, tell me what doesn't fit".

Read the result:

- **`status: optimal | feasible`** → render the draft timetable as a **weekly grid** —
  days across the top (Mon–Sun, or just the planning weekdays), time down the left,
  one row per grid step — the way the Zooza calendar shows it. This is a markdown
  table laid out as a week, not an HTML/image artifact.

  ```
  | Time | Mon | Tue | Wed | Thu | Fri |
  | --- | --- | --- | --- | --- | --- |
  | 15:30 | **Ballet Mini**<br>Studio B · Jana |  | **Swim Squad**<br>Pool · Peter |  |  |
  | 16:30 |  | **Hip Hop**<br>Studio A · Mia |  |  |  |
  ```

  Rows span from the earliest start to the latest end on the grid step; drop each
  class tile in its slot — bold class name + room · trainer. Beneath the grid add a
  one-line **utilisation read-out** per trainer (classes count, distinct days) and per
  room so the operator can sanity-check load and compactness, and surface the per-slot
  **historical score** as a footnote rather than a column. Flag any continuity that
  was *broken* (a returning class that did *not* keep its previous trainer) so it's a
  conscious choice.

  **Rollover comparison.** When the draft is a rollover (a copy of the current
  period), the operator wants to see *what changed*, not re-read identical slots.
  Render the proposed period as the grid above and add a per-season caption carrying
  what differs — e.g. _Current period: 12 classes · {date range}_ / _Proposed
  (rollover, not created): 12 classes · {new date range}_ — then call out moved /
  dropped / added classes explicitly (from the validator's diff). Do **not** dump two
  full date-lists side by side.

- **`status: infeasible`** (with `allow_drops: false`) → do **not** dump a bare
  failure. Read `diagnosis` and explain the binding constraint in plain language:
  *"There's no way to place Swim Squad — no trainer who can teach swim is free in
  any pool slot. Options: widen Peter's Tue–Thu availability, open another pool
  slot, or let me schedule everything else and leave Swim Squad for you to place
  manually (I can re-run with drops allowed)."* Then offer to adjust an input and
  re-optimise, or re-run with `allow_drops: true`.

### Step 4 — Review and adjust (loop)

The first draft is a proposal, not a decree. Common operator reactions and how to
handle them:

- *"Move X to a different day"* → add a `locked_slot` for X (or a forbidden slot)
  and re-run `build_timetable`. Re-rendering the full grid each time so they see
  the knock-on effects.
- *"Trainer Y is doing too much"* → lower Y's `max_classes` and re-run.
- *"Keep it closer to last year"* → raise `continuity_bonus`, or lock the slots
  that should stay put, and re-run.
- *"Fewer trips to the studio for everyone"* → raise `compactness_per_day` and
  re-run.

Each adjustment is a cheap re-solve. Iterate until the operator is happy with the
whole grid.

### Step 5 — Hand off the approved overview

`build_timetable` writes nothing, and **neither does this skill**. The deliverable
is the approved **overview** — the table of rows (weekday · start · room · trainer ·
class · deliverable-session count). Your job ends at producing a clean, conflict-free
overview the operator is happy with.

Once they approve, hand the overview to the separate **`create_classes_from_timetable`**
tool, which turns each row into a real Zooza Class (and from it the Sessions). That
tool is **not built yet** — until it exists, present the final overview clearly (a
table they can act on), confirm it's signed off, and tell them the creation step is a
separate action. Do **not** call `commit_class` from here; class creation is out of
this skill's scope.

If the operator asks you to actually create the classes now and the creation tool
isn't available, say so plainly and offer the overview as the hand-off artefact
rather than improvising writes.

## Rules and gotchas

- **Ask optimise-vs-rollover first.** It changes the whole flow. Don't forecast from
  scratch if the operator just wants last period copied with two swaps.
- **Two stages, in order (optimise path).** Forecast (`predict_demand`) → build
  (`build_timetable`). Never merge or reorder them.
- **Confirm resources before solving.** The solver is only as good as the trainer
  availability, room capacity and skills you feed it. Get those confirmed in
  Step 1; a wrong availability silently produces a wrong (but conflict-free)
  timetable.
- **You produce an overview, never classes.** `build_timetable` writes nothing and
  neither do you — nothing exists in Zooza until the separate
  `create_classes_from_timetable` tool runs (not built yet). Say so, so the operator
  feels safe iterating, and never reach for `commit_class` from this skill.
- **Rollover still validates.** A copy isn't automatically valid for the new period —
  holidays move, trainers leave, a progressed course outgrows its room. Always show
  the validator's flags and `needs_action`, even for an "as-is" copy.
- **Infeasible ≠ error.** Treat infeasibility as information: name the bottleneck
  and offer concrete fixes or `allow_drops`.
- **A too-tight time rule is a common cause of infeasibility.** If a hard
  `time_rules` window leaves a class no feasible (slot × qualified trainer × room),
  say so plainly and offer to relax it — widen the window, switch it to `hard:
  false`, or free up a trainer/room in that window — rather than just reporting
  "infeasible".
- **Required Session counts interact with holidays.** A class needing N Sessions
  can only go on a weekday that has ≥ N usable dates left after holidays and
  absences. If a holiday-heavy weekday falls short, the class is silently barred
  from it; if *no* weekday qualifies, explain the shortfall (e.g. "needs 14, the
  best weekday delivers 13 after the two November holidays") and offer to reduce the
  count, extend the period, or run a second weekly slot.
- **Capacity lives on the Class, reduced per venue.** Effective seats =
  min(room capacity, venue×class override, class capacity). If an override drops a
  room below a class's demand, that room simply drops out for the class — surface it
  so the operator understands why a class moved venues.
- **No availability configured is normal.** Many companies never set it up; treat
  those trainers as open by default (or infer from history) and tell the operator,
  rather than blocking on missing data.
- **Brand-new classes have no history.** Their `pref`/`demand` are priors, not
  facts — flag them and invite overrides.
- **This sets the weekly pattern only.** Holiday skips, exact session dates and
  billing alignment are handled later, by the separate creation tool — not here.
- **Big catalogues.** Forecasting every class may mean many history calls; if it's
  slow, scope to the programmes the operator actually cares about this period.
- **Customer language.** These are activity brands (dance / swim / language / music
  schools), not "studios" generically. Mirror the operator's vertical.
