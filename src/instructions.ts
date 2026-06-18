// Tool-routing tree delivered via the MCP `instructions` field.
//
// Maintenance rule (spec ZMCP-20260611-007): every new tool spec declares its
// bucket and updates this tree in the same PR that registers the tool. Only
// SHIPPED tools may appear here — routing an LLM to a tool that doesn't exist
// is worse than no routing at all. Buckets without shipped tools join the tree
// when their first tool lands.

export const ROUTING_INSTRUCTIONS = `WHICH TOOLS TO REACH FOR
• Who am I / which company / what do Zooza's words mean → whoami, get_terminology, negotiate_terminology, explain_data_model
• What we offer — programmes, classes, schedules, venues, billing periods (term blocks) → classes_* (resolve ids first: classes_find_courses for a PROGRAMME → course_id; classes_find_classes for a CLASS/group by name → schedule_id; classes_find_places, classes_find_billing_periods; create flow: classes_preview_schedule → classes_preview_events → classes_commit_class)
• This week's sessions, attendance, session notes → sessions_* (resolve event ids first: sessions_find_events)
• Who is enrolled / who hasn't paid / find a client → bookings_find (filter by schedule_id, course_id, name/email, user_id, status; payment_status:["unpaid","partially_paid"] for the unpaid roster; distinct:true to collapse to one row per client → user_id). Yields registration_id / user_id to chain into comms.
• Trainers / instructors → trainers_find
• Messaging clients — templates, merge variables, sending email → comms_* (comms_list_templates for what exists, comms_list_merge_vars for *|TAGS|*; resolve specific recipients with bookings_find → registration_id / user_id; send flow: comms_prepare_message → show plan, get explicit confirmation → comms_commit_message)
• Sending feedback or feature requests to Zooza → submit_feedback
Writes that commit real changes are split into preview/prepare and commit steps (e.g. classes_preview_schedule before classes_commit_class) — ALWAYS show the preview to the user and get confirmation before calling any commit_* tool.`;
/**
 * Tool-routing instructions merged into the MCP server's `instructions` field
 * (see COMBINED_INSTRUCTIONS in index.ts). Per the taxonomy spec ZMCP-20260611-007,
 * every shipped tool bucket gets its routing entry here in the same PR that
 * registers the tool. Only shipped tools appear — never planned ones.
 */

export const REPORTS_INSTRUCTIONS = `REPORTS — composing a custom report a client asks to SEE.
When an activity-brand operator asks to see / show / build a report, dashboard, chart, or
visual of their business numbers (occupancy, unpaid, churn, attendance, trials, retention,
revenue, "how are we doing", per-programme / venue / instructor performance):

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
