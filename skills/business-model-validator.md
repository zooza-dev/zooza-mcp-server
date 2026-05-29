---
name: business-model-validator
title: Validate your business model fit with Zooza
description: Use when a prospect, new customer, or existing operator wants to know whether Zooza fits their business, or which features map to how they operate. Pure knowledge interview — no Zooza account or API access required.
---

# Business Model Validator

> **No Zooza account required.** This skill runs as a pure knowledge interview — do NOT call `whoami` or any operational tool. The only reference tool you may optionally call is `explain_data_model` if the user asks about Zooza's technical entity structure.
>
> Three scenarios where this skill applies:
> - **Prospect** — "Does Zooza fit our dance school?"
> - **New customer** — "We just signed up, how do we set this up?"
> - **Existing operator** — "Are we using Zooza the right way?"

## Triggers

Start this skill when the user says any variant of:

- "Does Zooza fit us / our studio / our school?"
- "We're thinking about Zooza — what can it do?"
- "We run [type of business] — can Zooza handle this?"
- "We just signed up, where do we start?"
- "Are we using Zooza correctly?"
- "Can Zooza handle [specific pricing / enrolment model]?"

## Language

Match the user's language automatically — Slovak, Czech, English, Hungarian, Romanian, German. Never switch languages mid-conversation unless the user does.

---

## Interview flow

Run **one question per message** — never dump all questions at once. Move on when you have a clear answer. It is fine to combine closely related follow-ups into one message if the user's answer naturally invites it.

### Phase 1 — What do you do? (2–3 questions)

1. **Activity type:**
   > "What kind of activities do you run — group classes, individual lessons, camps, one-off events, or a mix?"

2. **Client type:**
   > "Who are your clients? Adults, children (with parents paying), corporate groups, or a mix?"

3. **Scale:**
   > "Do you operate from one location, or multiple? Is it one brand, or do you have franchise / licensed locations?"

### Phase 2 — How do you sell? (2–3 questions)

4. **Pricing model:**
   > "How do clients typically pay — per session, per term, monthly subscription, punch card, drop-in?"

5. **If children's group activities:** probe billing rhythm:
   > "Do parents pay once per term/semester (a lump sum), or monthly?"
   This is the key split between the block model and the monthly subscription model — both are valid in Zooza but set up differently.

6. **Extras:**
   > "Do you sell anything alongside classes — products, vouchers, gift cards, equipment?"

### Phase 3 — Edge cases (ask only when relevant signals appear)

Only ask these if earlier answers suggest they apply:

- **Trial/intro:** "Do you offer free trial or introductory sessions that convert to paid enrolment?"
- **Make-ups:** "Can clients attend a session from a different group if they miss their own?"
- **Online delivery:** "Is any part of your offering delivered online or as hybrid (in-person + online simultaneously)?" — if yes, treat this as a delivery layer on top of their base model, not a separate model type.
- **Franchise independence:** "Do your locations operate independently — their own clients, their own revenue — or is everything managed centrally?"

---

## Phase 4 — Match and output

Map answers against the capability map below. Output one of three verdicts.

### ✅ Full fit

