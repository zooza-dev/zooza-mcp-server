import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr } from "./common.js";

const TODO_STATUSES = ["open", "done", "cancelled"] as const;

export const todosMarkTitle = "Change the status of a to-do item";

export const todosMarkDescription =
  "Change the status of a to-do item: `done` (completed), `cancelled` (won't do), or `open` (reopen). Only OPEN " +
  "todos can be marked `done` or `cancelled`; a `done` or `cancelled` todo can only be reopened to `open`. Marking " +
  "`done` stamps completion time automatically.";

export const todosMarkInputSchema = {
  company_id: companyIdSchema,
  todo_id: z.number().int().positive().describe("Id of the todo to update."),
  status: z.enum(TODO_STATUSES).describe("Target status: 'open', 'done', or 'cancelled'."),
};

const inputSchema = z.object(todosMarkInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TodoMarkResult;
};

export interface TodoMarkResult {
  [key: string]: unknown;
  todo_id: number;
  status: string;
  completed_at: string | null;
}

interface RawTodoUpdate {
  id?: number | string;
  status?: string;
  completed_at?: string | null;
  data?: { id?: number | string; status?: string; completed_at?: string | null };
}

export async function runTodosMark(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  let updated: RawTodoUpdate;
  try {
    updated = await zoozaFetch<RawTodoUpdate>(
      `/todos/${input.todo_id}`,
      { method: "PUT", body: { status: input.status } },
      callAuth,
    );
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      if (error.status === 404) return errorResult(`No todo ${input.todo_id} in this company.`);
      if (error.status === 403) {
        return errorResult("Only the todo's creator or assignee can change it.");
      }
      if (error.status >= 500 || error.status === 0) {
        return errorResult(`Zooza did not confirm the todo change (upstream ${error.status}). Safe to retry.`);
      }
      // api-v1 enforces the transition lattice — surface its rejection, which
      // names the illegal transition (open→done/cancelled, done→open, cancelled→open).
      return errorResult(
        `Cannot change todo ${input.todo_id} to ${input.status}: ${error.humanMessage}. Allowed: open→done/cancelled, done→open, cancelled→open.`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const result: TodoMarkResult = {
    todo_id: input.todo_id,
    status: pickStr(updated?.status) ?? pickStr(updated?.data?.status) ?? input.status,
    completed_at: updated?.completed_at ?? updated?.data?.completed_at ?? null,
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
