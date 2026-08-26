import { createRequire } from "node:module";

// Single source of truth for the running server version + the canonical tool
// surface. `whoami` surfaces both so a connected client can DETECT when its
// cached tool list is stale: the model compares TOOL_NAMES against the tools it
// actually has available and, on a mismatch, prompts the user to refresh their
// connector (see runWhoami). index.ts also advertises SERVER_VERSION as the MCP
// `serverInfo.version` so the handshake reports the real build, not a literal.
//
// zooza-mcp is not marketplace-listed, so there is no automatic update path — a
// user's cached tool list can lag a deploy indefinitely. This manifest is the
// mechanism that lets the model notice and nudge a manual refresh (spec
// ZMCP-20260703-002).
//
// Maintenance rule (mirrors src/instructions.ts): every tool registered in
// index.ts MUST appear in TOOL_NAMES in the same PR that registers it.
// tool-manifest.test.ts parses index.ts and fails if this list drifts from the
// actually-registered set — so the canary can never lie.

const nodeRequire = createRequire(import.meta.url);
const pkg = nodeRequire("../package.json") as { version: string };

/** Running server version, from package.json — the one source of truth. */
export const SERVER_VERSION: string = pkg.version;

/** Every tool the server registers, sorted. Kept in lockstep with index.ts by
 *  tool-manifest.test.ts. */
export const TOOL_NAMES: readonly string[] = [
  "bookings_add_lead",
  "bookings_find",
  "classes_add_course",
  "classes_commit_class",
  "classes_find_classes",
  "classes_find_courses",
  "classes_find_resource",
  "classes_list_schedule_patterns",
  "classes_preview_events",
  "classes_preview_schedule",
  "classes_update",
  "classes_update_course_settings",
  "comms_find_replies",
  "comms_list_merge_vars",
  "comms_list_templates",
  "comms_send_message",
  "explain_data_model",
  "get_skill",
  "get_terminology",
  "labels_mark",
  "negotiate_terminology",
  "payments_add_plan",
  "reports_get_data",
  "sessions_add_summary",
  "sessions_find_events",
  "sessions_get_attendance",
  "sessions_mark_attendance",
  "sessions_update",
  "setup_add_payment_template",
  "setup_update_course_templates",
  "submit_feedback",
  "todos_add",
  "todos_mark",
  "whoami",
];

/** Number of tools the live server exposes. */
export const TOOL_COUNT: number = TOOL_NAMES.length;
