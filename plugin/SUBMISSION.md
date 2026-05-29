# Zooza — Submission Texts

Copy-paste ready texts for marketplace submissions.
Last updated: 2026-05-29

---

## A — Claude Code Plugin (community marketplace)

Submit at: **claude.ai/settings/plugins/submit**  
What to attach: zip from GitHub Release (tagged `plugin-v*`)  
Logo: `plugin/icon.png` (500×500 px, orange on white)

---

### Name

```
Zooza
```

### Tagline / Short description
*(~120 chars — displayed in plugin list)*

```
Manage Zooza classes, schedules, and bookings through natural conversation — for studios, schools, and activity brands.
```

### Long description
*(~400–600 words — shown on the plugin detail page)*

```
Zooza is a class management platform built for dance studios, music schools, language schools, children's activity providers, swim schools, sports clubs, camps, arts programmes, STEAM clubs, and multi-location franchise networks.

This plugin connects Claude Code and Cowork directly to your Zooza account — so you can create classes, check schedules, manage bookings, and explore your programmes without leaving your AI workspace.

**What you can do**

- Create a new class — guided step-by-step: pick a programme, set the venue, assign a trainer, define the session pattern, preview, and confirm
- Browse all your programmes and active groups across all locations
- Check which Zooza company you're working in and what your account can access
- Set up your studio's vocabulary once — teach Claude to say "hodina" instead of "session", "kurz" instead of "programme", and it remembers for future sessions
- Report bugs or request features directly from your Claude workspace

**Built-in guided skills**

The plugin ships with three skills that turn complex multi-step operations into a natural conversation:

- **Create a new class** (`/class-management`) — full interview flow from programme selection to commit
- **Set up my vocabulary** (`/zooza-setup`) — teach Claude your studio's terms
- **Send feedback** — report a bug or request a feature directly to the Zooza team

**Who it's for**

Any Zooza user who manages classes, bookings, or schedules — whether you run a single studio or a franchise network with dozens of locations. Works in English, Slovak, Czech, Hungarian, Romanian, and other languages Zooza supports.

**Requirements**

Active Zooza account (zooza.app). After installing the plugin, enable it and complete the OAuth connection to your Zooza company. The plugin connects to Zooza's MCP server at mcp.zooza.app — no credentials are stored in the plugin itself.

**Open source**

github.com/zooza-app/zooza-mcp
```

### Test prompts
*(3–5 prompts the reviewer will try — must work out of the box)*

```
Show me all my programmes and courses in Zooza.
```
```
I want to create a new Monday morning yoga class.
```
```
Who am I in Zooza and which company am I working in?
```
```
Set up my vocabulary — I call sessions "lessons" and programmes "courses".
```

### Repository URL

```
https://github.com/zooza-app/zooza-mcp
```

### Category suggestions
*(if the form asks)*

```
Productivity, Business Tools, Education
```

---

## B — MCP Server (Anthropic MCP directory / claude.ai remote MCP)

Submit at: TBD — Anthropic has not publicly opened MCP directory submissions yet.  
Track at: **modelcontextprotocol.io** or Anthropic announcements.  
Until then, users add it manually (see manual connection instructions below).

---

### Server name

```
Zooza
```

### Server URL

```
https://mcp.zooza.app/mcp
```

### Transport

```
Streamable HTTP (HTTP + SSE)
```

### Auth

```
OAuth 2.1 with PKCE
```

### Short description
*(1–2 sentences)*

```
Connect Claude to your Zooza account — create classes, manage schedules, track attendance, and handle bookings through natural conversation.
```

### Long description

```
The Zooza MCP server exposes Zooza's operational tools to any MCP-compatible AI client. Built for dance studios, music schools, language schools, children's activity providers, swim schools, sports clubs, camps, franchise networks, and STEAM programmes.

**Available tools**

| Tool | What it does |
|---|---|
| `whoami` | Identify your Zooza account and list available companies |
| `find_courses` | Search programmes and courses |
| `find_places` | List venues and locations |
| `find_trainers` | List trainers |
| `preview_schedule` | Preview session schedule before saving |
| `preview_events` | Show sessions in a date range |
| `commit_class` | Create and save a new class |
| `find_billing_periods` | Look up billing periods |
| `get_skill` | Load guided playbooks for complex operations |

**Built-in conversation starters (MCP Prompts)**

- "Show me all my programmes" — lists all active programmes with key details
- "Who am I & what can you do?" — account info + capability overview
- Skill-specific starters for class creation, vocabulary setup, feedback

**Skill layer**

Skills are guided playbooks delivered via `get_skill`. They teach Claude how to compose tools correctly — interview the user, validate inputs, preview before committing. The class-management skill, for example, handles: programme selection → venue → trainer → session pattern → schedule preview → commit.

**Multi-company support**

If your account has access to multiple Zooza companies (e.g. a franchise network), the server lists all available companies at session start and routes tool calls to the right one.

**Languages**

Works in any language Claude supports. Zooza data is returned in the language configured per company (Slovak, Czech, Hungarian, Romanian, English, etc.).
```

### Test prompts

```
Show me all my programmes and courses in Zooza.
```
```
Create a new class for me — Monday at 10am yoga, Bratislava studio.
```
```
Who am I in Zooza?
```

---

## C — Manual connection instructions
*(for your own website / help docs — until directories open)*

### For Claude.ai users (claude.ai → Settings → Integrations → Add MCP)

```
Name:      Zooza
URL:       https://mcp.zooza.app/mcp
Auth type: OAuth
```

After adding, Claude will prompt you to log in with your Zooza account.

### For Claude Code users

Download the plugin zip from:  
**github.com/zooza-app/zooza-mcp/releases**

Then install:
```bash
claude plugin install zooza-plugin-vX.Y.Z.zip
```

Or load a local copy for testing:
```bash
claude --plugin-dir ./plugin
```

---

## D — Screenshot guidance
*(for whoever prepares visuals)*

Screenshots should show **Claude Code or Cowork** (not the Zooza web app).  
Suggested shots (in order of priority):

| # | What to show | Prompt to use |
|---|---|---|
| 1 | Programme list | "Show me all my programmes" |
| 2 | Class creation interview | "I want to create a new Monday yoga class" |
| 3 | Schedule preview before commit | (continue the class creation flow to the preview step) |
| 4 | Vocabulary setup | "Set up my vocabulary — I call sessions lessons" |
| 5 | Whoami / capabilities | "Who am I in Zooza and what can you do?" |

Size: 1280×800 px minimum. PNG, no compression artifacts. No sensitive client data visible.
