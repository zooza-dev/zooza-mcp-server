import { z } from "zod";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema, safeParse } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

// get_tool_schema + call_tool — the dispatcher that reaches every tool NOT listed in
// tools/list (spec ZMCP-20261009-001; listing rules in src/tool-listing.ts).
//
// call_tool runs the SAME registered handler the SDK would run for a direct call, so
// every server-side guard still applies: the inner tool's own audit() entry, its
// scopeGuard, resolveCompanyId and dual-phase confirmation. The dispatcher adds no
// authority of its own — it is a different door to the same rooms.

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const DISPATCHER = new Set(["get_tool_schema", "call_tool"]);

export const getToolSchemaTitle = "Get a Zooza tool's input schema";

export const getToolSchemaDescription =
  "Returns the description and exact input schema of a Zooza tool, including tools not in your tool list " +
  "(call_tool lists them). Call it once per tool before that tool's first call_tool.";

export const getToolSchemaInputSchema = {
  name: z.string().describe('Tool name, e.g. "todos_add".'),
};

export const callToolTitle = "Call any Zooza tool by name";

/** call_tool's description: fixed rules + the catalogue of tools reachable only
 *  through it, so the model knows a capability exists without its schema in context. */
export function buildCallToolDescription(
  dispatchOnly: readonly string[],
  handles: Map<string, RegisteredTool>,
): string {
  const catalogue = dispatchOnly
    .filter((n) => !DISPATCHER.has(n))
    .map((n) => `- ${n}: ${handles.get(n)?.title ?? ""}`)
    .join("\n");
  return (
    "Runs a Zooza tool by name. Use it for every Zooza tool that is NOT in your tool list — these exist and " +
    "work; never send the user to another app because a Zooza tool isn't listed. Call get_tool_schema(name) " +
    "first for the arguments. Write tools behave exactly as when called directly: the first call previews and " +
    "returns a token, the second (token + confirmed:true) applies.\n" +
    (catalogue ? `Tools reachable this way:\n${catalogue}` : "Every tool is already in your tool list.")
  );
}

export const callToolInputSchema = {
  name: z.string().describe('Tool name, e.g. "todos_add".'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The tool's arguments, shaped as its get_tool_schema input_schema. Omit when it takes none."),
};

function text(body: string, isError = false): ToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: body }] };
}

function lookup(
  name: string,
  handles: Map<string, RegisteredTool>,
): { handle: RegisteredTool } | { error: ToolResult } {
  const handle = DISPATCHER.has(name) ? undefined : handles.get(name);
  if (handle) return { handle };
  const known = [...handles.keys()].filter((n) => !DISPATCHER.has(n)).sort();
  return { error: text(`Unknown Zooza tool "${name}". Tools: ${known.join(", ")}.`, true) };
}

export async function runGetToolSchema(
  rawArgs: unknown,
  handles: Map<string, RegisteredTool>,
): Promise<ToolResult> {
  const args = z.object(getToolSchemaInputSchema).safeParse(rawArgs);
  if (!args.success) return text('Missing "name" — the Zooza tool to describe, e.g. "todos_add".', true);
  const found = lookup(args.data.name, handles);
  if ("error" in found) return found.error;
  const obj = normalizeObjectSchema(found.handle.inputSchema);
  return text(
    JSON.stringify({
      name: args.data.name,
      title: found.handle.title,
      description: found.handle.description,
      annotations: found.handle.annotations,
      // Same serialisation the SDK uses for tools/list (mcp.js ListTools handler).
      input_schema: obj ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" }) : { type: "object" },
    }),
  );
}

export async function runCallTool(
  rawArgs: unknown,
  handles: Map<string, RegisteredTool>,
  extra: unknown,
): Promise<ToolResult> {
  const args = z.object(callToolInputSchema).safeParse(rawArgs);
  if (!args.success) return text('Missing "name" — the Zooza tool to run, e.g. "todos_add".', true);
  const found = lookup(args.data.name, handles);
  if ("error" in found) return found.error;

  // Validate exactly as the SDK validates a direct call, so the inner handler sees
  // the same parsed (defaulted, coerced) arguments either way.
  let toolArgs: unknown = args.data.arguments ?? {};
  const obj = normalizeObjectSchema(found.handle.inputSchema);
  if (obj) {
    const parsed = safeParse(obj, toolArgs);
    if (!parsed.success) {
      const issues = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues ?? [];
      return text(
        `Invalid arguments for ${args.data.name}: ` +
          issues.map((i) => `${i.path.map(String).join(".") || "(root)"} — ${i.message}`).join("; ") +
          `. Call get_tool_schema("${args.data.name}") for the exact shape.`,
        true,
      );
    }
    toolArgs = parsed.data;
  }

  const handler = found.handle.handler as unknown as (a: unknown, e: unknown) => Promise<ToolResult>;
  return handler(toolArgs, extra);
}
