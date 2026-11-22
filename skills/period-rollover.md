---
name: period-rollover
title: Start a new term (billing-period rollover)
description: Guided flow for "start the new term / semester / season" — create the new billing period, then copy the previous period's classes into it with new sessions (holidays decided by the operator), the same blocks and the enrolled clients, in chunks of up to 25, with programme progression (Tots 1 → Tots 2). Uses classes_add_billing_period, classes_show_copy_progress and classes_copy_class.
---

# Start a new term — billing-period rollover

When the operator says **"start the new term"**, "set up Spring 2027", "roll over to autumn",
"copy the groups into next semester", "same classes, new dates, same kids" or similar, they almost
always mean this:

1. create a new **billing period** (the named date range their classes belong to);
2. copy the classes of the **previous** billing period into it. Each copy gets new sessions that
   respect holidays, keeps its blocks, and takes the enrolled clients with it.

Some classes move up a programme on the way, e.g. Tots 1 → Tots 2.

This is the biggest write an operator does all year, often 300 classes. Go slowly at the start and
fast at the end: settle the big questions once, then copy chunk after chunk with only the exceptions
discussed.

All three rollover tools are **dispatch-only**: `classes_add_billing_period`,
`classes_show_copy_progress` and `classes_copy_class`. Reach each one with
`get_tool_schema(name)` once, then `call_tool(name, arguments)`. They exist and they work. Never send
the operator to the Zooza app for this.

## Hard rules

- **Never pick the entity from the word.** "Term", "semester", "season", "block", "course", "level"
  and "group" mean different things to different activity brands. Resolve them against this
  company's data (step 0). Never resolve them from the dictionary alone.
- **Never apply without the operator seeing the preview's `scope` sentence.** Show it exactly as
  returned, not paraphrased, then wait for an explicit yes. The one exception: a `retryable: true`
  class, re-applied once with the settings the operator already approved (step 8).
- **Nothing is emailed.** The copy never notifies clients or instructors. Any announcement is a
  separate, later step that the operator approves (step 9).
- **Never repeat an apply that returned "outcome unknown"** ("Zooza did not confirm the copy").
  Check `classes_show_copy_progress` first. The copy may well have happened.
- **At most 25 classes per `classes_copy_class` call.** More than that is refused. Chunk them.
- **Do not show session grids for a batch.** For a single class the weekly grid is fine. For a
  chunk, show one row per class (step 7). This overrides the general "show sessions as a weekly
  grid" rule.

## Step 0 — Terminology gate (once)

Find out what the operator's words point at in *their* data before asking anything:

- `classes_find_resource` with `kind: "billing_period"` lists their billing periods, with names and
  dates. Names like "Winter 2026" or "2025/2026" tell you how they name periods.
- If the name they gave ("Spring 2027") already exists as a billing period, that is the target.
  **Say so in one line before anything else**, with its dates and how far the rollover has got, e.g.
  "Spring 2027 already exists (from 1 Feb 2027, no last day yet), with 12 of 16 classes copied.
  I'll continue with the rest." If it has no last day, ask for it (step 1). Then go to step 2.
- If their word could also be a **block** (a label grouping sessions inside one class), or a
  **programme**, and their data doesn't settle it, ask **once**, using their own period names. Do not
  ask "billing period or block?", because they don't use those words. Ask instead:

  > You have *Autumn 2026* (7 Sep – 18 Dec) and *Winter 2026* (5 Jan – 27 Mar) set up as periods.
  > Is *Spring 2027* a new one of those, coming after Winter 2026?

- "Move everyone up a level" is ambiguous three ways. It could be a rollover with progression, a
  move of clients between existing classes right now, or a renaming. Always ask: "into a new term,
  or right now within the current one?" Moving clients within the current period is **not** this
  skill: use `bookings_copy_booking`, one client at a time.

## Step 1 — The new billing period (once)

Ask for the **name**, the **first day** and the **last day**. Never infer the dates. Then call
`classes_add_billing_period`.

- If the result is `created: false`, a period with that name already exists, and it is returned.
  That is also how you resume a rollover started earlier. Say so, and use it.
- If the operator doesn't know the last day yet, the period can be created without one. Then the
  preview can't flag a class running past the term (it warns about this), so check each class's last
  session with them.
- Mention its warnings, such as overlaps with another period, but don't stop on them.

## Step 2 — Source period and the size of the job (once, then per chunk)

