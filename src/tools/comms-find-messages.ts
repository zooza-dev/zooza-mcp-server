import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch, zoozaFetchText } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import type { ApiListResponse } from "./types.js";

// comms_find_messages — a client's communication history: emails Zooza sent,
// replies that came back, and SMS (issue #21).
//
// Source: GET /messages (messages.php:47-63), a UNION of three tables — emails
// (outbound), inbound_replies and sms_messages (Collection/Messages.php:26-110).
// Facts that shape this tool, verified live on api-test 2026-10-09:
//  - The client is targeted by registration: `order_id` filters all three parts
//    (Messages.php:185-190). There is no user_id filter, and emails tied to a
//    registration carry no user_id (GET /emails?user_id=12047 → 1 account email,
//    order_id=52816 → 7). So user_id is resolved to its registrations first.
//  - page/page_size apply to EACH part of the union separately (Messages.php:117-119):
//    page_size 3 returned 9 rows, sorted per part only. We therefore ask each
//    registration for `limit` rows, merge, sort newest-first and cut to `limit`.
//    Offset paging across the union is meaningless, so there is none — `since`
//    narrows instead. `date_to` is not used: it binds :date_from (Messages.php:200-206).
//  - Outbound `order_id` is only meaningful with order_type "course"; product orders
//    share the id space and system mails (zooza_login codes, invitations) have an
//    empty order_type. Only "course" rows are returned.
//  - The list carries no email body. GET /emails/{id}/body (emails.php:6-19) returns
//    the stored HTML, which is the TEMPLATE: *|MERGE_TAGS|* are filled in at send
//    time, so the stored text still shows them.

const TYPE_VALUES = ["email", "reply", "sms"] as const;
const API_TYPE: Record<(typeof TYPE_VALUES)[number], string> = { email: "outbound", reply: "inbound", sms: "sms" };

const MAX_LIMIT = 50;
const MAX_REGISTRATIONS = 20;
const SNIPPET_CHARS = 300;
const BODY_CHARS = 4_000;

export const commsFindMessagesTitle = "Read a client's message history (sent emails, replies, SMS)";

export const commsFindMessagesDescription =
  "A client's communication history, newest first: emails Zooza sent them, their replies, and SMS. Target ONE " +
  "booking with `registration_id` or a whole client with `user_id` (all their bookings) — resolve via bookings_find. " +
  "Rows: sent emails show subject, template, delivery status and when opened; replies and SMS show their text " +
  "(shortened). To read one sent email's text, call again with `registration_id` + `message_id`; stored email " +
  "text is the template, so *|TAGS|* appear unfilled. Read-only. For unread replies to act on, use comms_find_replies.";

export const commsFindMessagesInputSchema = {
  company_id: companyIdSchema,
  registration_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Messages tied to this booking. Required with message_id."),
  user_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`All bookings of this client (up to ${MAX_REGISTRATIONS} newest), merged.`),
  types: z
    .array(z.enum(TYPE_VALUES))
    .optional()
    .describe("Limit to email (sent by Zooza), reply (from the client), sms. Default all."),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .optional()
    .describe("Only messages on/after this date (YYYY-MM-DD)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Newest N messages (default 20, max ${MAX_LIMIT}).`),
  message_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("A sent email's id from a previous result → returns its text instead of the list."),
};

const inputSchema = z.object(commsFindMessagesInputSchema);

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

interface RawMessage {
  type?: string;
  outbound?: {
    id?: number;
    order_id?: number;
    order_type?: string;
    email?: string;
    status?: string;
    reject_reason?: string;
    tag?: string;
    subject?: string;
    sent_by?: string;
    created?: string;
    opened?: string | null;
  };
  inbound?: { id?: number; order_id?: number; from?: string; subject?: string; message?: string; created?: string };
  sms?: { id?: number; registration_id?: number; phone?: string; message?: string; status?: string; created?: string };
}

export interface MessageRow {
  type: "email" | "reply" | "sms";
  id: number;
  registration_id: number;
  created: string;
  /** email: recipient; reply: sender; sms: phone. */
  contact: string;
  subject?: string;
  /** reply / sms text, shortened. */
  text?: string;
  /** email: Zooza template key (e.g. first_reminder, event_notification). */
  template?: string;
  status?: string;
  opened?: string;
  sent_by?: string;
}

