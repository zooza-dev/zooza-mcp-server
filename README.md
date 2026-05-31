<p align="center">
  <img src="https://www.zooza.online/wp-content/uploads/2025/02/zooza-logo.png" alt="Zooza" width="200" />
</p>

<h1 align="center">Zooza MCP Server</h1>

<p align="center">
  <strong>Your entire activity business — one conversation.</strong><br/>
  AI-powered operations for dance schools, language academies, STEAM programmes,<br/>
  sports clubs, baby classes, camps, movement classes, and franchise networks.
</p>

<p align="center">
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-6366f1?style=flat-square" alt="MCP compatible"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT License"/></a>
  <a href="https://zooza.online"><img src="https://img.shields.io/badge/Zooza-official-f97316?style=flat-square" alt="Official"/></a>
  <a href="https://mcp.zooza.app/mcp"><img src="https://img.shields.io/badge/endpoint-live-22c55e?style=flat-square" alt="Live endpoint"/></a>
</p>

<p align="center">
  <a href="https://zooza.online">Website</a> ·
  <a href="https://help.zooza.online">Documentation</a> ·
  <a href="#connect-in-2-minutes">Quickstart</a> ·
  <a href="#available-tools">Tools</a>
</p>

---

## Stop managing your activity business from 6 different screens

Running a dance school, language academy, STEAM programme, sports club, baby class, summer camp, or multi-site franchise means constantly switching between your scheduling tool, your booking list, your attendance tracker, your payment dashboard — and still missing things.

**Zooza MCP connects Claude directly to your Zooza account.** Ask Claude to create next term's timetable, check who hasn't paid, find a trainer's availability, or preview a full schedule before it goes live — all in one conversation, with no dashboard hunting.

> **Zooza serves 500,000+ learners across activity businesses worldwide** — from single-location baby class providers to international franchise networks running dance, language, STEAM, sports, and movement programmes. This MCP server brings the same platform to any AI client that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## What you can do

### Build a term from scratch
```
"Create a new Spanish for beginners course for Spring 2026 at the city centre location.
 Classes every Tuesday 16:00–17:00 for 12 weeks, starting 3 March.
 Assign trainer Tomáš Novák and preview the full schedule before I confirm."
```

```
"Set up our summer robotics camp — Monday to Friday, 9:00–13:00, for 4 weeks in July.
 Split into two age groups: 6–9 and 10–14. Preview both before I confirm."
```

### Get instant answers
```
"Which programmes are running this billing period?"
"Who's teaching dance on Monday evenings?"
"What locations do we have available?"
"Show me all open registrations for the Saturday baby movement class."
"Which STEAM courses still have free capacity this term?"
```

### Manage bookings and payments
```
"Show unpaid registrations from this season."
"Which clients are on the waiting list for Saturday gymnastics?"
"List all billing periods for the Bratislava company."
"How many spots are left in the beginner English course?"
```

No clicking through menus. No switching tabs. Just ask — Claude handles the lookups, previews, and confirmations.

---

## Supported clients

