# Zooza MCP — Build Map
> Working document: what to build as a Tool, Skill, Command, or Plugin feature
>
> Version: 2026-05-26 · Based on: strategy spec ZMCP-20260525-001, skill specs API-20260525-001/002, research docs create_class.md + find_resources.md, MCP server research (Linear, Notion, Stripe, Shopify)

---

## Four layers, one installation

```
Plugin (ZIP — installed once by the user in Claude Code)
├── .mcp.json          → registers the MCP server (points to mcp.zooza.app)
├── CLAUDE.md          → always-on instructions injected into every conversation
├── commands/          → slash commands the user triggers (/zooza:today)
└── skills/            → playbook .md files Claude reads on demand

MCP Server (Node.js — hosted at mcp.zooza.app)
└── tools/             → atomic operations Claude calls automatically (find_events, cancel_event…)
```

**Which layer does something belong to — decision tree:**

| Question | Yes → | No → |
|----------|--------|-------|
| Does it need to call the Zooza API? | Tool | Free tool or Skill |
| Is it one atomic operation? | Tool | Skill (workflow across multiple tools) |
| Does the user trigger it explicitly? | Command | Tool (Claude decides when to call it) |
| Should it be active in every conversation? | plugin/CLAUDE.md | Skill (load on demand) |

---

## Current state (2026-05-26)

### ✅ Shipped (implemented)

| Layer | Name | What it does |
|-------|------|-------------|
| Tool | `whoami` | Session bootstrap + regional context |
| Tool | `find_courses` | Search programmes by name/type |
| Tool | `find_places` | Search venues + rooms |
| Tool | `find_trainers` | Search instructors |
| Tool | `find_billing_periods` | List billing periods |
| Tool | `preview_schedule` | Preview a class plan before creating it |
| Tool | `preview_events` | Calculate session dates before committing |
| Tool | `commit_class` | Create a class (3 API calls → 1 MCP tool) |
| Free tool | `explain_data_model` | Explain Zooza entities (no API) |
| Free tool | `list_message_merge_vars` | Catalogue of merge variables (no API) |
| Free tool | `list_schedule_patterns` | Recurrence patterns reference (no API) |
| Free tool | `get_terminology` | Translate terms by region (no API) |
| Free tool | `negotiate_terminology` | Save terminology preferences to memory |
| Skill | `class-management` | Playbook: create a class step by step |
| Plugin / Command | `/zooza:setup` | Save the business vocabulary profile |
| Plugin / CLAUDE.md | Terminology profile check | Loaded at every conversation start |

### 🔧 In progress

| Layer | Name | Blocker |
|-------|------|---------|
| Tool | `create_class` (spec ZMCP-20260522-001) | Finalisation and testing |
| Auth | Per-user OAuth (ZMCP-20260523-005) | In discussion with api-v1 |

---

## What to build next — priority map

### Priority 1 — Skill: `cancel_day`
**Why:** Most common manual workflow (Anna, Kate, 52 Zoho tickets). Spec is complete and detailed — only the underlying tools are missing.

**Tools the skill needs — currently missing:**

| Tool | API endpoint | Notes |
|------|-------------|-------|
| `find_events` | `GET /events?date=&trainer_id=&status=scheduled` | Core — returns sessions for a day |
| `cancel_event` | `PUT /events/{id}` with `status=unplanned` | Single event; carries notify + credit in one call |
| `issue_makeup_credit` | `POST /credits` with `type=free_event, registration_id` | Per-client loop — bottleneck for large classes (needs bulk API) |
| `send_custom_notification` | `POST /mass_emails` or class notification | Combined message for multi-session cancels |

**Scaling blocker:** `POST /credits/bulk` is missing in api-v1 (handoff API-20260523-001). Without it: 5 sessions × 25 clients = 125 API calls. Skill works but is slow. **Recommendation: ship without bulk, rewrite when api-v1 delivers.**

**Plugin command:** `/zooza:cancel-day` → triggers the `cancel_day` skill with "cancel day" context

---

### Priority 2 — Skill: `mark_attendance`
**Why:** 80 Zoho tickets, daily work, Anna and Kate do this manually for 15–30 min/day.