export async function runCommsFindMessages(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  if (input.registration_id === undefined && input.user_id === undefined) {
    return errorResult(
      "comms_find_messages needs a client: registration_id or user_id (resolve with bookings_find).",
    );
  }

  try {
    if (input.message_id !== undefined) {
      if (input.registration_id === undefined) {
        return errorResult("message_id needs the registration_id it was listed under.");
      }
      return await readEmail(input.registration_id, input.message_id, callAuth);
    }

    const limit = input.limit ?? 20;
    let registrationIds: number[];
    let registrationsTruncated = false;
    if (input.registration_id !== undefined) {
      registrationIds = [input.registration_id];
    } else {
      const found = await registrationsOfUser(input.user_id!, callAuth);
      registrationIds = found.ids.slice(0, MAX_REGISTRATIONS);
      registrationsTruncated = found.ids.length > MAX_REGISTRATIONS;
      if (registrationIds.length === 0) {
        return errorResult(`No bookings found for user_id ${input.user_id} — messages are tied to bookings.`);
      }
    }

    // limit + 1 per registration so `truncated` can tell "exactly limit" from "more".
    const query: Record<string, string | number> = { sort_by: "created_desc", page_size: limit + 1 };
    if (input.types?.length) query.type = input.types.map((t) => API_TYPE[t]).join("|");
    if (input.since) query.date_from = input.since;

    const pages = await Promise.all(
      registrationIds.map((id) =>
        zoozaFetch<ApiListResponse<RawMessage> | RawMessage[]>("/messages", { query: { ...query, order_id: id } }, callAuth),
      ),
    );
    const rows = pages
      .flatMap((p) => unwrapList<RawMessage>(p).records)
      .map(projectMessage)
      .filter((r): r is MessageRow => r !== null)
      .sort((a, b) => b.created.localeCompare(a.created));
    const messages = rows.slice(0, limit);

    const result = {
      messages,
      count: messages.length,
      // More exist than shown — narrow with `since`/`types` or raise `limit`.
      truncated: rows.length > limit,
      registration_ids: registrationIds,
      ...(registrationsTruncated
        ? { note: `Client has more than ${MAX_REGISTRATIONS} bookings; only the ${MAX_REGISTRATIONS} newest were read.` }
        : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(`Could not read messages (api-v1 ${error.status}: ${error.humanMessage}).`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/** Every non-deleted booking of a client, newest first. No `status` param: api-v1's
 *  default then hides only `deleted` (common.php:8875), so canceled and past
 *  bookings — whose messages are still history — are included. */
async function registrationsOfUser(userId: number, auth: ZoozaAuth): Promise<{ ids: number[] }> {
  const envelope = await zoozaFetch<{ results?: Array<{ registration_id?: number; created?: string }> }>(
    "/registrations",
    { query: { advanced_search: 1, user_id: userId, page_size: 200 } },
    auth,
  );
  const ids = (envelope?.results ?? [])
    .map((r) => r.registration_id ?? 0)
    .filter((id) => id > 0)
    .sort((a, b) => b - a);
  return { ids: [...new Set(ids)] };
}

async function readEmail(registrationId: number, messageId: number, auth: ZoozaAuth): Promise<ToolResult> {
  // Prove the email belongs to this booking before reading it — /emails/{id}/body
  // alone would hand out any email id, including system mails with login codes.
  const raw = await zoozaFetch<ApiListResponse<RawMessage> | RawMessage[]>(
    "/messages",
    { query: { order_id: registrationId, type: "outbound", sort_by: "created_desc", page_size: 500 } },
    auth,
  );
  const meta = unwrapList<RawMessage>(raw)
    .records.map(projectMessage)
    .find((r) => r?.type === "email" && r.id === messageId);
  if (!meta) {
    return errorResult(`Email ${messageId} is not among the emails sent for registration ${registrationId}.`);
  }
  const html = await zoozaFetchText(`/emails/${messageId}/body`, {}, auth);
  const text = htmlToText(html);
  const result = {
    message: {
      ...meta,
      text: text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}…` : text,
      note: "Stored template text — *|TAGS|* were filled with the client's data when it was sent.",
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function projectMessage(m: RawMessage): MessageRow | null {
  if (m.type === "outbound" && m.outbound) {
    const o = m.outbound;
    if (o.order_type !== "course") return null;
    return {
      type: "email",
      id: Number(o.id ?? 0),
      registration_id: Number(o.order_id ?? 0),
      created: pickStr(o.created) ?? "",
      contact: pickStr(o.email) ?? "",
      subject: pickStr(o.subject),
      template: pickStr(o.tag),
      status: [pickStr(o.status), pickStr(o.reject_reason)].filter(Boolean).join(": ") || undefined,
      opened: pickStr(o.opened ?? undefined),
      sent_by: pickStr(o.sent_by),
    };
  }
  if (m.type === "inbound" && m.inbound) {
    const i = m.inbound;
    return {
      type: "reply",
      id: Number(i.id ?? 0),
      registration_id: Number(i.order_id ?? 0),
      created: pickStr(i.created) ?? "",
      contact: pickStr(i.from) ?? "",
      subject: pickStr(i.subject),
      text: snippet(i.message),
    };
  }
  if (m.type === "sms" && m.sms) {
    const s = m.sms;
    return {
      type: "sms",
      id: Number(s.id ?? 0),
      registration_id: Number(s.registration_id ?? 0),
      created: pickStr(s.created) ?? "",
      contact: pickStr(s.phone) ?? "",
      text: snippet(s.message),
      status: pickStr(s.status),
    };
  }
  return null;
}

function snippet(v: unknown): string | undefined {
  const t = pickStr(v);
  if (!t) return undefined;
  const flat = t.replace(/\s+/g, " ");
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