| Client | How to connect |
|---|---|
| [Claude Desktop](https://claude.ai/download) | Native MCP over HTTPS |
| [Claude Code](https://claude.ai/code) | Plugin zip or manual `.mcp.json` |
| Any MCP-compatible client | Streamable HTTP — `https://mcp.zooza.app/mcp` |

---

## Connect in 2 minutes

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zooza": {
      "type": "http",
      "url": "https://mcp.zooza.app/mcp"
    }
  }
}
```

File location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop. On first use, you'll be prompted to sign in to your Zooza account — no API keys, no setup, just your existing login.

### Claude Code

Download the latest `zooza-plugin-*.zip` from [Releases](../../releases) and run:

```
/install-plugin zooza-plugin-*.zip
```

The plugin includes the MCP connection config and guided workflow skills for activity management.

---

## How it works

```
You → Claude → Zooza MCP Server → Zooza API → Your data
```

The MCP server is **stateless and hosted by Zooza** at `mcp.zooza.app`. You don't run anything locally. Every request is authenticated against your Zooza account — Claude can only see and change what you're already allowed to access in the dashboard.

**Multi-location and franchise accounts:** Claude will ask which location to operate on at the start of each session. You can switch mid-conversation — useful for comparing across sites or managing a network.

---

## Available tools

9 tools covering the core operations of a children's activity business:

| Tool | What it does |
|---|---|
| `whoami` | Identify the connected user and list accessible companies/locations |
| `find_courses` | Search programmes by billing period, name, or status |
| `find_billing_periods` | List billing periods (seasons/terms) for a company |
| `find_trainers` | List trainers available at a location |
| `find_places` | List rooms and locations for a company |
| `preview_schedule` | Preview a recurring class schedule before committing |
| `preview_events` | Preview individual sessions across a date range |
| `commit_class` | Create a class with a full recurring session schedule |
| `get_skill` | Load a guided playbook for multi-step workflows |

---

## Skills — guided activity workflows

Skills teach Claude how to combine tools correctly for real operational scenarios. Claude loads the right skill automatically when it detects a matching request — no need to invoke them manually.

| Skill | What it handles |
|---|---|
| `class-management` | Full guided flow: interview → schedule preview → confirmation. Use this when creating any new class with recurring sessions. |

**Coming next:** `cancel_day` · `mark_attendance` · `transfer_booking` · `initiate_refund`

---

## Security

- **TLS** on all traffic between your AI client and `mcp.zooza.app`
- **OAuth 2.0** — Claude receives a scoped token tied to your Zooza identity, not your password
- **Permission inheritance** — Claude can only do what your Zooza account allows
- **No conversation storage** — the MCP server is stateless; your prompts are not logged

> **Note on prompt injection:** As with any AI integration, be cautious about AI-readable content in your Zooza data (e.g. programme names) that could attempt to influence Claude's behaviour. All write operations require explicit confirmation before anything is committed.

---

## What Zooza is

[Zooza](https://zooza.online) is an end-to-end management platform built for children's activity and education businesses:

**Dance & movement** — dance academies, gymnastics, baby movement, yoga for kids  
**Language & education** — language schools, tutoring centres, STEAM / robotics / coding  
**Sports** — martial arts, swimming, tennis academies, sports franchises  
**Camps & seasonal** — summer camps, holiday programmes, weekend workshops  
**Fitness & wellness** — fitness studios, pilates, baby & toddler classes  

All running on one platform, from a single location to an international franchise network.

It handles the full operational lifecycle: **programme setup, class scheduling, client bookings and registrations, attendance tracking, payment management, parent communication, and multi-location reporting** — all in one system, designed to scale from a single location to an international franchise network.

Zooza MCP extends this platform to AI. Instead of clicking through dashboards, your team — from activity managers to franchise operators — can operate Zooza through natural conversation using Claude or any AI client that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Roadmap

| Tool | What it will do |
|---|---|
| `cancel_day` | Cancel all classes on a date with optional parent notifications |
| `mark_attendance` | Record attendance for a session |
| `transfer_booking` | Move a client from one class to another |
| `initiate_refund` | Prepare and confirm a credit or refund |
| Reporting tools | Revenue summaries, attendance rates, capacity utilisation |
| Communication tools | Send templated messages to parents and registered clients |

---

## For developers

<details>
<summary>Local development setup</summary>

### Run locally

```bash
git clone https://github.com/zooza-dev/zooza-mcp-server
cd zooza-mcp-server
npm install
cp .env.example .env   # fill in credentials
npm run dev            # http://localhost:3001/mcp
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ZOOZA_API_BASE` | yes | Zooza API base URL (e.g. `http://php-server/v1`) |
| `ZOOZA_API_KEY` | yes | Server-wide API key for the MCP integration |
| `MCP_RESOURCE_URL` | prod | Public URL of this MCP server |
| `MCP_AUTH_SERVER_URL` | prod | Zooza OAuth server base URL |
| `PORT` | no | HTTP port (default `3001`) |
| `ZOOZA_ALLOW_HARDCODED_AUTH` | dev only | Set `true` to skip JWT validation locally |
| `ZOOZA_API_TOKEN` | dev only | Dev-fallback token (only with hardcoded auth enabled) |
| `AUDIT_LOG_PATH` | no | Per-tool-call JSONL audit log path (default `logs/audit.log`) |

### Smoke test

```bash
curl -sS http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Debug bookend workflow

Every tool invocation appends one JSON line to `logs/audit.log` (or whatever
`AUDIT_LOG_PATH` points at). Each entry carries `request_id`, `tool`, `args`,
`outcome`, `result`-or-`error`, and `duration_ms` — enough to reconstruct
what the server saw without scraping container logs.

When you're testing a tool and want Claude to inspect what happened inside the
server, use this bookend pattern:

1. **You:** "I'm about to call `find_events`."
2. **Claude** marks a watermark — `wc -l logs/audit.log`.
3. **You** run the tool from your MCP client.
4. **You:** "done."
5. **Claude** reads the lines past the watermark and reports tool name, args,
   outcome, duration, and any error — no extra MCP tool, no log shipping
   required.

The same JSONL stream is the on-disk bridge for a future log forwarder to
ship into a central observability system.

### Architecture

```
Claude (any MCP client)
    │  Streamable HTTP over TLS
    ▼
mcp.zooza.app  (Node.js / TypeScript)
    │  OAuth 2.0 JWT validation
    ▼
Zooza API  (your data, your rules)
```

</details>

---

## Support

**[help.zooza.online](https://help.zooza.online)** — Full documentation  
**[zooza.online](https://zooza.online)** — Platform website  
**[hello@zooza.online](mailto:hello@zooza.online)** — Get in touch

---

<p align="center">
  Built by <a href="https://zooza.online">Zooza</a> — the platform that keeps children's activity businesses running.
</p>