- The source is usually the latest period before the new one. **Confirm it**: "Copy from Winter 2026?"
- Call `classes_show_copy_progress` with `source_billing_period_id` and `target_billing_period_id`.
  It returns:
  - `totals`: the source classes, how many are already copied, how many are being copied right now
    (`in_progress`, never offer those again), how many remain, how many are excluded;
  - `remaining_chunks`: the remaining classes grouped (default by venue) into chunks of 25 or fewer;
  - `excluded`: lead pipelines, archived classes, classes of archived programmes, and classes with
    no sessions, each with a reason.

  Tell the operator in one or two lines, e.g. "Winter 2026 has 287 classes. 12 won't be copied
  (lead pipelines, archived, no sessions). That leaves 275, at 9 venues." Show `excluded` only on
  request, or if they ask about a class that's missing.
- More than 25 left: propose a grouping (venue, instructor, programme or weekday; pass `group_by`)
  and let them pick the first chunk. Offer the largest group first.
- Already started (`copied` > 0): say how far it has got, and continue with what is left. That is
  normal. Rollovers span days, and different people in the team may do parts of it.

## Step 3 — Session count and clients (once per rollover)

Ask both together, in plain words:

> How many sessions should each class have this term? The same as last term, or a set number?
> And should the clients who are enrolled now be carried over to the new classes?

- `session_count`: `"same_as_source"` or a number. "Same as last term" counts every session that was
  planned in the old class. Cancelled sessions count; the replacement sessions added for them don't.
  The preview shows `cancelled_sessions_in_source` per class, so a class whose count looks off can be
  corrected.
- `bookings`: `"enrolled"` carries clients whose booking is registered (pre-registered ones count
  too, and are copied as registered). `"none"` copies the classes empty. Waitlist, late, and trial
  bookings are never carried.
- If they carry clients, tell them once: **each copied client is charged the new class's price and
  registration fee** (on a pay-per-session programme, the registration fee only), with no payment plan. Plans are added afterwards (step 9). A client who needs a
  different price is handled afterwards, individually (see "Fixing things afterwards").

## Step 4 — Holidays (once per holiday)

Call `classes_copy_class` without a token for the first chunk. If any holiday hits a planned
session, the result is `status: "needs_decision"`. It lists each holiday with its dates and the
classes and dates it hits.

- Show them as a short list: name, dates, how many classes it hits. Ask per holiday:
  - **skip**: no session that day; one is added at the end, so the count stays the same;
  - **run as normal**;
  - **exchange**: move that session to another date the operator gives you, e.g. "Tuesday instead
    of the Wednesday holiday". Exchange is only for a **single-day** holiday. For a school break,
    offer skip or run.
- Never decide for them, not even for obvious public holidays. Skipping is their decision.
- If `notices` says a venue has **no region set**, the school breaks of **every** region are listed.
  Say so, and let them skip the ones that aren't theirs. Usually they say "run" for those.
- Overlapping holidays (a public holiday inside a school break) each need a decision. If they
  disagree, skip wins.
- Pass the answers as `holiday_decisions` and call again. Holidays are looked up per venue, so a
  later chunk may hit holidays not seen before. The result's `decided` echoes what is already
  settled: **pass it forward to every later chunk**, so the operator is asked only about new
  holidays.

## Step 5 — Progression (per chunk)

Ask: **"Does any of these move up to a different programme this term?"** Show the programmes in the
chunk (from the preview rows). Write down the answer as a from → to table, e.g.:

| Class | Now | Next term |
|---|---|---|
| Tuesday 16:00 | Tots 1 | Tots 2 |

Resolve the new programme with `classes_find_courses`. Pass it per class as `course_id`. A move
across pricing models or booking types comes back as a failed check in the preview; take it to the
operator.

## Step 6 — Sweeping changes (per chunk; default "same as before")

The default for everything is **"same as last term"**: name, instructor, venue, room, capacity,
price and online booking are cloned when you leave them out. Ask once: "Anything different this
term: an instructor, a venue, prices, capacity, a day or time?" From the second chunk on, offer
"same changes as the last chunk?"

Per class: `trainer_id`, `place_id`, `room_id`, `capacity`, `price`, `online_registration`, `name`,
`first_session_on` (moves the class to that weekday) and `time` (HH:MM). Resolve ids with
`classes_find_resource`. Never guess an id.

"The term starts in the first week of February" is the **chunk-level** `first_session_on`: no session
before that date, and every class keeps its own weekday. Only a per-class `first_session_on` moves a
class to another day.

**Block names cannot be changed in a copy.** Copied clients find their blocks again by name.

## Step 7 — The preview (per chunk)

Once every holiday is decided, `classes_copy_class` returns the preview from Zooza's own dry run.
Show it in this order:

