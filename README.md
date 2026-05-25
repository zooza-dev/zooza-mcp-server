# Zooza MCP Server

**Zooza MCP** is a cloud-based bridge between your Zooza account and AI assistants like Claude. It lets you manage programmes, classes, bookings, registrations, trainers, locations, payments, and reporting through natural conversation — without switching between dashboards.

> **Hosted endpoint:** `https://mcp.zooza.app/mcp`

---

## Supported clients

| Client | Connection type |
|---|---|
| [Claude Desktop](https://claude.ai/download) | Native MCP (HTTP) |
| [Claude Code](https://claude.ai/code) | Plugin or manual `.mcp.json` |
| Any MCP-compatible client | Streamable HTTP — `https://mcp.zooza.app/mcp` |

---

## Before you start

You need:
- An active **Zooza account** — [zooza.online](https://zooza.online)
- Access to at least one company/location in your Zooza workspace
- Claude Desktop, Claude Code, or another MCP-compatible client

No API keys to manage. Authentication is handled via OAuth — Claude will guide you through a one-time login on first use.

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

Restart Claude Desktop. On first use, you'll be prompted to sign in to your Zooza account.

### Claude Code

Download the latest `zooza-plugin-*.zip` from [Releases](../../releases) and install it:

```
/install-plugin zooza-plugin-*.zip
```

Or add manually to your `.mcp.json`:

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

---

## Data and security

- All communication uses **TLS** between the AI client and `mcp.zooza.app`
- Authentication uses **OAuth 2.0** — Claude receives a scoped token tied to your Zooza identity
- Tokens carry only the scopes you are granted in Zooza (`mcp:read`, `mcp:write`) — no broader API access
- Zooza MCP **inherits your existing permissions** — Claude can only see and change what you can see and change in the Zooza dashboard
- No conversation content is stored by the MCP server

---

## How it works

```
You (via Claude)
      │  natural language
      ▼
Claude (AI client)
      │  MCP tools over HTTPS
      ▼
mcp.zooza.app  (Zooza MCP Server)
      │  OAuth-validated REST calls
      ▼
Zooza API  (your data, your rules)
```

The MCP server is **stateless**. Each request carries a JWT validated against Zooza's OAuth server. Your data never leaves the Zooza infrastructure — the MCP layer only passes structured requests and returns structured responses.

**Multi-location accounts:** If your account covers multiple locations or franchise units, Claude will ask which company to operate on at the start of each conversation. You can switch locations at any time.

---

## Example workflows

### Programmes & classes

```
"Create a new swimming programme for the Spring season at the Bratislava location.
 Classes every Tuesday 16:00–17:00, starting 3 March, 12 weeks total.
 Assign trainer Tomáš Novák."

"Show me all active programmes in the current billing period."

"List trainers available at the Košice location."

"What rooms and locations do we have in the system?"
```

### Scheduling & preview

```
"Preview what the Tuesday swimming schedule looks like before I confirm."

"Show all sessions in the next 4 weeks for the Spring term."

"Check for scheduling conflicts on Monday evenings at Studio A."
```

### Bookings & registrations

```
"Find all registrations for the Monday morning gymnastics class."

"Show unpaid bookings from the current billing period."

"Which clients are on the waiting list for the Saturday Robotics programme?"
```

### Payments & billing

```
"List all billing periods for the Bratislava company."

"Show me open invoices from this season."
```

### Reporting

```
"How many active registrations does the Spring season have so far?"

"Which programmes have the most bookings this term?"
```

---

## Available tools

| Tool | Scope | What it does |
|---|---|---|
| `whoami` | read | Identify the connected user and list accessible companies/locations |
| `find_courses` | read | Search programmes by billing period, name, or status |
| `find_billing_periods` | read | List billing periods (seasons/terms) for a company |
| `find_trainers` | read | List trainers available at a location |
| `find_places` | read | List rooms and locations for a company |
| `preview_schedule` | read | Preview recurring class dates before committing |
| `preview_events` | read | Preview individual sessions in a date range |
| `commit_class` | write | Create a new class with a full recurring schedule |
| `get_skill` | read | Load a guided playbook for multi-step workflows |

---

## Skills — guided workflows

Skills are structured playbooks that teach Claude how to combine tools correctly for real operational scenarios. Claude automatically loads the right skill when it detects a matching request.

| Skill | What it guides |
|---|---|
| `class-management` | Full interview → schedule preview → confirmation flow for creating a new class with recurring sessions |

**Coming soon:** `cancel_day`, `mark_attendance`, `transfer_booking`, `initiate_refund`

---

## Tips

**Set your default location** — If you work primarily with one company, tell Claude at the start of the session: *"I'm working in the Bratislava studio today."* Claude will use that company for all follow-up tools without asking.

**Preview before committing** — For class creation, always ask Claude to preview the schedule first. The `preview_schedule` tool shows you every generated date before anything is written.

**Use skills for complex flows** — If you're creating a new class, say *"create a new class"* and Claude will walk you through it step by step using the `class-management` skill rather than asking you for all parameters at once.

---

## What Zooza is

[Zooza](https://zooza.online) is an end-to-end management platform for children's activity and education businesses — dance academies, swimming schools, language schools, music schools, STEM programmes, sports clubs, and franchise networks. It handles the full operational lifecycle: programme setup, class scheduling, client bookings and registrations, attendance tracking, payment management, parent communication, and multi-location reporting.

Zooza MCP brings this platform to any AI client that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Roadmap

The following tools are in active development:

| Tool | What it will do |
|---|---|
| `cancel_day` | Cancel all classes on a given date with optional parent notifications |
| `mark_attendance` | Record attendance for a session |
| `transfer_booking` | Move a client registration from one class to another |
| `initiate_refund` | Prepare and confirm a credit or refund for a client |
| Reporting tools | Revenue summaries, attendance rates, capacity utilisation |
| Payment gateway tools | Invoice management, payment status |
| Communication tools | Send templated messages to parents and clients |

---

## For developers

### Run locally

```bash
git clone https://github.com/zooza-dev/zooza-mcp
cd zooza-mcp
npm install
cp .env.example .env   # fill in credentials
npm run dev            # http://localhost:3001/mcp
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ZOOZA_API_BASE` | yes | Zooza API base URL (e.g. `http://php-server/v1`) |
| `ZOOZA_API_KEY` | yes | Server-wide API key for the MCP integration |
| `MCP_RESOURCE_URL` | prod | Public URL of this server |
| `MCP_AUTH_SERVER_URL` | prod | Zooza OAuth server base URL |
| `PORT` | no | HTTP port (default `3001`) |
| `ZOOZA_ALLOW_HARDCODED_AUTH` | dev | Set `true` to skip JWT validation locally |
| `ZOOZA_API_TOKEN` | dev | Dev-fallback token (only with hardcoded auth enabled) |

### Smoke test

```bash
# List tools
curl -sS http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Support

- **Documentation:** [help.zooza.online](https://help.zooza.online)
- **Website:** [zooza.online](https://zooza.online)
- **Email:** [hello@zooza.online](mailto:hello@zooza.online)

---

## Security note

As with any AI integration, be aware of **prompt injection** — malicious content in your Zooza data (e.g. programme names or notes) could attempt to influence Claude's behaviour. Zooza MCP requires explicit confirmation for all write operations. Always review Claude's proposed actions before confirming, and use accounts with the minimum required permissions.

