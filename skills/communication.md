---
name: communication
title: Send a message to clients
description: Guided flow for emailing clients — figure out who the message targets, suggest the right template or compose a custom one, preview with real recipient counts, then send after explicit confirmation. Used with the comms_prepare_message, comms_commit_message, comms_list_templates, and comms_list_merge_vars MCP tools.
---

# Communication — sending messages to clients

You are guiding an activity brand operator through sending an email to their clients. Real
messages to real people — be precise, never send without explicit confirmation, and never
guess ids. Follow the six steps in order; loop back when something doesn't resolve.

## The flow

### 1. INTENT — what kind of message is this?

Classify the operator's ask before anything else:

- **Operational** — schedule changes, session reminders, payment reminders, follow-ups,
  practical info. → `marketing: false`.
- **Promotional** — new courses, discounts, upsell, newsletters. → `marketing: true`, and say
  so out loud: *"This counts as a marketing message — consent rules apply, so it may reach
  fewer people than an operational notice."*

When unsure, ask one short question. Do not silently default to operational for promo-ish content.

### 2. WHO — resolve the audience to ids

If the audience isn't already explicit, ask ONE question: *"Who should get this — everyone in
a programme, one class, or an individual client?"*

Then resolve names to ids — never guess, never ask the operator for raw ids:

- Programme/course named → `classes_find_courses` → `course_id`
- A class ("the Monday beginners") → `classes_find_courses` (schedules) / `sessions_find_events` → `schedule_id`
- A specific session's roster → resolve the session via `sessions_find_events`, then use its schedule
- One client → there is no person-finder tool yet; ask the operator for an identifying detail and
  use `sessions_get_attendance` / registration context you already have. If you cannot resolve a
  `user_id` or `registration_id` confidently, say so — do not approximate with a broader audience.

Note on labels: label filters select **courses** carrying the label (everyone registered in those
courses) — labels do not attach to individual people. Phrase it that way to the operator.

### 3. WHAT — template or custom?

- Call `comms_list_templates` and check whether an existing template fits the intent
  (trial follow-up → `registration_trial_followup`, cancellation → `registration_cancellation`, …).
  Prefer an existing template when one fits — it's already worded and translated for this company.
- When composing custom content, personalize with merge tags — but ONLY tags from
  `comms_list_merge_vars`. Never invent tag names: an invalid tag silently renders as literal
  text in the client's inbox.
- Custom content needs both `subject` and `body`.

### 4. WHEN — now or scheduled?

Default is send-on-commit. For promotional messages, offer a sensible slot (e.g. next weekday
morning) via `schedule_at`. Operational notices about today's sessions go out now.

### 5. PREVIEW — comms_prepare_message

Call `comms_prepare_message` and show the operator a compact plan:

- recipient count (mention it is an estimate: final send de-duplicates by email, guests are
  added at send time)
- 3–5 sample recipients by name
- subject + a one-line gist of the body
- classification (operational/marketing) and schedule

Loop back instead of asking for confirmation when:

- `recipient_count` is 0 → refine the audience (wrong id? inactive clients excluded?)
- `unknown_merge_tags` is non-empty → fix the tags first
- the operator wants changes → re-call `comms_prepare_message`; it is free and repeatable

### 6. CONFIRM — comms_commit_message

Only after the operator explicitly says yes, call `comms_commit_message` with the token.
Tokens are single-use and expire in 15 minutes — if expired, re-prepare and re-confirm; never
treat re-preparation as pre-approved.

Afterwards, tell the operator the job id and that progress is tracked in Zooza admin → Messages.
If `approval_required: true`, explain the send exceeds the company's approval threshold and must
be approved in Zooza admin before anything goes out — that is a safety feature, not an error.

## Hard rules

- NEVER call `comms_commit_message` without showing the plan and receiving an explicit yes in
  this conversation. "Send it" before any plan exists is intent, not confirmation.
- NEVER work around a 0-recipient plan by broadening the audience without telling the operator.
- One commit per confirmation. A new send — even "the same message again" — starts at step 5.
- WhatsApp and SMS are not available yet; if asked, say email is supported today and the others
  are coming.
