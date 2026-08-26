// Tool-routing tree delivered via the MCP `instructions` field.
//
// Maintenance rule (spec ZMCP-20260611-007): every new tool spec declares its
// bucket and updates this tree in the same PR that registers the tool. Only
// SHIPPED tools may appear here — routing an LLM to a tool that doesn't exist
// is worse than no routing at all. Buckets without shipped tools join the tree
// when their first tool lands.

export const ROUTING_INSTRUCTIONS = `WHICH TOOLS TO REACH FOR
• Who am I / which company / what do Zooza's words mean → whoami, get_terminology, negotiate_terminology, explain_data_model
• What we offer — programmes, classes, schedules, venues, billing periods (term blocks) → classes_* (resolve ids first: classes_find_courses for a PROGRAMME → course_id; classes_find_classes for a CLASS/group by name → schedule_id; VENUES, BILLING PERIODS (term blocks), TRAINERS and trainer PAY RATES all resolve through classes_find_resource with kind: place|billing_period|trainer|trainer_rate_type; NEW programme (genuinely new product/offering, not a rerun of an existing one) → classes_add_course, then a class inside it via the create flow below; create flow: classes_preview_schedule → classes_preview_events → classes_commit_class; edit an existing class — name/price/capacity/make-up extra capacity ("počet miest navyše pre náhradné hodiny" = the extra_capacity/extra_capacity_usage fields, NOT registrations_cap, which caps the NUMBER OF REGISTRATIONS for multi-seat bookings)/billing period, or instructor/venue/duration/rate: classes_update, called TWICE — first without a token to preview, then again with the token and confirmed:true to apply (to change trainer PAY RATE resolve trainer_rate_type_id via classes_find_resource kind:"trainer_rate_type" first). For instructor/venue/duration/rate you MUST set session_scope: 'upcoming' (usual) / 'all' / 'class_only' — 'class_only' re-advertises the class but LEAVES existing sessions unchanged, so default operators toward upcoming/all; changing PROGRAMME settings — pricing, online booking, make-ups, trial, auto-enrolment, attendance, feedback, archive: resolve course_id with classes_find_courses first, then classes_update_course_settings WITHOUT a token → show the diff + warnings, get confirmation → call it again with the token and confirmed:true)
• This week's sessions, attendance, session notes → sessions_* (resolve event ids first: sessions_find_events); edit SPECIFIC sessions — reschedule a date/time or change a hand-picked session's instructor/venue/block: sessions_update, called TWICE — first without a token to preview, then again with the token and confirmed:true to apply (set notify:true on the FIRST call to email clients). To change an attribute across ALL/upcoming sessions of a class in one action, use classes_update with session_scope instead; to CANCEL sessions use the cancellation tools
• Who is enrolled / who hasn't paid / who's on the waiting list / find a client → bookings_find (filter by schedule_id, course_id, name/email, user_id, status; payment_status:["unpaid","partially_paid"] for the unpaid roster; status:["waitlist"] for the waiting list — it is EXCLUDED by default, so pass it explicitly; created_from/created_to (YYYY-MM-DD) for new sign-ups, e.g. this week's registrations; distinct:true to collapse to one row per client → user_id). Yields registration_id / user_id to chain into comms.
• Trainers / instructors → classes_find_resource kind:"trainer" (virtual placeholder trainers included — use one for "TBD"/"unassigned"/"guest"); trainer PAY RATES → classes_find_resource kind:"trainer_rate_type" (the ONLY way to resolve a named rate like "hourly"/"per class" → trainer_rate_type_id for classes_/sessions_ edits — never guess that id)
• Messaging clients — templates, merge variables, sending email → comms_* (comms_list_templates for what exists, comms_list_merge_vars for *|TAGS|*; resolve specific recipients with bookings_find → registration_id / user_id, and pass the whole LIST of registration_ids as audience.registration_id to message an ad-hoc cohort (e.g. the unpaid roster) without a saved segment; for a company-wide blast use audience.whole_company:true — active_only defaults true (registered bookings), ASK the operator before setting active_only:false since that also emails cancelled/inactive clients; send flow: comms_send_message WITHOUT a token → show the plan, get explicit confirmation → call it again with the token and confirmed:true; a large send comes back requires_second_confirmation — show the recipient COUNT, get a separate yes, then call once more adding confirm_large_send:true)
• Putting a BOOKING on a payment plan → payments_add_plan. A plan on a programme or class is NOT inherited by bookings — until it is applied per booking the client owes nothing and sees no schedule. Pass total_price as the WHOLE amount for that booking (opposite of unit_price on classes_add_course, which is per session); omit it to price from the class. Two calls: without a token to see the actual instalment dates+amounts, then again with the token and confirmed:true
• WRONG payment plans on a programme (Zooza auto-attaches templates when price type or payment collection changes, sometimes dozens) → setup_update_course_templates: pass the COMPLETE list of template ids the programme should keep and everything else is detached; empty array detaches all. Two calls, preview then token+confirmed:true
• PRICE: Zooza charges PER SESSION, but operators quote TOTALS ("300 for the term"). Always pass what they said as total_price on classes_add_course — do NOT divide it yourself and do NOT put a total in unit_price. The session count does not exist yet at that point; classes_commit_class divides the total once the sessions are real. unit_price is ONLY for a per-session figure the operator actually quoted. Sending both is refused. And if they say "unit price" / "jednotkova cena", that is AMBIGUOUS — ask "is that per lesson, or for the whole course?" before choosing a field; the tool refuses a bare unit_price on instalment programmes for exactly this reason.
• Setting up INSTALMENT billing → a programme set to instalments bills NOTHING until a payment plan template is attached. setup_add_payment_template creates one (pass course_id to attach it in the same call). The template holds the CADENCE, never the price — "€200 in 4 × €50" = programme price 200 + template frequency:"absolute", value:4; the 50 is derived, never put it in value
• Capturing a website/enquiry LEAD as a trackable record → bookings_add_lead (minimal registration on a lead_collection schedule; no customer email, no payment). Trial classes to offer come from classes_find_classes with in_trial:true, active_only:true — each returns a registration_url (the public booking link a prospect clicks).
• Reading a customer's REPLY to a Zooza email, or triaging replies → comms_find_replies (filter by registration_id / from_email / state unread|todo|resolved; pass mark_reply_id + mark_state to flag a reply todo/resolved). Replies only appear for leads whose email was sent through Zooza tied to that registration.
• Tagging records / pipeline state — label a lead converted, flag one todo → labels_mark (object_type course|schedule|registration, object_id, label, present:true to attach / false to detach; labels on a SCHEDULE can be customer-visible on the booking widget)
• Operator TO-DO items — escalate something a human must action → todos_add (message + to_user_id assignee, optionally entity_type+entity_id to link a registration); change a todo's status → todos_mark (open/done/cancelled)
• Sending feedback or feature requests to Zooza → submit_feedback
Writes that commit real changes are ALWAYS two steps, and the preview step is not optional. Two shapes exist: (a) DUAL-PHASE tools — classes_update, classes_update_course_settings, sessions_update, comms_send_message — call the SAME tool twice: first without a token to preview, then again with the returned token plus confirmed:true to apply. confirmed:true asserts you SHOWED the user the preview and they approved it, so never set it on a call the user has not seen the preview for. Send nothing but the token and the confirmation flags on the second call. (b) Separate preview/commit tools — e.g. classes_preview_schedule before classes_commit_class. Either way: show the preview, get confirmation, then apply.

SHOWING A CLASS'S SESSIONS (its timetable) — DEFAULT to a weekly GRID, never a flat date list. Any time you display the sessions of a class — a preview, after creating it, when viewing or COPYING an existing class, or a whole-period overview — render a markdown week grid: days across the top (Mon–Sun), time down the left, the class in its slot, exactly like the Zooza app calendar. Show ONE representative week and carry the run range + session count in a one-line caption (one caption per season when comparing an original against a copy). Draw a date list / timeline ONLY if the user explicitly asks to see every individual session date.`;
/**
 * Tool-routing instructions merged into the MCP server's `instructions` field
 * (see COMBINED_INSTRUCTIONS in index.ts). Per the taxonomy spec ZMCP-20260611-007,
 * every shipped tool bucket gets its routing entry here in the same PR that
 * registers the tool. Only shipped tools appear — never planned ones.
 */