> "Zooza is built for this. Here's how it maps:
> - [User's thing] → [Zooza mechanism]
> - [Next item] → [mechanism]
> - ...
>
> Want me to walk you through setting up your first class?"

### 🟡 Partial fit

> "Zooza handles most of this well. One area to be aware of:
> - [Specific limitation and honest workaround]
>
> Overall still a strong fit. Shall I show you the setup path?"

### ❌ Poor fit

> "Zooza might not be the right tool for [specific aspect]. Here's why:
> - [Gap — be specific, not generic]
>
> It would work for [what fits], but [what doesn't] would need [workaround / external tool]."

**Output quality rules:**
- Name the user's specific business type back to them ("adult yoga studio with monthly subscriptions", not "your business")
- List at least 3 concrete mappings (their thing → Zooza mechanism)
- For partial/poor: name the exact gap, not a vague "some limitations"
- Never say "Zooza might work" without explaining the condition

---

## Phase 5 — Next step offer

After the verdict, always offer one concrete next step. Pick the most relevant:

| Scenario | Offer |
|---|---|
| Full fit + ready to set up | "Want me to help you create your first class?" → trigger `class-management` skill |
| Full or partial fit + wants docs | "Want me to point you to the relevant Zooza guides?" → return URLs from capability map below |
| Technical question about structure | "Want me to explain how Zooza structures this?" → call `explain_data_model` |
| Poor fit | "If [fitting subset] is the main use case, Zooza still makes sense for that part — want to explore?" |

---

## Capability map

### Activity types

| What they run | Zooza mechanism | Notes |
|---|---|---|
| Recurring group classes (weekly, biweekly, monthly) | Programme → Class → Sessions with recurrence blocks | Core feature — the primary use case |
| Ongoing open classes (drop-in, no fixed cohort) | Open class type + punch cards (permanentka) | Unlimited or N-punch cards; client picks any available session. **Must use pay-as-you-go** — block/membership booking type is wrong for this model. |
| Fixed-term courses (semester, camp, block) | Programme + billing period + count-mode sessions | "Block model" — finite number of sessions per term |
| Single events & workshops | One-off session or event-type programme | Can sell tickets; no recurring schedule |
| Day camps / week camps / holiday programmes | Programme with date range + capacity per day | Multi-day; includes absence tracking. **Key constraints:** cannot book individual days within a camp week (all-or-nothing), no make-up lessons, cannot combine with other programme types in one booking. |
| 1-to-1 / individual lessons | Programme with `target_audience=individual` | Calendar view for scheduling. **Each client needs their own private Class** — mixing clients breaks attendance tracking and billing. Classes kept admin-only until schedule confirmed. |
| Online & hybrid classes | Online registration flag + streaming link on session | **Delivery modifier, not a standalone model** — always paired with one of the other types above. No auto Zoom link generation; links pasted manually. Separate online vs. in-person capacity requires two separate Classes. |
| Free/trial classes → auto-enrol to paid | Trial class type + auto-enrolment rule | Converts automatically when trial ends |

### Pricing & selling

| What they do | Zooza mechanism |
|---|---|
| Fixed price per class or per course/term | Standard price on Programme |
| Monthly subscription | Billing period + auto-renewal |
| Punch card / package (permanentka) | Open class + punch card product |
| Pay-as-you-go / drop-in per session | Open class, pay per session |
| Vouchers & gift cards | Digital product type |
| Upsell products linked to classes | Service/product catalogue + class attachment |
| Tiered pricing (early bird, member price) | Payment schedule templates |

### Client & enrolment

| What they need | Zooza mechanism |
|---|---|
| Direct client self-registration (B2C) | Online registration, public class page |
| Corporate clients / B2B | Corporate client account type |
| Child activities (parent pays, child attends) | Parent account + child profile |
| Make-up sessions for missed classes | Náhradky — credit system |
| Waitlists | Capacity limit + waitlist enabled on class |

### Multi-location & franchise

| Structure | Zooza mechanism |
|---|---|
| Single location | Single company account |
| Multiple venues, one brand | One company, multiple places (locations) |
| Franchise / chain (each location independent) | Network — each franchise = separate company; HQ has read access + consolidated reporting |
| Regional management | Network hierarchy + region grouping |
| Cross-location client sharing | Network-level client records |
| Revenue / royalty tracking per location | Network reporting |

Full franchise guide: https://help.zooza.online/settings/franchise-network/

---

## Business model guides

Link directly to the matching guide when the user's model maps to one:

| Business type | Guide URL |
|---|---|
| Adult language school | https://help.zooza.online/programmes/adult-language-school/ |
| Children's group — block/term model | https://help.zooza.online/programmes/childrens-group-activities-block-term/ |
| Children's group — monthly subscription | https://help.zooza.online/programmes/childrens-group-activities-monthly-subscription/ |
| Camps (day, week, holiday) | https://help.zooza.online/programmes/camps/ |
| Individual lessons (1-to-1) | https://help.zooza.online/programmes/individual-lessons/ |
| Online and hybrid classes | https://help.zooza.online/programmes/online-hybrid/ |
| Open classes / drop-in / pay-as-you-go | https://help.zooza.online/programmes/open-classes-drop-in/ |

---

## Known gaps — flag proactively

If the user's model hits any of these, name it honestly:

- **Global online academies with timezone management:** Zooza is designed for local/regional operators. No built-in multi-timezone scheduling for distributed audiences.
- **Asynchronous / on-demand content (LMS):** Zooza handles live scheduled sessions, not video module delivery or self-paced course content.
- **Complex membership tiers with access rules across a large product catalogue:** Zooza has billing periods and pricing tiers, but not a full membership/access-control engine.
- **Marketplace model (multiple independent teachers with revenue splits):** Per-teacher revenue splits are not natively supported.
- **Camps with individual day booking:** Camps are all-or-nothing — clients book the whole camp. Individual day selection doesn't map natively (workaround: multiple short-block programmes).
- **Monthly subscriptions with auto-pause during holidays:** Cannot auto-pause — must cancel and re-enrol. Plan for this in the setup.
- **Corporate language school with separate invoices per employee:** Supported via Business booking fields and Linked Bookings, but requires one Programme per course level — not one Programme per corporate client (a common setup mistake).
