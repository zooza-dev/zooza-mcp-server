import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema, safeParse } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { audit } from "./audit.js";
import type { RequestAuthContext } from "./auth/types.js";

// EXPERIMENT — hidden toolsets behind a visible dispatcher
// (research note: memory tool-surface-scaling-research).
//
// Question it answers: can we keep the tool surface a client LOADS small while the
// catalogue grows, using only what every MCP client supports (Claude Desktop, Gemini,
// ChatGPT, local models) — plain tools/list + tools/call?
//
// Round 1 (enable_toolset + notifications/tools/list_changed) failed in Claude Desktop:
// the client freezes its tool list per conversation, so a newly enabled tool only
// appeared in a NEW chat, and the model never thought to enable a hidden toolset on
// its own. Round 2 therefore never changes the list mid-conversation. Instead two
// tools are ALWAYS listed:
//   get_tool_schema(name)        → the exact input schema of any Zooza tool
//   call_tool(name, arguments)   → runs it, validated against that same schema
// and call_tool's description carries a one-line catalogue of the hidden tools, so
// the model knows the capability exists without paying for its schema.
//
// Which toolsets are LISTED directly: `?toolsets=a,b|all` on the /mcp URL, else
// DEFAULT_TOOLSETS. Hiding applies to tools/list only; tools/call of a hidden tool by
// name still runs, so a client holding a wider (stale) list never breaks. Hidden tools
// keep every server-side guard: the dispatcher invokes the same registered handler,
// so audit(), scopeGuard, resolveCompanyId and dual-phase confirmation all still run.
//
// Off unless ZOOZA_TOOLSETS_EXPERIMENT=1. The dispatcher tools are registered from
// this module, not index.ts, so tool-manifest.test.ts and the whoami canary never
// see them while the flag is off.

export const TOOLSETS_EXPERIMENT = process.env.ZOOZA_TOOLSETS_EXPERIMENT === "1";

/** Toolset = taxonomy bucket (ZMCP-20260611-007). Unprefixed tools are "meta". */
export const TOOLSET_NAMES = [
  "meta",
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
] as const;
export type ToolsetName = (typeof TOOLSET_NAMES)[number];

/** Listed directly when the URL does not say otherwise. */
export const DEFAULT_TOOLSETS: readonly ToolsetName[] = ["meta", "classes", "sessions", "bookings", "comms"];

const DISPATCHER_TOOLS = ["get_tool_schema", "call_tool"] as const;
const isDispatcher = (name: string) => (DISPATCHER_TOOLS as readonly string[]).includes(name);

const KNOWN = new Set<string>(TOOLSET_NAMES);

export function toolsetOf(toolName: string): ToolsetName {
  const prefix = toolName.split("_", 1)[0];
  return (KNOWN.has(prefix) ? prefix : "meta") as ToolsetName;
}

/** Parses `?toolsets=` — "all", or a comma list. Unknown names are dropped; meta is
 *  always on (whoami / get_skill must stay reachable). null = param absent/empty. */
export function parseToolsetsParam(raw: unknown): Set<ToolsetName> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (raw.trim() === "all") return new Set(TOOLSET_NAMES);
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ToolsetName => KNOWN.has(s));
  return new Set<ToolsetName>(["meta", ...picked]);
}

export function resolveToolsets(urlParam: Set<ToolsetName> | null): Set<ToolsetName> {
  return urlParam ?? new Set(DEFAULT_TOOLSETS);
}

/** What one request resolved: the toolsets listed directly, and whether to hide the
 *  rest (true only for tools/list). */
export interface ToolsetSelection {
  listed: Set<ToolsetName>;
  gate: boolean;
}

/** Records every RegisteredTool handle as the server registers it. Must be called
 *  BEFORE any registerTool. */
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

/** Disables (hides from tools/list) every tool outside `listed`. */
export function applyToolsets(handles: Map<string, RegisteredTool>, listed: Set<ToolsetName>): void {
  for (const [name, handle] of handles) {
    if (isDispatcher(name)) continue;
    if (!listed.has(toolsetOf(name))) handle.disable();
  }
}

/** The names a client sees in tools/list — fed to whoami's staleness canary. */
export function visibleToolNames(allNames: readonly string[], listed: Set<ToolsetName>): string[] {
  return [...allNames.filter((n) => listed.has(toolsetOf(n))), ...DISPATCHER_TOOLS];
}

