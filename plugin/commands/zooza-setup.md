---
description: One-time Zooza setup — teaches Claude your studio's vocabulary so it understands your terms in every future session.
argument-hint: ""
---

# /zooza-setup

Run the Zooza setup flow:

1. Call `whoami` to identify the user and their company.
2. Call `get_skill("negotiate-terminology")` to load the terminology interview playbook.
3. Conduct the terminology interview conversationally (8 questions, < 3 minutes).
4. Call `negotiate_terminology({ action: "build", answers: {...} })` with the collected answers.
5. Execute the `/remember` instruction from the tool response to save the profile to memory.

After setup, Claude will use the user's own vocabulary in every future Zooza session.
Only needs to be done once — the profile persists until the user asks to update it.
