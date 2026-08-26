import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";

/**
 * Create a company payment schedule template (spec ZMCP-20260824-004).
 *
 * Create is side-effect free: api-v1 does NOT attach the template to any course and
 * generates no `payment_schedules` rows (research payment_templates.md §2). Attaching
 * is the separate, optional second step below.
 *
 * Deliberately create-only. Update and delete both carry data-loss traps:
 * `PUT` calls sync_to_all_courses() unconditionally and discards every per-course
 * price override; `DELETE` is a hard delete leaving live group plans with a dangling
 * template id, with no restore. Both need their own spec.
 */

// `subscription` exists in the DB enum but has no PHP const, no allow-list entry, and
// is absent from the `payment_schedules` enum — dead legacy. Not offered.
const SCHEDULE_TYPES = ["single_payment", "in_advance", "by_attendance", "pay_as_you_go"] as const;
const FREQUENCIES = ["monthly", "quarterly", "half_yearly", "yearly", "after_events", "absolute"] as const;
const DISCOUNTS = ["none", "absolute", "relative"] as const;
const ROUNDING = [
  "none",
  "round_down",
  "round_up",
  "round_half_up",
  "round_half_down",
  "bata",
] as const;

const PERIODIC: ReadonlySet<string> = new Set(["monthly", "quarterly", "half_yearly", "yearly"]);

export const addPaymentTemplateTitle = "Create a payment plan template";

export const addPaymentTemplateDescription =
  "Create a company-level payment plan template (\"splátková šablóna\") — the object that defines HOW a programme's " +
  "price is collected: in how many instalments, how often, with what discount and rounding. A programme set to " +
  "instalment collection produces NO instalment schedule until a template is attached, so this is the step that " +
  "makes instalment billing actually happen.\n\n" +
  "CRITICAL — the template does NOT carry the price. The amount always comes from the programme/class; the " +
  "template only says how to split it. So \"€200 in 4 × €50\" is: programme price 200 (set via " +
  "classes_add_course or classes_update_course_settings) PLUS this template with frequency: 'absolute', value: 4. " +
  "The €50 is derived. Never put 50 in `value`.\n\n" +
  "What `value` means depends on `frequency`:\n" +
  "- `absolute` → the TOTAL NUMBER of instalments (4 = four payments). This is the usual choice for \"split into N\".\n" +
  "- `after_events` → number of sessions per instalment (charge every N sessions).\n" +
  "- `monthly` / `quarterly` / `half_yearly` / `yearly` → `value` is NOT used for dates; set `value_date` to the " +
  "day of month to bill on (0 = anchor to the start date).\n" +
  "- With `schedule_type: 'pay_as_you_go'` → `value` is a UNIT MULTIPLIER, not money: the client is charged " +
  "value × the programme's unit_price. Keep it a small count.\n\n" +
  "`schedule_type` must match the programme's price type: 'in_advance', 'single_payment' and 'by_attendance' work " +
  "with a normal course fee; 'pay_as_you_go' is for membership pricing. Pass `course_id` to attach the template to " +
  "a programme immediately — Zooza validates the combination and rejects a mismatch with the reason. Without " +
  "`course_id` the template is created but attached to nothing (still fine — attach it later or in the app). " +
  "Requires the edit_company permission.";