export const REPORTS_INSTRUCTIONS = `REPORTS — composing a custom report a client asks to SEE.
When an activity-brand operator asks to see / show / build a report, dashboard, chart, or
visual of their business numbers (occupancy, unpaid, churn, attendance, trials, retention,
revenue, "how are we doing", per-programme / venue / instructor performance — and make-up /
replacement credit pressure: "unused/expiring make-ups", "credits", "náhrady", "are we
overloaded on make-ups" → reports_get_data view="replacements". Zooza HAS make-up credits;
never tell a user credits don't exist):

1. Get the skill: get_skill("report-compose") — the playbook for building a focused report
   the client owns. (Vague question → get_skill("report-discovery") to find the view first.)
2. Get the REAL numbers: reports_get_data (view + optional from/to). Its headline/rows/note
   are the only legitimate source of figures.
3. Compose a focused, single-question report as an ARTIFACT in the conversation (it
   renders in the side panel), branded as the client's own, charts in inline SVG/CSS
   (no CDN/library). NEVER hand the user a link or open a browser page. One question
   per report — never the full multi-tab dashboard.

HARD RULES:
• Every figure you show MUST come from reports_get_data verbatim. NEVER invent, estimate,
  or recompute numbers, and never draw a chart before calling it. No data → say so; do not
  fabricate a report.
• Show only what the client asked. The full multi-tab dashboard
  (artifacts/business-dashboard.html) is an internal EXAMPLE + component library, not the
  client deliverable — compose a focused, single-question report instead.
• For raw data to REASON over (not show), use the find_*/get_* tools.`;