**Tools the skill needs — currently missing:**

| Tool | API endpoint | Notes |
|------|-------------|-------|
| `find_events` | `GET /events?date=&schedule_id=` | **Shared with cancel_day** — one tool, two uses |
| `get_session_register` | `GET /events/{id}` + `GET /attendance?event_id=` | Returns the register: who is enrolled, current status |
| `update_attendance` | `PUT /attendance/{id}` or `PATCH /attendance/bulk` | Change status (attended/absent/cancelled) + note |
| `issue_makeup_credit` | `POST /credits` | **Shared with cancel_day** — when a client was absent |

**Plugin command:** `/zooza:attendance` → "open the register for my next class"

---

### Priority 3 — Skill: `initiate_refund`
**Why:** Anna handles 100+ refunds; most complex workflow; errors have direct financial impact.

**Tools the skill needs — currently missing:**

| Tool | API endpoint | Notes |
|------|-------------|-------|
| `find_registrations` | `GET /registrations?client_id=` or `GET /orders` | Find the client's booking |
| `get_payment_history` | `GET /payments?order_id=` | List of payments — what to refund from |
| `calculate_prorata` | `POST /orders/calculate_prorata` | **Blocker:** endpoint missing (API-20260523-003) |
| `execute_refund` | `POST /payments/{id}/refunds` | Real gateway refund (Stripe/GoCardless) |
| `record_refund` | `POST /payments` with `type=refund` | Admin-only record (cash/bank transfer) |
| `cancel_registration` | `PUT /registrations/{id}` or `DELETE` | Optional — cancel booking after refund |
| `send_message` | (see messaging family below) | Send confirmation to client |

**Partial blocker:** `calculate_prorata` endpoint is missing. Skill works with a manual amount as fallback — operator provides the amount, Claude doesn't calculate it. Sufficient for v1.

---

### Priority 4 — Tool family: messaging
**Why:** Needed by cancel_day, initiate_refund, chase_unpaid, and many others. Horizontal infrastructure.

| Tool | API endpoint | Use case |
|------|-------------|---------|
| `send_session_notification` | `PUT /events/{id}` with `notify=true` | Notification for one session (cancel, change) |
| `send_bulk_message` | `POST /mass_emails` (or `/mass_sms`) | Reminder to a group of clients |
| `send_custom_message` | `POST /persons/{id}/message` | Individual message to a client |

**Note:** All are `prepare-and-commit` — Claude shows a preview (who, what, how many recipients), operator confirms.

---

### Priority 5 — Commands: daily dashboard
These commands don't need new tools — they compose what we already have.

| Command | What it does | Tools it calls | Status |
|---------|-------------|---------------|--------|
| `/zooza:today` | Today's sessions, instructor coverage, enrolment counts | `find_events` (new) | Waits for `find_events` |
| `/zooza:unpaid` | List of unpaid registrations | `find_registrations` (new) | Waits for tool |
| `/zooza:help` | What can I do — short overview | *(no API)* | **Can build now** |
| `/zooza:attendance` | Open register for the next session | `find_events`, `get_session_register` | Waits for tools |
| `/zooza:cancel-day` | Cancel sessions today/tomorrow | `cancel_day` skill | Waits for skill |
| `/zooza:trials` | List trialists and follow-up | `find_registrations` | Waits for tool |

---

## Shared tools — build these FIRST

Some tools are needed by multiple skills. Prioritise by how many skills they unblock:

| Tool | Unblocks | Priority |
|------|---------|---------|
| `find_events` | cancel_day + mark_attendance + today command | **P0** |
| `issue_makeup_credit` | cancel_day + mark_attendance | **P0** |
| `update_attendance` | mark_attendance | **P1** |
| `get_session_register` | mark_attendance + today command | **P1** |
| `cancel_event` | cancel_day | **P1** |
| `send_bulk_message` | cancel_day + chase_unpaid + initiate_refund | **P1** |
| `find_registrations` | initiate_refund + unpaid command + trials | **P2** |
| `execute_refund` | initiate_refund | **P2** |
| `get_payment_history` | initiate_refund | **P2** |

---

## Confirmation patterns — rule for every new tool

