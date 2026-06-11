// Tool-routing tree delivered via the MCP `instructions` field.
//
// Maintenance rule (spec ZMCP-20260611-007): every new tool spec declares its
// bucket and updates this tree in the same PR that registers the tool. Only
// SHIPPED tools may appear here — routing an LLM to a tool that doesn't exist
// is worse than no routing at all. Buckets without shipped tools join the tree
// when their first tool lands.

export const ROUTING_INSTRUCTIONS = `WHICH TOOLS TO REACH FOR
• Who am I / which company / what do Zooza's words mean → whoami, get_terminology, negotiate_terminology, explain_data_model
• What we offer — programmes, classes, schedules, venues, billing periods (term blocks) → classes_* (resolve ids first: classes_find_courses, classes_find_places, classes_find_billing_periods; create flow: classes_preview_schedule → classes_preview_events → classes_commit_class)
• This week's sessions, attendance, session notes → sessions_* (resolve event ids first: sessions_find_events)
• Trainers / instructors → trainers_find
• Messaging clients — templates, merge variables, sending email → comms_* (comms_list_templates for what exists, comms_list_merge_vars for *|TAGS|*; send flow: comms_prepare_message → show plan, get explicit confirmation → comms_commit_message)
• Sending feedback or feature requests to Zooza → submit_feedback
Writes that commit real changes are split into preview/prepare and commit steps (e.g. classes_preview_schedule before classes_commit_class) — ALWAYS show the preview to the user and get confirmation before calling any commit_* tool.`;
