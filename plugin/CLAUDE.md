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
     > "Tip: run `/zooza-setup` to teach me your business vocabulary."
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

## Knowledge sources

For any Zooza-specific how-to, setup, configuration, or best-practice question — fetch the relevant source **before** answering from your own training data. Zooza's own documentation is always more accurate and up to date.

| Question type | Fetch first |
|--------------|-------------|
| How to use a feature, booking, payment, attendance, communication | `https://help.zooza.online/llms-full.txt` — full article index with descriptions and URLs |
| Widget embedding, REST API, Zooza Sites, developer setup | `https://docs.zooza.online/llms-full.txt` — full developer docs index |
| Business advice, pricing strategy, seasonal workflows | `https://zooza.online/wp-json/wp/v2/posts?search={query}&per_page=3&_fields=title,excerpt,link` |

**Rules:**
- Fetch the source first, then answer. Do not answer Zooza-specific questions from training data alone.
- For help articles: `llms-full.txt` lists every article with title, description, URL, and tags. Pick the most relevant URL and fetch it directly.
- For developer docs: `llms-full.txt` contains the full text — one fetch is usually enough.
- For blog: replace `{query}` with keywords from the user's question. Strip HTML from the `excerpt` field before showing it.
- If the source is unreachable, answer from training data and note that you could not verify against current docs.