export const addPaymentTemplateInputSchema = {
  company_id: companyIdSchema,
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Operator-facing name, e.g. \"4 monthly instalments\". Strongly recommended — it appears in pickers."),
  schedule_type: z
    .enum(SCHEDULE_TYPES)
    .describe(
      "'in_advance' = pay ahead on a cadence (the usual instalment plan). 'single_payment' = one payment. " +
        "'by_attendance' = charged from attendance. 'pay_as_you_go' = membership pricing, where `value` becomes a " +
        "unit multiplier on the programme's unit_price.",
    ),
  frequency: z
    .enum(FREQUENCIES)
    .describe(
      "How often instalments fall. 'absolute' = a fixed TOTAL COUNT of instalments (see `value`). " +
        "'after_events' = every N sessions. The periodic ones bill on `value_date` each period.",
    ),
  value: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Meaning depends on frequency — see the tool description. absolute → number of instalments; after_events → " +
        "sessions per instalment; periodic → unused; pay_as_you_go → unit multiplier. NEVER a money amount.",
    ),
  value_date: z
    .number()
    .int()
    .min(0)
    .max(31)
    .optional()
    .describe("Day of month to bill on, for the periodic frequencies. 0 (default) anchors to the start date."),
  skip_empty_period: z
    .boolean()
    .optional()
    .describe("Default false. true skips periods that contain no sessions."),
  discount: z
    .enum(DISCOUNTS)
    .optional()
    .describe("Default 'none'. A plan-level discount, e.g. to reward paying in one go."),
  discount_value_absolute: z.number().nonnegative().optional().describe("Used when discount is 'absolute'."),
  discount_value_relative: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Percent, used when discount is 'relative'."),
  rounding_method: z
    .enum(ROUNDING)
    .optional()
    .describe("Default 'none'. 'bata' is .99-style pricing."),
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional. Attach the new template to this programme right away. Zooza validates it against the " +
        "programme's price type and rejects a mismatch. Resolve with classes_find_courses.",
    ),
};

const inputSchema = z.object(addPaymentTemplateInputSchema);

interface RawTemplate {
  id?: number | string;
  name?: string;
  schedule_type?: string;
  frequency?: string;
  value?: number | string;
  [k: string]: unknown;
}

