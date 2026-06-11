import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";

/**
 * Upstream record from GET /v1/email_templates — bare JSON array, every field
 * always present (Email_Templates.php:151-208). For is_default rows, subject/
 * body are resolved server-side from translation keys in the company language,
 * and `id` points at the DEFAULTS table row — which is why we never expose it:
 * `type` is the only safe key for downstream tools.
 */
export interface RawEmailTemplate {
  id: number;
  company_id: number;
  type: string;
  name: string | null;
  hour: number | null;
  subject: string | null;
  body: string | null;
  is_default: boolean;
}

export const listMessageTemplatesTitle = "List the company's automated email templates";

export const listMessageTemplatesDescription =
  "Lists the automated email templates Zooza sends to this company's clients — registration confirmations, " +
  "trial follow-ups, cancellation notices, session reminders, loyalty/discount emails, and custom templates. " +
  "For each template returns its trigger `type`, subject line, and whether the company uses the stock Zooza " +
  "default or has customized it. Use this to see which automated emails exist, check what has been customized, " +
  "or look up a template's `type` before previewing or sending it (comms_prepare_message accepts that `type`). " +
  "This tool only lists email templates — for the merge variables (*|FIRST_NAME|* etc.) usable inside template " +
  "bodies, use comms_list_merge_vars instead. Read-only; sends nothing. Bodies are full HTML and large — only " +
  "set include_body when the user asks to see template content.";

export const listMessageTemplatesInputSchema = {
  company_id: companyIdSchema,
  type: z
    .string()
    .optional()
    .describe(
      'Exact template type, e.g. "registration_cancellation" — returns just that template. Omit to browse all.',
    ),
  source: z
    .enum(["all", "default", "customized"])
    .optional()
    .describe(
      "Default 'all'. 'customized' = only templates this company has overridden; 'default' = only untouched stock templates.",
    ),
  include_body: z
    .boolean()
    .optional()
    .describe(
      "Default false. When true, includes the full HTML body of each returned template (large — combine with `type`).",
    ),
};

const inputSchema = z.object(listMessageTemplatesInputSchema);

type TemplateOut = {
  type: string;
  name: string | null;
  subject: string | null;
  is_default: boolean;
  hour: number | null;
  body?: string | null;
};

export function projectTemplates(
  records: RawEmailTemplate[],
  opts: { type?: string; source?: "all" | "default" | "customized"; includeBody?: boolean },
): { templates: TemplateOut[]; validTypes: string[] } {
  const validTypes = [...new Set(records.map((r) => r.type))];
  let filtered = records;
  if (opts.type) filtered = filtered.filter((r) => r.type === opts.type);
  if (opts.source === "default") filtered = filtered.filter((r) => r.is_default);
  if (opts.source === "customized") filtered = filtered.filter((r) => !r.is_default);

  const templates = filtered.map((r) => {
    const out: TemplateOut = {
      type: r.type,
      name: r.name,
      subject: r.subject,
      is_default: !!r.is_default,
      hour: r.hour,
    };
    if (opts.includeBody) out.body = r.body;
    return out;
  });
  return { templates, validTypes };
}

export async function runListMessageTemplates(
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

  try {
    // company_id is guaranteed by the resolveCompanyId wrapper in index.ts.
    const raw = await zoozaFetch<RawEmailTemplate[]>(
      "/email_templates",
      {},
      withCompany(auth, input.company_id!),
    );
    const records = Array.isArray(raw) ? raw : [];
    const { templates, validTypes } = projectTemplates(records, {
      type: input.type,
      source: input.source ?? "all",
      includeBody: input.include_body ?? false,
    });

    if (input.type && templates.length === 0) {
      return errorResult(
        `No email template of type '${input.type}'. Valid types for this company: ${validTypes.join(", ")}.`,
      );
    }

    const customizedCount = records.filter((r) => !r.is_default).length;
    const result: Record<string, unknown> = {
      total: templates.length,
      customized_count: customizedCount,
      templates,
    };
    if (input.source === "customized" && templates.length === 0) {
      result.note =
        "This company has not customized any email templates; all sends use Zooza defaults.";
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not list email templates (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