| Operation type | Pattern | Example |
|---------------|---------|---------|
| Read-only | `none` | `find_events`, `get_session_register` |
| Preview with no change | `preview-only` | `preview_schedule`, `explain_data_model` |
| Single record change, reversible | `prepare-and-commit` | `update_attendance` |
| Sending messages | `prepare-and-commit` + recipient count | `send_bulk_message` |
| Bulk operations | `prepare-and-commit` + full summary | `cancel_event` (multiple) |
| Financial (payments, refunds, credits) | `prepare-and-commit` + explicit amount | `execute_refund`, `issue_makeup_credit` |

---

## What is NOT a tool (and why)

| Idea | Why it's not a tool | What it is instead |
|------|--------------------|--------------------|
| "Show today's schedule" | Just display logic composed from find_events | Command `/zooza:today` |
| "Explain how attendance works" | No API, static text | Free tool or Skill |
| "Remind me about a refund" | Outside Zooza domain | Not in scope |
| "Auto-cancel when an instructor is sick" | Webhook/trigger, not agent-driven | Not in MCP scope |
| "Bulk import clients from CSV" | CSV processing — outside LLM strengths | Not in scope |

---

## Plugin — what belongs in plugin/CLAUDE.md

The plugin's `CLAUDE.md` is injected into **every conversation** automatically — before the user types anything. It should contain only things that are always true, always needed, and brief enough not to waste context.

**Currently in plugin/CLAUDE.md:**
- Terminology profile check (load saved business vocabulary, translate terms)

**Should also include:**

| What | Why |
|------|-----|
| Available commands hint | Discoverability — user won't know `/zooza:help` exists otherwise |
| Call `whoami` if not already called | Ensure Claude always knows which company it's working in |
| Short framing: "You are working in Zooza" | Sets tone + prevents Claude from hallucinating Zooza's domain |

