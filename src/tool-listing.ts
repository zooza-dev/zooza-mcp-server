import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CORE_TOOL_NAMES, TOOL_NAMES } from "./tool-manifest.js";

// Which registered tools a client sees in tools/list (spec ZMCP-20261009-001).
//
// Every tool stays REGISTERED; only CORE_TOOL_NAMES are LISTED by default. The rest
// are reached through the call_tool dispatcher (src/tools/dispatcher.ts), whose
// description carries their one-line catalogue. Why not let the client pick tools
// mid-conversation (enable_toolset + notifications/tools/list_changed)? Tested
// 2026-10-09: Claude Desktop freezes its tool list per conversation, so a newly
// listed tool only appeared in a NEW chat — and the stateless transport drops the
// notification entirely for JSON-response clients (sdk
// webStandardStreamableHttp.js:670-702). A visible dispatcher needs nothing beyond
// plain tools/list + tools/call, so it works in Claude, Gemini, ChatGPT and local
// models alike.
//
// Hiding applies to tools/list ONLY. A tools/call naming a hidden tool still runs:
// listing is a context-budget lever, not an authorization boundary, and a client
// holding an older, wider list must not break.

/** Taxonomy buckets (ZMCP-20260611-007) a `?toolsets=` value may name. */
const BUCKETS = new Set([
  "classes",
  "sessions",
  "bookings",
  "comms",
  "payments",
  "setup",
  "reports",
  "todos",
  "labels",
  "trainers",
  "meta",
]);

const CORE = new Set(CORE_TOOL_NAMES);

export function bucketOf(toolName: string): string {
  const prefix = toolName.split("_", 1)[0];
  return BUCKETS.has(prefix) ? prefix : "meta";
}

/** Listing for one request: core plus any extra buckets, or everything. */
export type ToolListing = { all: true } | { all: false; extraBuckets: Set<string> };

export const DEFAULT_LISTING: ToolListing = { all: false, extraBuckets: new Set() };

/** Parses `?toolsets=` on the /mcp URL — an advanced knob, not the normal path.
 *  "all" lists every tool (strong models with room to spare); "a,b" adds those
 *  buckets on top of core. Unknown names are ignored; absent/empty = core only. */
export function parseToolsetsParam(raw: unknown): ToolListing {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_LISTING;
  if (raw.trim() === "all") return { all: true };
  const extra = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => BUCKETS.has(s));
  return { all: false, extraBuckets: new Set(extra) };
}

export function isListed(toolName: string, listing: ToolListing): boolean {
  if (listing.all || CORE.has(toolName)) return true;
  return listing.extraBuckets.has(bucketOf(toolName));
}

/** Names a client with this listing sees — fed to whoami's staleness canary. */
export function listedToolNames(listing: ToolListing): string[] {
  return TOOL_NAMES.filter((n) => isListed(n, listing));
}

/** Names reachable only through call_tool for this listing. */
export function dispatchOnlyToolNames(listing: ToolListing): string[] {
  return TOOL_NAMES.filter((n) => !isListed(n, listing));
}

/** Records every RegisteredTool handle as the server registers it, so the
 *  dispatcher can run a tool by name and tools/list can hide the non-listed ones.
 *  Must be called BEFORE any registerTool. The SDK keeps the same map privately
 *  (McpServer._registeredTools); wrapping the public method avoids depending on it. */
export function captureToolHandles(server: McpServer): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();
  const original = server.registerTool.bind(server) as (...a: unknown[]) => RegisteredTool;
  (server as unknown as { registerTool: (...a: unknown[]) => RegisteredTool }).registerTool = (
    ...args: unknown[]
  ) => {
    const handle = original(...args);
    handles.set(args[0] as string, handle);
    return handle;
  };
  return handles;
}

/** Hides (SDK disable()) every registered tool this listing does not show. Only
 *  for tools/list requests — a disabled tool rejects tools/call in the SDK. */
export function hideUnlisted(handles: Map<string, RegisteredTool>, listing: ToolListing): void {
  for (const [name, handle] of handles) {
    if (!isListed(name, listing)) handle.disable();
  }
}
