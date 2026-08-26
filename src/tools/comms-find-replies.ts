import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import type { ApiListResponse } from "./types.js";

const READ_STATES = ["unread", "todo", "resolved", "all"] as const;
const MARK_STATES = ["read", "todo", "resolved"] as const;

export const commsFindRepliesTitle = "Read inbound customer replies and set a reply's state";

export const commsFindRepliesDescription =
  "Read inbound replies a customer has sent back to Zooza emails, and optionally mark a reply handled. Use it to " +
  "see whether a lead responded and what they said — filter by the lead's registration id, sender email, state " +
  "(unread / todo / resolved), or date. To act on a reply, pass `mark_reply_id` + `mark_state` to flag it `todo` " +
  "(needs a human) or `resolved` (handled), or `read`. Replies only appear here if the original email went out " +
  "through Zooza tied to that registration. This does NOT send anything — use comms_send_message to reply. The " +
  "idempotency pattern: read `unread` replies, act, then mark `resolved` so the same reply isn't handled twice.";

export const commsFindRepliesInputSchema = {
  company_id: companyIdSchema,
  registration_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The lead's registration id (the inbound reply's order_id). The usual filter — a lead's replies."),
  from_email: z.string().optional().describe("Filter by sender email (partial match)."),
  state: z
    .enum(READ_STATES)
    .optional()
    .describe("Which replies to return: 'unread' (default), 'todo', 'resolved', or 'all'."),
  since: z.string().optional().describe("Only replies on/after this date (YYYY-MM-DD)."),
  mark_reply_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("If set, MARK this reply's state instead of listing. Requires mark_state."),
  mark_state: z
    .enum(MARK_STATES)
    .optional()
    .describe("Required with mark_reply_id: 'read', 'todo', or 'resolved'."),
};

const inputSchema = z.object(commsFindRepliesInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: FindRepliesResult | MarkReplyResult;
};

export interface ReplyMatch {
  reply_id: number;
  registration_id: number;
  from: string;
  subject: string;
  message: string;
  state: "unread" | "read" | "todo" | "resolved";
  created: string;
}
export interface FindRepliesResult {
  [key: string]: unknown;
  replies: ReplyMatch[];
  count: number;
  total: number;
  truncated: boolean;
}
export interface MarkReplyResult {
  [key: string]: unknown;
  marked: { reply_id: number; state: (typeof MARK_STATES)[number] };
}

/** A /messages/inbound row: top level carries only `type` + empty outbound/sms
 *  sub-objects; the real reply fields are nested under `inbound`. */
interface RawReplyRecord {
  type?: string;
  inbound?: {
    id?: number | string;
    order_id?: number | string;
    from?: string;
    subject?: string;
    message?: string;
    created?: string;
    read?: number | string | boolean;
    todo?: number | string | boolean;
    todo_resolved?: number | string | boolean;
  };
}

export async function runCommsFindReplies(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  // MARK mode.
  if (input.mark_reply_id !== undefined) {
    if (input.mark_state === undefined) {
      return errorResult("mark_state is required with mark_reply_id (read | todo | resolved).");
    }
    // Column mapping — read=1 marks read; todo=1 raises the reply todo; todo=0 resolves it
    // (api-v1 stamps todo_resolved). ⚠️ Confirm against inbound_mail.php at deploy time.
    const body: Record<string, number> =
      input.mark_state === "read" ? { read: 1 } : input.mark_state === "todo" ? { todo: 1 } : { todo: 0 };
    try {
      await zoozaFetch(`/inbound_mail/${input.mark_reply_id}`, { method: "PUT", body }, callAuth);
    } catch (error) {
      if (error instanceof ZoozaApiError) {
        if (error.status === 404) return errorResult(`No inbound reply ${input.mark_reply_id} in this company.`);
        return errorResult(`Zooza inbound is unavailable (upstream ${error.status}). Try again shortly.`);
      }
      return errorResult(error instanceof Error ? error.message : String(error));
    }
    const result: MarkReplyResult = { marked: { reply_id: input.mark_reply_id, state: input.mark_state } };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }

  // READ mode — require at least one bound so we never dump every reply.
  if (input.registration_id === undefined && !input.from_email && !input.since) {
    return errorResult(
      "comms_find_replies needs a filter (registration_id, from_email, since) or a mark action — refusing to dump every reply.",
    );
  }

  const state = input.state ?? "unread";
  const query: Record<string, string | number | undefined> = {
    sort_by: "created_desc",
    page_size: 50,
  };
  if (input.registration_id !== undefined) query.order_id = input.registration_id;
  if (input.from_email) query.query = input.from_email;
  if (input.since) query.date_from = input.since;
  if (state === "unread") query.state = "unread";
  else if (state === "todo") query.state = "todo";
  else if (state === "resolved") query.state = "resolved_todo";
  // state === "all" → no state filter.

  try {
    const raw = await zoozaFetch<ApiListResponse<RawReplyRecord> | RawReplyRecord[]>(
      "/messages/inbound",
      { query },
      callAuth,
    );
    const { records, total } = unwrapList<RawReplyRecord>(raw);
    const replies = records.map(projectReply);
    // page_size is 50; surface when the server has more than this page returned.
    const result: FindRepliesResult = {
      replies,
      count: replies.length,
      total,
      truncated: total > replies.length,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(`Zooza inbound is unavailable (upstream ${error.status}). Try again shortly.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function projectReply(r: RawReplyRecord): ReplyMatch {
  const i = r.inbound ?? {};
  return {
    reply_id: Number(i.id ?? 0),
    registration_id: Number(i.order_id ?? 0),
    from: pickStr(i.from) ?? "",
    subject: pickStr(i.subject) ?? "",
    message: pickStr(i.message) ?? "",
    state: replyState(i),
    created: pickStr(i.created) ?? "",
  };
}

function replyState(i: NonNullable<RawReplyRecord["inbound"]>): ReplyMatch["state"] {
  if (truthy(i.todo_resolved)) return "resolved";
  if (truthy(i.todo)) return "todo";
  if (truthy(i.read)) return "read";
  return "unread";
}

function truthy(v: number | string | boolean | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "" && v !== "0";
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
