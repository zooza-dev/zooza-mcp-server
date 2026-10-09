import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";

export const findOrdersTitle = "Find a client's product orders";

export const findOrdersDescription =
  "List product orders (e.g. a competition entry fee or pass bought on a client profile) with payment state. Course bookings are NOT orders — use bookings_find for those. " +
  "Needs at least one of user_id, registration_id, product_name, created_from (no whole-company dump). Newest first. " +
  "Per order: charged (amount owed), paid, balance = paid - charged (negative = still owed; 0 = settled), payment_status (paid | unpaid | no_debt | null). " +
  "Read-only; contact details are not returned.";

const STATUSES = ["pending", "new", "completed", "deleted"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const findOrdersInputSchema = {
  company_id: companyIdSchema,
  user_id: z.number().int().optional().describe("Client id (from bookings_find)."),
  registration_id: z.number().int().optional().describe("Orders linked to this booking."),
  product_name: z.string().optional().describe("Substring of the product name."),
  payment_status: z
    .enum(["paid", "unpaid"])
    .optional()
    .describe("Filter paid or unpaid; api supports no other values."),
  status: z
    .enum(STATUSES)
    .optional()
    .describe("ONE order status. Omit = all except deleted."),
  created_from: z.string().regex(DATE).optional().describe("YYYY-MM-DD."),
  created_to: z.string().regex(DATE).optional().describe("YYYY-MM-DD."),
  page: z.number().int().min(0).optional().describe("0-based (default 0)."),
  page_size: z.number().int().min(1).max(100).optional().describe("Default 20, max 100."),
};

const inputSchema = z.object(findOrdersInputSchema);

export interface RawOrderRow {
  id: number;
  status?: string;
  payment_status?: string | null;
  created?: string;
  user_id?: number;
  currency?: string | null;
  __calc__debt?: number | string | null;
  __calc__paid?: number | string | null;
  __calc__balance?: number | string | null;
  __users__full_name?: string | null;
  __products__name?: string | null;
}

export interface OrderRow {
  order_id: number;
  product_name: string;
  status: string;
  payment_status: string | null;
  charged: number;
  paid: number;
  balance: number;
  currency: string | null;
  created: string;
  user_id: number | null;
  client_name: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** Live (api-test, 2026-10-09): __calc__debt is negative (-90 for a 90 charge),
 *  __calc__paid positive, __calc__balance = paid + debt (negative = still owed). */
export function projectOrder(o: RawOrderRow): OrderRow {
  return {
    order_id: o.id,
    product_name: o.__products__name ?? "",
    status: o.status ?? "",
    payment_status: o.payment_status ?? null,
    charged: Math.abs(num(o.__calc__debt)),
    paid: num(o.__calc__paid),
    balance: num(o.__calc__balance),
    currency: o.currency ?? null,
    created: o.created ?? "",
    user_id: o.user_id ?? null,
    client_name: o.__users__full_name ?? "",
  };
}

export async function runFindOrders(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  if (
    input.user_id === undefined &&
    input.registration_id === undefined &&
    !input.product_name &&
    !input.created_from
  ) {
    return errorResult(
      "Pass at least one of user_id, registration_id, product_name or created_from — refusing to dump every order in the company.",
    );
  }

  const page = input.page ?? 0;
  const pageSize = input.page_size ?? 20;
  const query: Record<string, string | number | undefined> = {
    page,
    page_size: pageSize,
    user_id: input.user_id,
    registration_id: input.registration_id,
    product_name: input.product_name,
    payment_status: input.payment_status,
    // Single value only: Collection/Orders.php:136-150 wraps `status` as one-element array.
    status: input.status,
    created_from: input.created_from,
    created_to: input.created_to,
  };

  try {
    // Collection only — GET /orders/{id} has write side effects (orders.php:421-467).
    const raw = await zoozaFetch<unknown>("/orders", { query }, withCompany(auth, input.company_id!));
    const { records, total } = unwrapList<RawOrderRow>(raw as never);
    const result = {
      orders: records.map(projectOrder),
      total,
      page,
      page_size: pageSize,
      truncated: total > (page + 1) * pageSize,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(`Could not load orders (api-v1 ${error.status}: ${error.humanMessage}).`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
