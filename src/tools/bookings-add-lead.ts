import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr } from "./common.js";

export const bookingsAddLeadTitle = "Add a lead (minimal registration on a lead-collection schedule)";

export const bookingsAddLeadDescription =
  "Create a LEAD — a lightweight registration on a lead-collection schedule — for a prospective customer, from " +
  "their name and email. Use this to capture an inbound enquiry as a trackable Zooza record you can later label, " +
  "message, and check for conversion. It does NOT enrol the person in a real class, take payment, or email the " +
  "customer (the server authenticates with an App-type key, which sends no customer communication). It works ONLY " +
  "against schedules whose type is `lead_collection`; for a genuine class booking, or anything that should charge " +
  "or notify the customer, do NOT use this tool. Not idempotent — calling twice creates two leads, so the caller " +
  "must guard against re-processing the same enquiry. Returns the new registration id (the `order_id` that " +
  "`comms_find_replies` and `labels_mark` consume downstream).";

export const bookingsAddLeadInputSchema = {
  company_id: companyIdSchema,
  schedule_id: z
    .number()
    .int()
    .positive()
    .describe("The lead-collection schedule (the lead 'pipeline') to attach the lead to. Must be a schedule_type='lead_collection' schedule — the tool refuses any other."),
  first_name: z.string().min(1).describe("Lead's first name. Required."),
  last_name: z.string().min(1).describe("Lead's last name. Required."),
  email: z.string().min(1).describe("Lead's email. Required — the key downstream conversion detection matches on."),
  phone: z
    .string()
    .optional()
    .describe("Lead's phone, free-text, if the enquiry included one."),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Parent programme id. Optional — derived from the schedule when omitted; only pass it to skip the lookup."),
};

const inputSchema = z.object(bookingsAddLeadInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: AddLeadResult;
};

export interface AddLeadResult {
  [key: string]: unknown;
  registration_id: number;
  schedule_id: number;
  course_id: number;
  email: string;
  /** api-v1 reports whether a confirmation email was sent — false confirms the
   *  App-key silent-insert (no customer email). */
  confirmation_sent: boolean;
}

/** Minimal schedule shape read by the lead-collection guard. */
interface RawScheduleForLead {
  id?: number;
  course_id?: number;
  schedule_type?: string;
}

/** POST /registrations success body (App/manual path): the new id is in
 *  `registrations[]` — NOT a top-level `id`. `confirmation_sent` reports whether a
 *  customer email went out. Legacy keys kept as defensive fallbacks. */
interface RawRegistrationCreate {
  registrations?: Array<number | string>;
  confirmation_sent?: boolean;
  id?: number | string;
  registration_id?: number | string;
}

export async function runBookingsAddLead(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `bookings_add_lead needs first_name, last_name and email (and a lead schedule_id). Invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  // Step 1 (guard) — prove the target is a lead_collection schedule and derive course_id.
  // The schedule-type guard is the blast-radius bound: it stops this tool ever creating a
  // real registration (which would charge/email) against a normal class.
  let schedule: RawScheduleForLead;
  try {
    const raw = await zoozaFetch<RawScheduleForLead | { data?: RawScheduleForLead }>(
      `/schedules/${input.schedule_id}`,
      {},
      callAuth,
    );
    schedule = (raw as { data?: RawScheduleForLead })?.data ?? (raw as RawScheduleForLead);
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      if (error.status === 404) {
        return errorResult(
          `No schedule ${input.schedule_id} in this company. Resolve a lead-collection schedule first.`,
        );
      }
      return errorResult(`Could not read schedule ${input.schedule_id} (api-v1 ${error.status}: ${error.humanMessage}).`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const scheduleType = pickStr(schedule?.schedule_type);
  if (scheduleType !== "lead_collection") {
    return errorResult(
      `Schedule ${input.schedule_id} is not a lead_collection schedule (schedule_type=${scheduleType ?? "unset"}). ` +
        "bookings_add_lead only creates leads on lead-collection schedules — refusing, so no customer is enrolled or emailed.",
    );
  }

  const courseId = input.course_id ?? schedule.course_id;
  if (courseId === undefined || courseId === null) {
    return errorResult(
      `Schedule ${input.schedule_id} did not report a course_id and none was supplied — cannot create the lead. Pass course_id explicitly.`,
    );
  }

  // Step 2 — POST /registrations with the fixed minimal lead payload.
  const body = {
    course_id: courseId,
    schedule_id: input.schedule_id,
    schedule_full_opt_in: true,
    late_registration_opt_in: true,
    payment_method: "cash",
    payment_method_transfer_options: "",
    persons: [
      {
        basic_fields: {
          buyer: {
            id: null,
            first_name: input.first_name,
            last_name: input.last_name,
            email: input.email,
            phone: input.phone ?? "",
          },
        },
      },
    ],
  };

  let created: RawRegistrationCreate;
  try {
    created = await zoozaFetch<RawRegistrationCreate>(
      "/registrations",
      { method: "POST", body },
      callAuth,
    );
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      if (error.status >= 500 || error.status === 0) {
        return errorResult(
          `Zooza did not confirm the lead (upstream ${error.status}). No lead was recorded; safe to retry.`,
        );
      }
      return errorResult(`Zooza rejected the lead: ${error.humanMessage}.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  // The new id lives in `registrations[]` (App/manual path). Legacy keys are a
  // defensive fallback in case of shape drift.
  const registrationId = toId(created?.registrations?.[0] ?? created?.id ?? created?.registration_id);
  if (registrationId === undefined) {
    return errorResult(
      "Lead POST returned no registration id in `registrations[]` — the lead may or may not exist. " +
        "Check with bookings_find (search: the email) before retrying.",
    );
  }

  const result: AddLeadResult = {
    registration_id: registrationId,
    schedule_id: input.schedule_id,
    course_id: courseId,
    email: input.email,
    confirmation_sent: created?.confirmation_sent === true,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toId(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
