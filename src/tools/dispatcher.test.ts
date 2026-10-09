import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildCallToolDescription, runCallTool, runGetToolSchema } from "./dispatcher.js";

type Handler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }>;

function fakeTool(shape: z.ZodRawShape, handler: Handler, title = "A tool"): RegisteredTool {
  return {
    title,
    description: `${title} — description`,
    inputSchema: z.object(shape),
    annotations: { readOnlyHint: false },
    handler,
    enabled: true,
  } as unknown as RegisteredTool;
}

function setup() {
  const todosAdd = vi.fn<Handler>(async (args) => ({ content: [{ type: "text", text: JSON.stringify({ got: args }) }] }));
  const handles = new Map<string, RegisteredTool>([
    [
      "todos_add",
      fakeTool(
        { company_id: z.number().int().optional().describe("c"), message: z.string().min(1).describe("m") },
        todosAdd,
        "Create an operator to-do item",
      ),
    ],
    ["call_tool", fakeTool({ name: z.string().describe("n") }, vi.fn<Handler>(), "Call any Zooza tool")],
  ]);
  return { handles, todosAdd };
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("runCallTool", () => {
  it("runs the registered handler with schema-parsed arguments and forwards extra", async () => {
    const { handles, todosAdd } = setup();
    const extra = { sendNotification: vi.fn() };
    const res = await runCallTool({ name: "todos_add", arguments: { company_id: 1, message: "Call Martin" } }, handles, extra);
    expect(res.isError).toBeUndefined();
    expect(todosAdd).toHaveBeenCalledWith({ company_id: 1, message: "Call Martin" }, extra);
  });

  it("rejects invalid arguments naming the field and pointing to get_tool_schema, without running the tool", async () => {
    const { handles, todosAdd } = setup();
    const res = await runCallTool({ name: "todos_add", arguments: { message: "" } }, handles, undefined);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("message");
    expect(textOf(res)).toContain('get_tool_schema("todos_add")');
    expect(todosAdd).not.toHaveBeenCalled();
  });

  it("returns the inner tool's error result unchanged (e.g. a dual-phase preview refusal)", async () => {
    const { handles, todosAdd } = setup();
    todosAdd.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "confirmed must be true" }] });
    const res = await runCallTool({ name: "todos_add", arguments: { message: "x" } }, handles, undefined);
    expect(res).toEqual({ isError: true, content: [{ type: "text", text: "confirmed must be true" }] });
  });

  it("errors on an unknown tool and lists the real ones", async () => {
    const { handles } = setup();
    const res = await runCallTool({ name: "todos_delete" }, handles, undefined);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("todos_add");
  });

  it("refuses to dispatch to itself", async () => {
    const { handles } = setup();
    const res = await runCallTool({ name: "call_tool", arguments: { name: "todos_add" } }, handles, undefined);
    expect(res.isError).toBe(true);
  });

  it("errors when name is missing", async () => {
    const { handles } = setup();
    const res = await runCallTool({}, handles, undefined);
    expect(res.isError).toBe(true);
  });
});

describe("runGetToolSchema", () => {
  it("returns title, description and a JSON input schema", async () => {
    const { handles } = setup();
    const out = JSON.parse(textOf(await runGetToolSchema({ name: "todos_add" }, handles)));
    expect(out.title).toBe("Create an operator to-do item");
    expect(out.input_schema.type).toBe("object");
    expect(Object.keys(out.input_schema.properties)).toEqual(["company_id", "message"]);
    expect(out.input_schema.required).toEqual(["message"]);
  });

  it("errors on an unknown tool", async () => {
    const { handles } = setup();
    expect((await runGetToolSchema({ name: "nope" }, handles)).isError).toBe(true);
  });
});

describe("buildCallToolDescription", () => {
  it("lists dispatch-only tools with their titles, never the dispatcher itself", () => {
    const { handles } = setup();
    const d = buildCallToolDescription(["todos_add", "call_tool"], handles);
    expect(d).toContain("- todos_add: Create an operator to-do item");
    expect(d).not.toContain("- call_tool");
  });
});
