# Zooza plugin — session startup

## Terminology profile check

At the start of every conversation where Zooza tools are used:

1. **Check memory for a Zooza terminology profile.**
   Look for "Zooza terminology profile" in recalled memories (it was saved with `/remember`).

2. **If a profile exists:**
   - Tell the user briefly:
     > "Working in Zooza — terminology profile loaded
     > (you call programmes '**{programme_term}**', sessions '**{session_term}**', ...)."
   - Use the profile `mappings` when interpreting user requests and calling tools.
     Translate the user's terms to Zooza canonical terms before passing them to tools.
     Example: user says "kurzy" → resolve to Programme before calling `find_courses`.

3. **If no profile exists:**
   - Mention once per session:
     > "Tip: run `/zooza-setup` to teach me your studio's vocabulary."
   - Fall back to Zooza canonical terms and the server-side terminology instructions.
     Do not block on missing profile — proceed with canonical terms.

## Applying the profile

When a profile is loaded, the `mappings` object contains entries like:

```json
{
  "programme": { "user_term": "kurz", "canonical_en": "Programme" },
  "session":   { "user_term": "hodina", "canonical_en": "Session" }
}
```

When the user says "kurz" → treat it as "Programme".
When the user says "hodina" → treat it as "Session".
Never correct the user. Always speak back in their terms.