/** Server-instructions block appended when the experiment is on. */
export function toolsetInstructions(): string {
  return (
    "MORE ZOOZA TOOLS\n" +
    "Some Zooza tools are not in your tool list, to save context — call_tool's description lists them " +
    "(operator to-dos, labels, payment plans and templates, trainer helpers, reports, …). When the user asks " +
    "for something Zooza can do, use Zooza: never route it to another app because the tool isn't listed. " +
    "Flow: get_tool_schema(name) once, then call_tool(name, arguments). The routing above may name such a " +
    "tool directly — reach it the same way."
  );
}

function toolText(text: string, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text }] };
}

function jsonSchemaOf(handle: RegisteredTool): unknown {
  const obj = normalizeObjectSchema(handle.inputSchema);
  return obj ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" }) : { type: "object" };
}

/** Registers get_tool_schema + call_tool. Call AFTER every other tool is registered,
 *  so the catalogue is complete. */
export function registerDispatcherTools(
  server: McpServer,
  ctx: RequestAuthContext,
  handles: Map<string, RegisteredTool>,
  listed: Set<ToolsetName>,
): void {
  const callable = [...handles.keys()].filter((n) => !isDispatcher(n));
  const hidden = callable.filter((n) => !listed.has(toolsetOf(n)));
  const catalogue = hidden
    .map((n) => `- ${n}: ${handles.get(n)?.title ?? ""}`)
    .join("\n");

  server.registerTool(
    "get_tool_schema",
    {
      title: "Get a Zooza tool's input schema",
      description:
        "Returns the description and exact input schema of a Zooza tool, including ones not in your tool list " +
        "(see call_tool). Call once per tool before its first call_tool.",
      inputSchema: {
        name: z.string().describe("Tool name, e.g. \"todos_add\"."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("get_tool_schema", ctx, async (rawArgs: { name: string }) => {
      const handle = isDispatcher(rawArgs.name) ? undefined : handles.get(rawArgs.name);
      if (!handle) {
        return toolText(`Unknown tool "${rawArgs.name}". Available: ${callable.join(", ")}.`, true);
      }
      return toolText(
        JSON.stringify({
          name: rawArgs.name,
          title: handle.title,
          description: handle.description,
          annotations: handle.annotations,
          input_schema: jsonSchemaOf(handle),
        }),
      );
    }),
  );

  server.registerTool(
    "call_tool",
    {
      title: "Call any Zooza tool by name",
      description:
        "Runs a Zooza tool by name — use it for tools NOT in your tool list. Get the arguments' shape from " +
        "get_tool_schema first. Same rules as calling the tool directly: write tools still preview first and " +
        "need the returned token + confirmed:true to apply.\n" +
        (catalogue ? `Tools reachable only this way:\n${catalogue}` : "All tools are listed directly."),
      inputSchema: {
        name: z.string().describe("Tool name, e.g. \"todos_add\"."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The tool's arguments, matching its get_tool_schema input_schema. {} or omit when it takes none."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    audit("call_tool", ctx, async (rawArgs: { name: string; arguments?: Record<string, unknown> }, extra) => {
      const handle = isDispatcher(rawArgs.name) ? undefined : handles.get(rawArgs.name);
      if (!handle) {
        return toolText(`Unknown tool "${rawArgs.name}". Available: ${callable.join(", ")}.`, true);
      }
      const obj = normalizeObjectSchema(handle.inputSchema);
      let args: unknown = rawArgs.arguments ?? {};
      if (obj) {
        const parsed = safeParse(obj, args);
        if (!parsed.success) {
          const issues = (parsed.error as { issues?: Array<{ path: unknown[]; message: string }> }).issues ?? [];
          return toolText(
            `Invalid arguments for ${rawArgs.name}: ` +
              issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ") +
              `. Call get_tool_schema("${rawArgs.name}") for the exact shape.`,
            true,
          );
        }
        args = parsed.data;
      }
      // Same handler the SDK would run for a direct call — its own audit() entry
      // records the inner tool, so the log shows both the dispatch and the real call.
      const run = handle.handler as unknown as (a: unknown, e: unknown) => Promise<{
        isError?: boolean;
        content: Array<{ type: "text"; text: string }>;
      }>;
      return run(args, extra);
    }),
  );
}