**What NOT to put in plugin/CLAUDE.md:**
- Skill instructions (those are in `skills/*.md`, loaded on demand)
- API documentation (that's in tool descriptions on the server)
- Long domain explanations (those are in free tools like `explain_data_model`)

**Rule:** If it must be active even when the user asks something unrelated to the task at hand — it goes in CLAUDE.md. Everything else goes in a skill.

---

## Lessons from other production MCP servers

> Source: research agent, 2026-05-26. Researched: Linear, Notion, Stripe, Shopify, Booking.com
> ⚠️ Note: Wix MCP ([github.com/wix/wix-mcp](https://github.com/wix/wix-mcp)) is a developer tool for writing code against the Wix platform — not an operational studio management tool. Not a valid analogue.

### How many tools is right?

| Server | Domain | Tool count |
|--------|--------|------------|
| [Linear](https://linear.app/docs/mcp) | Project management | 21–25 |
| [Notion](https://developers.notion.com/guides/mcp/mcp-supported-tools) | Workspace | 18 |
| [Stripe](https://docs.stripe.com/mcp) ⭐ best analogue | Payments + financial ops | 19 |
| [Shopify](https://docs.workato.com/en/mcp/registry/shopify-orders-and-fulfillment-mcp-server.html) | E-commerce | ~15 |
| [Booking.com](https://booking.com) | Hotel reservations | 14 |

**Conclusion: 15–25 tools is the sweet spot.** Servers with 100+ tools are called "anatomy of chaos" — they need internal organisation layers. We're targeting 18–25.

**Best analogue for Zooza: [Stripe MCP](https://github.com/stripe/agent-toolkit).** Same reasons:
- Operational tool (not developer), used by business operators daily
- Touches money → needs prepare+commit, confirmation, audit trail
- 19 tools, verb-first naming, explicit error catalog per tool
- Documented "enable human confirmation" as a security requirement

### What this confirms about our decisions

1. **Verb-first naming is the standard** — Linear, Stripe: `create_issue`, `cancel_subscription`. Our `create_class`, `cancel_event`, `mark_attendance` are correct. *Never* `class_create`.

2. **prepare/commit is standard for money and messages** — Stripe and Shopify explicitly document "enable human confirmation" as a security best practice. Our `prepare_refund` + `commit_refund` split is exactly this pattern.

3. **Skills are a differentiator** — most servers (Stripe, Linear) don't have explicit `.md` skill files. They teach workflow only through tool descriptions. Our skill layer is ahead of the market — LlamaIndex independently recommends this separation: *"Skills are recipes. MCP tools are ingredients."*

4. **Free tools are rare** — almost no one ships tools without an API call. Our `explain_data_model`, `list_merge_vars`, `list_schedule_patterns` are unique. They reduce context bloat and prevent Claude from hallucinating domain knowledge.

5. **Compound operations > one-to-one API wrapping** — Stripe has `create_payment_intent` (not `create_intent` + `attach_method` + `confirm` as separate tools). Our `commit_class` (3 API calls → 1 MCP tool) follows the same pattern.

6. **Error catalogs are standard** — every good MCP server documents per tool: what can fail, why, and how to recover. Our `mcp-tool-new` skill enforces this — correct.

---

## Recommended build sequence

```
Step 1 — P0 tools (2–3 days)
  ├── find_events              (blocks everything else)
  └── issue_makeup_credit      (blocks cancel_day + mark_attendance)

Step 2 — cancel_day skill + supporting tools (3–4 days)
  ├── cancel_event             (tool)
  ├── send_session_notification (tool)
  ├── skills/cancel-day.md     (skill playbook)
  └── commands/cancel-day.md  (plugin command)

Step 3 — mark_attendance skill + supporting tools (3–4 days)
  ├── get_session_register     (tool)
  ├── update_attendance        (tool)
  ├── skills/mark-attendance.md (skill playbook)
  └── commands/attendance.md  (plugin command)

Step 4 — daily dashboard commands (1–2 days)
  ├── commands/help.md         (no API — can build now)
  └── commands/today.md        (needs find_events — ready after Step 1)

Step 5 — initiate_refund (4–5 days, partially blocked)
  ├── find_registrations       (tool)
  ├── get_payment_history      (tool)
  ├── execute_refund           (tool)
  ├── record_refund            (tool)
  ├── skills/initiate-refund.md (skill)
  └── commands/refund.md       (command)

In parallel: Handoffs to api-v1
  ├── H2 — bulk_cancel + bulk_credits (unblocks cancel_day at scale)
  └── H3 — calculate_prorata  (unblocks full initiate_refund)
```

**New tools to write: ~10–12**
**New skills: 3 (cancel_day, mark_attendance, initiate_refund)**
**New plugin commands: 5–6**

---

## Master table: every new artefact and where it belongs

| Artefact | Layer | Reason |
|----------|-------|--------|
| `find_events` | Tool | Calls API, atomic operation |
| `cancel_event` | Tool | Mutates one record, calls API |
| `get_session_register` | Tool | Read-only, calls API |
| `update_attendance` | Tool | Mutates record, calls API |
| `issue_makeup_credit` | Tool | Mutation + money, calls API |
| `send_bulk_message` | Tool | Sends messages, calls API |
| `send_session_notification` | Tool | Notification, calls API |
| `find_registrations` | Tool | Read-only, calls API |
| `execute_refund` | Tool | Money, calls API |
| `record_refund` | Tool | Admin record, calls API |
| `cancel_registration` | Tool | Mutates record, calls API |
| `get_payment_history` | Tool | Read-only, calls API |
| `cancel_day` | **Skill** | Multi-step workflow, 6 steps, branching conditions |
| `mark_attendance` | **Skill** | Multi-step, role-based, trialist follow-up logic |
| `initiate_refund` | **Skill** | Most complex workflow, own branch logic |
| `chase_unpaid` | **Skill** | Rules for when/when not to send, segmentation |
| `/zooza:today` | **Command** | User-triggered, daily routine |
| `/zooza:attendance` | **Command** | Triggers mark_attendance skill |
| `/zooza:cancel-day` | **Command** | Triggers cancel_day skill |
| `/zooza:unpaid` | **Command** | Daily routine, explicit user trigger |
| `/zooza:help` | **Command** | Onboarding, discoverability |
| `/zooza:trials` | **Command** | Trial follow-up, periodic action |
| Session bootstrap + commands hint | **plugin/CLAUDE.md** | Runs at every conversation start |