export async function runAddPaymentTemplate(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  // Local matrix check. api-v1 does NO cross-field validation at create time —
  // frequency/schedule_type compatibility is only checked on the ATTACH path — so a
  // template created without course_id could be internally incoherent and only fail
  // much later, when someone tries to bill with it.
  const matrixError = validateValueMatrix(input);
  if (matrixError) return errorResult(matrixError);

  const callAuth = withCompany(auth, input.company_id!);
  const warnings: string[] = [];

  const body: Record<string, unknown> = {
    // api-v1 forces company_id from the auth context regardless (Payment_Schedule_Template.php:72);
    // sent for contract completeness only.
    company_id: input.company_id,
    schedule_type: input.schedule_type,
    frequency: input.frequency,
    discount: input.discount ?? "none",
    skip_empty_period: input.skip_empty_period ?? false,
  };
  if (input.name !== undefined) body.name = input.name;
  if (input.value !== undefined) body.value = input.value;
  if (input.value_date !== undefined) body.value_date = input.value_date;
  if (input.rounding_method !== undefined) body.rounding_method = input.rounding_method;
  if (input.discount_value_absolute !== undefined)
    body.discount_value_absolute = input.discount_value_absolute;
  if (input.discount_value_relative !== undefined)
    body.discount_value_relative = input.discount_value_relative;

  let template: RawTemplate;
  try {
    const raw = await zoozaFetch<{ data?: RawTemplate } | RawTemplate>(
      "/payment_schedules_templates",
      { method: "POST", body },
      callAuth,
    );
    template = (raw as { data?: RawTemplate })?.data ?? (raw as RawTemplate);
  } catch (error) {
    return errorResult(createFailureMessage(error));
  }

  const templateId = toInt(template?.id);
  if (templateId === null) {
    return errorResult(
      "Zooza accepted the request but returned no template id — the template may or may not exist. Check the " +
        "company's payment plan templates in the Zooza app before creating another one.",
    );
  }

  // Optional attach. Deliberately the SINGLE-template endpoint: the bulk variant
  // ({payment_schedules_templates: [...]}) treats its array as the complete desired
  // set and detaches everything absent from it — an empty or all-invalid array
  // hard-deletes every binding on the course.
  let attached = false;
  if (input.course_id !== undefined) {
    try {
      await zoozaFetch<unknown>(
        `/courses/${input.course_id}/payment_schedules_templates`,
        { method: "POST", body: { template_id: templateId } },
        callAuth,
      );
      attached = true;
    } catch (error) {
      // Never roll back and never retry — the template exists and is reusable; a
      // retry would risk a duplicate. Surface it and let the operator decide.
      const detail =
        error instanceof ZoozaApiError ? `${error.status}: ${error.humanMessage}` : String(error);
      warnings.push(
        `The template was created (id ${templateId}) but could NOT be attached to programme ${input.course_id} ` +
          `(${detail}). Do not create it again. Common cause: the plan type does not match the programme's price ` +
          "type — 'pay_as_you_go' needs membership pricing, the others need a course fee. Attach it in the Zooza " +
          "app, or fix the programme's price type and attach it there.",
      );
    }
  }

  if (input.schedule_type === "pay_as_you_go" && (input.value ?? 0) > 20) {
    warnings.push(
      `value ${input.value} looks like a money amount, but for pay_as_you_go it is a UNIT MULTIPLIER — the client ` +
        `is charged ${input.value} × the programme's unit_price. If you meant a price, set it on the programme instead.`,
    );
  }
  if (input.course_id === undefined) {
    warnings.push(
      "Created but not attached to any programme — it will not bill anything yet. Re-call with course_id, or " +
        "attach it in the Zooza app.",
    );
  }

  const result = {
    created: true,
    template: {
      id: templateId,
      name: template.name ?? input.name ?? null,
      schedule_type: input.schedule_type,
      frequency: input.frequency,
      value: input.value ?? null,
      value_date: input.value_date ?? null,
      discount: input.discount ?? "none",
    },
    attached_to_course_id: attached ? input.course_id : null,
    warnings,
    next_steps: attached
      ? "The programme now has a payment plan. Make sure the programme's price and instalment collection are set " +
        "(classes_update_course_settings, section price_and_payment), then create its class with " +
        "classes_preview_schedule → classes_commit_class."
      : "Attach this template to a programme before it can bill — re-call with course_id, or do it in the Zooza app.",
  };

  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/**
 * Guards the polymorphic `value`. The failure this prevents is silent: a template
 * with frequency 'absolute' and no value produces a plan that bills nothing, and
 * nobody finds out until an invoice should have gone.
 */
function validateValueMatrix(input: z.infer<typeof inputSchema>): string | null {
  const { frequency, schedule_type, value } = input;

  if (frequency === "absolute") {
    if (value === undefined || !Number.isInteger(value) || value < 1) {
      return (
        "frequency 'absolute' means a fixed TOTAL COUNT of instalments, so `value` must be a whole number ≥ 1 " +
        "(e.g. value: 4 for four payments). It is NOT the amount per instalment — the amount comes from the " +
        "programme's price."
      );
    }
  }

  if (frequency === "after_events") {
    if (value === undefined || !Number.isInteger(value) || value < 1) {
      return (
        "frequency 'after_events' bills every N sessions, so `value` must be a whole number ≥ 1 (e.g. value: 4 " +
        "charges every fourth session)."
      );
    }
  }

  if (PERIODIC.has(frequency) && schedule_type !== "pay_as_you_go" && value !== undefined) {
    return (
      `frequency '${frequency}' derives its dates from \`value_date\` (the day of month), not from \`value\` — ` +
      "sending `value` here has no effect and usually means the amount per instalment was intended. Remove it; " +
      "the amount comes from the programme's price. To fix the NUMBER of instalments instead, use " +
      "frequency: 'absolute'."
    );
  }

  if (input.discount === "absolute" && input.discount_value_absolute === undefined) {
    return "discount 'absolute' needs discount_value_absolute.";
  }
  if (input.discount === "relative" && input.discount_value_relative === undefined) {
    return "discount 'relative' needs discount_value_relative (a percentage).";
  }

  return null;
}

function createFailureMessage(error: unknown): string {
  if (error instanceof ZoozaApiError) {
    if (error.status === 403) {
      return (
        "api-v1 rejected the create: this account lacks the edit_company permission, which payment plan templates " +
        "require (a stricter permission than creating programmes)."
      );
    }
    if (error.status >= 500) {
      return (
        `Zooza API error (${error.status}) — the template may or may not have been created. Do NOT retry blindly: ` +
        "check the company's payment plan templates in the Zooza app first."
      );
    }
    return `Zooza rejected the payment plan template: ${error.humanMessage}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
