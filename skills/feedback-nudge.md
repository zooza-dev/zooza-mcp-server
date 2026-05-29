---
name: feedback-nudge
title: Report feedback or a bug
description: Use after a write/commit tool succeeds (rate-limited via whoami.last_feedback_at, ~once per week) OR whenever the user explicitly asks to report a bug / file feedback / "tell the engineering team". Drafts an anonymized title+body, confirms with the user, then calls submit_feedback.
---

# Skill: feedback-nudge

## Purpose

Give Zooza MCP users a frictionless way to send feedback to the engineering team — either as a prefilled GitHub URL (for users with GitHub accounts) or as a private issue filed on their behalf (for non-technical users).

This skill controls **when** to offer feedback and **how** to draft + anonymize it. The actual filing is done by the `submit_feedback` tool.

## Triggers — when to offer proactively

1. **Successful write/commit + 7-day cool-off.** After a write/commit MCP tool returns success (e.g. `commit_class`, future `commit_refund`), AND `whoami.last_feedback_at` is `null` or more than 7 days ago. Phrase:

   > *"Glad that worked! Quick optional ask: any feedback for the engineering team while it's fresh?"*

2. **Explicit user intent.** Whenever the user says anything like:
   - "this is broken"
   - "I want to report this"
   - "can you tell the engineering team"
   - "this doesn't work"
   - "please log this as a bug"

   …even if the 7-day timer hasn't elapsed.

## Anti-triggers — never offer

- After read-only tool calls (`find_*`, `preview_*`, `whoami`, etc.).
- **After tool errors.** The user might already be frustrated; pushing for feedback adds friction. They'll ask if they want to.
- If the user has explicitly declined feedback earlier in this session.

## Flow when offering

### Step 1 — pick the path

Ask the user ONCE. The question is simply whether they have a GitHub account — that's the only thing that determines which path. Avoid the words "public"/"internal" in the user-facing question; they're confusing implementation detail.

Use this exact phrasing (or as close as possible) and render the two options as a multiple-choice question:

> *"Do you have a GitHub account? If yes, I'll prepare a prefilled issue link you can submit yourself. If no, I'll file it for you on the engineering team's repo."*

Option labels MUST be the user-friendly form:
- **"I have GitHub"** → `path: "github"`
- **"I don't have GitHub"** → `path: "internal"`

Do NOT label options as "GitHub (public)" / "Internal (private)" — that's the implementation detail leaking through. The user picks based on whether they have an account, not based on understanding the privacy mechanism.

### Step 2 — draft title + body

Compose a clear `title` (one line, summarizes the issue) and `body` (markdown, full feedback).

**For `path: "internal"`** — keep all the user's specifics. api-v1 records `user_id` and `company_id` from auth context.

**For `path: "github"`** — REWRITE to strip every identifier. Be aggressive:

| Original | Anonymized |
|----------|-----------|
| "Bratislava karate Tuesdays" | "a recurring class" |
| "John Novák from Studio Foo" | "a customer" |
| "Studio Foo" | "our studio" / "the company" |
| numeric IDs (course_id, registration_id, etc.) | "the class" / "the registration" |
| user emails | "the customer" |
| course/event/place names | "a class", "a session", "a venue" |

The `submit_feedback` tool runs a safety-net regex check and will reject the call if obvious identifiers (long numbers, emails) remain. Don't fight the check — anonymize properly upstream.

### Step 3 — confirm

Show the user the EXACT drafted `title` + `body` (and for `path: "github"`, mention the anonymization is irreversible — once submitted it's a public issue). Ask for explicit yes.

If the user wants edits, iterate before calling the tool.

### Step 4 — call submit_feedback

```
submit_feedback({
  path: "github" | "internal",
  title: "...",
  body: "...",
  category: "bug" | "feature_request" | "praise" | "other",  // optional but helpful
  related_tool: "create_class"   // optional, if feedback is about a specific MCP tool
})
```

### Step 5 — relay the result

- **`path: "github"`** — output the returned `url` to the user with a short prompt: *"Open this in your browser to file the issue. It's prefilled — you can edit before submitting."*
- **`path: "internal"`** — confirm the issue is filed: *"Filed as issue #{issue_number}. Engineering will follow up if needed. Thanks!"*

## Good output looks like

- Title is a one-line, search-friendly summary (e.g. "create_class fails silently on Tuesday-only recurring schedules")
- Body covers: what the user tried, what they expected, what happened, what state things are in now
- `category` is set when the issue is clearly bug / feature-request / praise
- `related_tool` is set when feedback is about a specific MCP tool

## Things to avoid

- Don't volunteer feedback when the user is in the middle of a complex flow — wait for it to finish.
- Don't paraphrase the user's words into nicer-sounding feedback; engineering values raw signal.
- Don't ask for the user's email — auth context already has it (for `path: "internal"`).
- Don't repeat the nudge in the same session if the user already declined.
