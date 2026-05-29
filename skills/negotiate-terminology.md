---
name: negotiate-terminology
title: Set up my vocabulary
description: Use when the user is new to Zooza MCP, says "you're using the wrong words", or runs /zooza-setup. Conducts a short vocabulary interview and saves a personalised terminology profile to Claude memory.
---

# Skill: negotiate_terminology

## Purpose

Build a personalised terminology profile for this Zooza user.
Every studio uses its own vocabulary — Slovak dance studios say "hodiny" and "skupiny",
Czech language schools say "kurzy" and "lekce". This skill collects that vocabulary once
and persists it to Claude memory so every future session starts with the right words.

Run this once. The profile persists forever.

## When to use

- User is new to Zooza MCP (first session, no profile in memory)
- User says "you're using the wrong words", "I call it X not Y", or similar
- User runs `/zooza-setup`
- No Zooza terminology profile found in recalled memories

## Flow

### Step 1 — Load the interview template

Call `negotiate_terminology({ action: "start" })`.
The tool returns 8 interview objects — each with `concept`, `zooza_canonical`,
`description`, and example answers in multiple languages. Use these as your script.

### Step 2 — Conduct the interview conversationally

Ask the 8 questions one at a time, in the user's language. Do NOT present them as a form.
Adapt the question to context:

- For locale: "Which language does your studio primarily use?" (SK / CZ / EN / …)
- For programme: "What do you call the top-level activity — the thing that has a price and schedule?"
- For class: "And the specific group within that — the Monday group, the Wednesday group?"
- For session: "What about a single meeting — one instance of that group?"
- For booking: "When a client signs up for a class, what do you call that?"
- For trainer: "The person who leads the sessions — what do you call them?"
- For billing_period: "The timeframe that groups your billing — semester, season, term?"
- For client: "The person with the account — the parent, the student, the customer?"

Accept any reasonable answer. Move on quickly — this should take < 3 minutes total.

### Step 3 — Build the profile

After all 8 answers, call:

```
negotiate_terminology({
  action: "build",
  answers: {
    locale: "<locale code>",
    programme_term: "<their word>",
    class_term: "<their word>",
    session_term: "<their word>",
    booking_term: "<their word>",
    trainer_term: "<their word>",
    billing_period_term: "<their word>",
    client_term: "<their word>"
  }
})
```

### Step 4 — Show a summary

Tell the user:

> "Got it — I'll remember that you call programmes '**{programme_term}**',
> classes '**{class_term}**', sessions '**{session_term}**', and so on.
> Saving now…"

### Step 5 — Save the profile

Execute the `/remember` instruction at the end of the tool response verbatim.
After saving, confirm:

> "Done. I'll use your vocabulary from now on — no need to set this up again."

## Rules

- **Never correct the user's terminology.** Accept it unconditionally and map it.
- If they give a term Zooza already knows (e.g. "session" for session), it maps
  to itself — `resolved_from: "synonym"`.
- If they give an unusual term not in the glossary (e.g. "sezóna" for billing period),
  it is stored as `resolved_from: "custom"` — not an error, just a custom label.
- Keep the interview conversational. One question at a time. No numbered lists visible
  to the user. No jargon.
- The entire interview takes < 3 minutes. Don't over-explain Zooza concepts.
- If the user skips a question or says "same as you", use the Zooza canonical term
  for that concept and note `resolved_from: "synonym"`.
