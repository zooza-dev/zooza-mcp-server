import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { COMPILED_MERGE_VAR_NAMES } from "../merge-vars/compiled-vars.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import type { RawEmailTemplate } from "./list-message-templates.js";
import { savePlan, type MessagePlan } from "./message-plan-store.js";

export const prepareMessageTitle = "Plan an email to clients (no send)";

export const prepareMessageDescription =
  "Plans an email to clients of this company WITHOUT sending anything. Describe the audience (a course/programme, " +
  "a class schedule, a specific booking, one client, a saved segment, or course-level labels) and the content " +
  "(an existing template `type` from comms_list_templates, or a custom subject + body which may use *|MERGE_VAR|* " +
  "tags from comms_list_merge_vars). Returns the estimated recipient count, a sample of recipients, the content as " +
  "it will be sent, warnings (unknown merge tags, zero recipients), and a single-use `token`. Show this plan to the " +
  "operator and get their explicit confirmation, then call comms_commit_message with the token to actually send. " +
  "Call comms_prepare_message again with adjusted filters to refine the audience — it is free and repeatable. " +
  "Resolve names to ids first: classes_find_courses for a course/programme → course_id, " +
  "classes_find_classes for a class/group by name → schedule_id, sessions_find_events for a single session → event_id; " +
  "never guess ids.";

const audienceSchema = z
  .object({
    course_id: z.number().int().positive().optional().describe("Everyone registered in this course/programme."),
    schedule_id: z.number().int().positive().optional().describe("Everyone in this class (schedule)."),
    registration_id: z.number().int().positive().optional().describe("One specific booking."),
    user_id: z.number().int().positive().optional().describe("One client (all their registrations)."),
    segment_id: z.number().int().positive().optional().describe("A saved registration segment."),
    labels: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        "Registrations in COURSES labeled with any of these label ids — labels attach at course level, not per person.",
      ),
    exclude: z
      .array(z.number().int().positive())
      .optional()
      .describe("Registration ids to leave out."),
    guests: z
      .boolean()
      .optional()
      .describe("Default false. Also send to guest registrations (added at send time; not in the count estimate)."),
    inactive_customers: z
      .boolean()
      .optional()
      .describe("Default false. Include inactive registrations."),
  })
  .describe("Who receives the message. At least one targeting field is required.");

const contentSchema = z
  .object({
    template_type: z
      .string()
      .optional()
      .describe('Existing email template type from comms_list_templates, e.g. "registration_cancellation".'),
    subject: z.string().optional().describe("Custom email subject; may contain *|MERGE|* tags."),
    body: z.string().optional().describe("Custom email body (HTML or text); may contain *|MERGE|* tags."),
  })
  .describe("EITHER template_type OR subject+body — not both.");

export const prepareMessageInputSchema = {
  company_id: companyIdSchema,
  channel: z
    .enum(["email"])
    .describe("Only 'email' is implemented. WhatsApp is specced and coming — do not promise it yet."),
  audience: audienceSchema,
  content: contentSchema,
  marketing: z
    .boolean()
    .describe(
      "REQUIRED. true = promotional content (consent rules apply; say so to the operator). " +
        "false = operational (schedule changes, payment reminders, session info).",
    ),
  schedule_at: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .optional()
    .describe("Omit to send immediately on commit."),
  bcc: z.string().optional().describe("Comma-separated BCC addresses."),
};

const inputSchema = z.object(prepareMessageInputSchema);

type AudienceInput = z.infer<typeof audienceSchema>;

const TARGETING_FIELDS = [
  "course_id",
  "schedule_id",
  "registration_id",
  "user_id",
  "segment_id",
  "labels",
] as const;

export function hasTargeting(audience: AudienceInput): boolean {
  return TARGETING_FIELDS.some((f) => {
    const v = audience[f];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  });
}

/**
 * Maps the tool's audience input to the query params shared by the count
 * estimate (GET /registrations?advanced_search) and the real send
 * (POST /message_jobs `params`) — both run api-v1's build_advanced_query.
 */
export function buildAudienceParams(audience: AudienceInput): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (audience.course_id !== undefined) params.course_id = audience.course_id;
  if (audience.schedule_id !== undefined) params.schedule_id = audience.schedule_id;
  if (audience.registration_id !== undefined) params.registration_id = audience.registration_id;
  if (audience.user_id !== undefined) params.user_id = audience.user_id;
  if (audience.segment_id !== undefined) params.segment_id = audience.segment_id;
  if (audience.labels?.length) params.labels = audience.labels.join("|");
  if (audience.exclude?.length) params.exclude = audience.exclude.join("|");
  if (audience.inactive_customers) params.inactive_customers = 1;
  return params;
}

const TAG_RE = /\*\|([A-Z0-9_]+)\|\*/g;

export function extractMergeTags(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) names.add(m[1]);
  return [...names];
}

/** Names valid per the compiled api-v1 Merge_Vars list. */
const VALID_TAG_NAMES = new Set<string>(COMPILED_MERGE_VAR_NAMES);

/**
 * Naive closest-match: a valid name that contains the unknown one or vice
 * versa (CLIENT_FIRST_NAME → FIRST_NAME). Good enough for a hint; the full
 * catalogue is one comms_list_merge_vars call away.
 */
export function suggestTag(unknown: string): string | undefined {
  for (const valid of VALID_TAG_NAMES) {
    if (unknown.includes(valid) || valid.includes(unknown)) return valid;
  }
  return undefined;
}

