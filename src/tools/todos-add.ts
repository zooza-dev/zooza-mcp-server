import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr } from "./common.js";

const ENTITY_TYPES = [
  "registration",
  "event",
  "course",
  "schedule",
  "payment",
  "scheduled_payment",
  "person",
  "user",
  "system_message",
  "slack_message",
] as const;

export const todosAddTitle = "Create an operator to-do item";

export const todosAddDescription =
  "Create a to-do item for a Zooza operator — a task a human needs to action. Give it a `message` and the " +
  "`to_user_id` of the person it's assigned to. Optionally link it to a record (`entity_type` + `entity_id`, e.g. a " +
  "registration) so the operator can open the thing it's about, and set a `due_date`. Use this to escalate — e.g. a " +
  "lead asked a question that needs a human reply. It creates an OPEN todo in Zooza's normal to-do list; it does " +
  "not email anyone. There is no `inbound_reply` entity type — link a reply escalation to its registration instead.";

export const todosAddInputSchema = {
  company_id: companyIdSchema,
  message: z.string().min(1).max(500).describe("The task text (≤500 chars). Required."),
  to_user_id: z
    .number()
    .int()
    .positive()
    .describe(
      "The Zooza user id of the operator this todo is assigned to. Required. Resolve a person's id with " +
        "classes_find_resource (kind:'trainer') — operators/instructors share that id space; never guess it. A wrong " +
        "id silently creates a to-do nobody sees.",
    ),
  entity_type: z
    .enum(ENTITY_TYPES)
    .optional()
    .describe("Optionally link the todo to a record kind (e.g. 'registration'). Requires entity_id."),
  entity_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Id of the linked record. Required when entity_type is set."),
  due_date: z.string().optional().describe("Optional due date, YYYY-MM-DD."),
};

const inputSchema = z.object(todosAddInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TodoAddResult;
};

export interface TodoAddResult {
  [key: string]: unknown;
  todo_id: number;
  status: string;
  message: string;
  to_user_id: number;
  entity_type?: string;
  entity_id?: number;
}

interface RawTodoCreate {
  id?: number | string;
  status?: string;
  data?: { id?: number | string; status?: string };
}

export async function runTodosAdd(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `todos_add needs both message and to_user_id (the assignee). Invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  if (input.entity_type !== undefined && input.entity_id === undefined) {
    return errorResult("entity_id is required when entity_type is set.");
  }

  const callAuth = withCompany(auth, input.company_id!);
  const body: Record<string, unknown> = { message: input.message, to_user_id: input.to_user_id };
  if (input.entity_type !== undefined) {
    body.entity_type = input.entity_type;
    body.entity_id = input.entity_id;
  }
  if (input.due_date) body.due_date = input.due_date;

  let created: RawTodoCreate;
  try {
    created = await zoozaFetch<RawTodoCreate>("/todos", { method: "POST", body }, callAuth);
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      if (error.status >= 500 || error.status === 0) {
        return errorResult(`Zooza did not confirm the todo (upstream ${error.status}). Safe to retry.`);
      }
      return errorResult(`Zooza rejected the todo: ${error.humanMessage}.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const todoId = toId(created?.id ?? created?.data?.id);
  if (todoId === undefined) {
    return errorResult("Todo POST returned no id — it may or may not exist. Check before retrying.");
  }
  const result: TodoAddResult = {
    todo_id: todoId,
    status: pickStr(created?.status) ?? pickStr(created?.data?.status) ?? "open",
    // Echo the stored message back so the caller can confirm the text round-tripped
    // intact — matters for accented (Slovak) input.
    message: input.message,
    to_user_id: input.to_user_id,
    ...(input.entity_type !== undefined ? { entity_type: input.entity_type, entity_id: input.entity_id } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function toId(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