1. **The `scope` sentence, exactly as returned**, e.g. "Copying 18 classes from billing period
   'Winter 2026' … into billing period 'Spring 2027' …: 216 sessions, 143 bookings (enrolled
   clients). Nobody is emailed."
2. **One row per class**: class | programme (→ new) | pattern | sessions (count, first – last) |
   blocks | clients | amount | flags.
3. **What needs a look.** Ask only about the flagged classes:
   - `ends_after_period`: the run goes past the period's last day. That's allowed; mention it.
   - `irregular_pattern`: the old dates followed no weekly pattern, so they were shifted as a whole.
     Ask them to check that class.
   - `irregular_extended_weekly`: the same, and sessions lost to skipped holidays were added a week
     apart after the last date, so the count is kept.
   - `irregular_made_weekly`: the old dates followed no pattern, and the operator asked for a set
     number of sessions, so the class now runs weekly on the weekday and time of its first old
     session. Mention it.
   - `blocks_extended`: more sessions than before; the extra ones take the last block.
   - `blocks_shortened`: fewer sessions than before, so a block lost sessions (the last ones are
     cut). Clients carried in that block get fewer sessions. Ask before applying.
   - `block_weekday_mix`: a block that was all one weekday now spans two, because holidays fell
     differently.
   - `cancelled_sessions_in_source: n`: the old class had cancelled sessions. Is the count right?
   - **failed checks**: e.g. capacity below the clients carried, a client already in the target, a
     programme change across pricing models. A class **already copied into this period** blocks the
     chunk. Drop it from the chunk, or, if a second copy is really intended, set
     `allow_repeat_copy: true` for that class.
4. The amounts are **indicative**: Zooza recomputes them as each class is copied. Say so once.

If the preview has no `token`, something must be fixed first. Fix or drop those classes and preview
again.

**`set_aside`**: classes left out of this copy, each with its reason (no sessions, no venue, a run
too long for the holidays looked up). The rest of the chunk is in the preview and can be applied.
Always list the set-aside classes and their reasons for the operator. Never leave one out silently.
To copy one with a different `session_count`, give it its own call.

## Step 8 — Apply (per chunk)

Only on an explicit yes to that preview: call `classes_copy_class` again with the `token` and
`confirmed: true`. Tokens are single-use and expire after 15 minutes. If it expired, preview again
and show the new preview.

The result has the `job_id`, a `status` (`queued` / `running` / `completed` / `failed`), and per
class the new class id, the clients copied and skipped, and the amount charged.

- **completed**: report the counts in one line per class, or a total for a big chunk.
- **queued / running**: Zooza is copying in the background (a large class, over 20 clients, is
  always queued, even on its own). Don't call apply again. In a minute, check
  `classes_show_copy_progress` with the `job_id`: it shows each class as done or failed, with the
  clients copied and the amount charged.
- **failed**: each class is all or nothing. A failed class has no half-made copy. Each failed class
  says `retryable`:
  - `retryable: true`: a temporary error (e.g. two copies running at once). The operator already
    approved this copy, so preview exactly those classes again with the same settings and apply
    once more **without asking again**. Then say in one line that it was retried, and the result.
  - `retryable: false`: the error needs the operator (capacity, a client already in the class, a
    programme change), or the class already failed twice. Read out why it failed and let them
    decide. Never repeat it unchanged.

Then call `classes_show_copy_progress` and **offer the next chunk**. Carry forward
`holiday_decisions` (from `decided`), `session_count`, `bookings` and any agreed sweeping changes.
Restate them in one line ("same holidays, 12 sessions, clients carried, Jana instead of Petra")
rather than asking again.

## Step 9 — Wrap-up (once, when nothing is left or the operator stops)

Say plainly:

- **Payment plans were not applied** to the copied clients. If they use instalments, they're added
  per class with `payments_add_plan`.
- **Nobody was emailed.** Offer to draft an announcement to the new term's clients with
  `comms_send_message`, using the new billing period as the audience, with their approval as usual.
- **Online booking** on each new class is the same as on the class it was copied from. Classes that
  were open for booking are open now.

## Fixing things afterwards

Sessions are low-stakes, so don't add questions to prevent every mistake. Fix them afterwards:

- A missed holiday, or a holiday decision they want to change, in specific sessions:
  `sessions_update` with those `event_ids`.
- A class's day, time, instructor or venue from a date on: `classes_update` with `session_scope`.
- One client's price or blocks: `bookings_copy_booking` (it can set a free or agreed amount, or
  specific blocks).
- A class copied by mistake: archive it with `classes_update` (`status: "archive"`), with the
  operator's approval as usual. Its copied clients stay booked in it; move or cancel them first if
  that matters.