export function findUnknownTags(names: string[]): Array<{ tag: string; suggestion?: string }> {
  return names
    .filter((n) => !VALID_TAG_NAMES.has(n))
    .map((n) => {
      const suggestion = suggestTag(n);
      return suggestion ? { tag: `*|${n}|*`, suggestion: `*|${suggestion}|*` } : { tag: `*|${n}|*` };
    });
}

/** Envelope returned by GET /registrations?advanced_search (common.php:6191-6197). */
interface AdvancedSearchEnvelope {
  total?: number;
  total_capped?: boolean;
  results?: Array<{
    full_name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
  }>;
}

export async function runPrepareMessage(
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

  if (!hasTargeting(input.audience)) {
    return errorResult(
      "audience must contain at least one of: course_id, schedule_id, registration_id, user_id, segment_id, labels. " +
        "Ask the operator who the message is for — a whole programme, one class, or a single client — then resolve " +
        "the id: classes_find_courses → course_id, classes_find_classes → schedule_id, sessions_find_events → event_id.",
    );
  }

  const hasTemplate = input.content.template_type !== undefined;
  const hasCustom = input.content.subject !== undefined || input.content.body !== undefined;
  if (hasTemplate === hasCustom || (hasCustom && (!input.content.subject || !input.content.body))) {
    return errorResult(
      "content must be EITHER template_type OR subject+body (both fields), not both modes or neither. " +
        "Use comms_list_templates to offer existing templates, or compose a custom subject+body.",
    );
  }

  const companyAuth = withCompany(auth, input.company_id!);

  try {
    // Resolve content.
    let subject: string;
    let body: string;
    let contentSource: "template" | "custom";
    if (hasTemplate) {
      const rawTemplates = await zoozaFetch<RawEmailTemplate[]>("/email_templates", {}, companyAuth);
      const records = Array.isArray(rawTemplates) ? rawTemplates : [];
      const match = records.find((r) => r.type === input.content.template_type);
      if (!match) {
        const validTypes = [...new Set(records.map((r) => r.type))].join(", ");
        return errorResult(
          `No email template of type '${input.content.template_type}'. Valid types for this company: ${validTypes}.`,
        );
      }
      subject = match.subject ?? "";
      body = match.body ?? "";
      contentSource = "template";
    } else {
      subject = input.content.subject!;
      body = input.content.body!;
      contentSource = "custom";
    }

    // Resolve audience count + sample. Same build_advanced_query resolver the
    // real send uses; email_rejected=0 excludes unsubscribed clients like the
    // send will. Remaining estimate gaps: per-email dedup and guest fan-out.
    const audienceParams = buildAudienceParams(input.audience);
    const envelope = await zoozaFetch<AdvancedSearchEnvelope>(
      "/registrations",
      {
        query: {
          advanced_search: 1,
          count: "exact",
          page: 0,
          page_size: 5,
          email_rejected: 0,
          ...audienceParams,
        },
      },
      companyAuth,
    );
    const recipientCount = envelope?.total ?? 0;
    const sample = (envelope?.results ?? []).slice(0, 5).map((r) => ({
      name: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)",
      email: r.email ?? "(no email)",
    }));

    // Validate merge tags.
    const tagsUsed = extractMergeTags(`${subject}\n${body}`);
    const unknownTags = findUnknownTags(tagsUsed);

    const warnings: string[] = [];
    if (recipientCount === 0) {
      warnings.push(
        "No recipients match these filters. Common causes: wrong course/schedule id, all matching clients " +
          "unsubscribed, inactive registrations excluded (set inactive_customers: true to include). " +
          "Refine the audience — this plan cannot be committed with 0 recipients.",
      );
    }
    for (const u of unknownTags) {
      warnings.push(
        `Unknown merge tag will render as literal text: ${u.tag}.` +
          (u.suggestion ? ` Did you mean ${u.suggestion}?` : " Check comms_list_merge_vars for valid tags."),
      );
    }
    if (input.audience.guests) {
      warnings.push(
        "Guest recipients are added at send time and are NOT included in the estimated count.",
      );
    }

    const plan: MessagePlan = {
      company_id: input.company_id!,
      channel: "email",
      audience_params: audienceParams,
      audience_echo: input.audience,
      subject,
      body,
      template_type: input.content.template_type,
      marketing: input.marketing,
      guests: input.audience.guests ?? false,
      bcc: input.bcc,
      schedule_at: input.schedule_at,
      recipient_count: recipientCount,
    };
    const { token, expires_in_seconds } = savePlan(plan);

    const result = {
      token,
      expires_in_seconds,
      audience: {
        recipient_count: recipientCount,
        recipient_count_is_estimate: true,
        estimate_note:
          "Count comes from the same audience resolver the send uses (unsubscribed clients already excluded). " +
          "The final send additionally de-duplicates by email address" +
          (input.audience.guests ? " and adds guest registrations" : "") +
          ", so the sent total can differ slightly.",
        sample,
        filters_applied: input.audience,
      },
      content: {
        source: contentSource,
        ...(input.content.template_type ? { template_type: input.content.template_type } : {}),
        subject,
        body_preview: body.length > 500 ? `${body.slice(0, 500)}…` : body,
        merge_tags_used: tagsUsed.map((n) => `*|${n}|*`),
        unknown_merge_tags: unknownTags.map((u) => u.tag),
      },
      classification: input.marketing ? "marketing" : "operational",
      scheduled_for: input.schedule_at ?? null,
      warnings,
      next_step:
        "Show this plan to the operator (count, sample, subject, body gist, classification). Only after their " +
        "explicit confirmation call comms_commit_message with the token. To change anything, call " +
        "comms_prepare_message again.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not prepare the message (api-v1 ${error.status}: ${error.humanMessage}). Nothing was sent.`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
