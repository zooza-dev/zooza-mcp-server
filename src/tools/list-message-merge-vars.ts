import { z } from "zod";
import { COMPILED_MERGE_VAR_NAMES } from "../merge-vars/compiled-vars.js";

export const listMessageMergeVarsTitle = "List Zooza message merge variables";

export const listMessageMergeVarsDescription =
  "Returns all valid merge variables for Zooza message templates (email, SMS, WhatsApp). " +
  "Format: *|VARIABLE_NAME|* (MailChimp-compatible). " +
  "No Zooza API call — hardcoded from Merge_Vars::merge_vars() in api-v1. " +
  "Use this BEFORE writing any message template to get correct variable names. " +
  "Claude must not invent variable names — only variables listed here are valid. " +
  'Examples: category="financial" → payment and balance vars; medium="sms" → SMS-safe vars with HTML warnings; ' +
  "empty call → full catalogue grouped by category.";

export const listMessageMergeVarsInputSchema = {
  category: z
    .enum([
      "client",
      "booking",
      "programme",
      "session",
      "financial",
      "place",
      "online_meeting",
      "extra_fields",
      "system",
      "notification_urls",
    ])
    .optional()
    .describe("Filter by category. Omit to return all variables."),
  medium: z
    .enum(["email", "sms", "whatsapp"])
    .optional()
    .describe(
      "Include medium-specific notes (e.g. HTML variables that do not render in SMS).",
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

type MergeVarCategory =
  | "client"
  | "booking"
  | "programme"
  | "session"
  | "financial"
  | "place"
  | "online_meeting"
  | "extra_fields"
  | "system"
  | "notification_urls";

interface MergeVar {
  tag: string;
  description: string;
  html_only?: true;
  notes?: string;
}

type MergeVarCatalogue = Record<MergeVarCategory, MergeVar[]>;

// ─── Catalogue ───────────────────────────────────────────────────────────────

const CATALOGUE: MergeVarCatalogue = {
  client: [
    { tag: "*|FIRST_NAME|*", description: "Client's first name" },
    { tag: "*|LAST_NAME|*", description: "Client's last name" },
    { tag: "*|FULL_NAME|*", description: "Client's full name (first + last)" },
    { tag: "*|USER_ID|*", description: "Internal Zooza user ID" },
    { tag: "*|CUSTOM_CUSTOMER_ID|*", description: "Custom external ID assigned to the client" },
    { tag: "*|USER_CREATED|*", description: "Date the client account was created" },
  ],

  booking: [
    { tag: "*|REGISTRATION_ID|*", description: "Booking number (same numeric value as variable symbol)" },
    { tag: "*|REGISTRATION_STATUS|*", description: "Current booking status (Enrolled, Waitlist, etc.)" },
    { tag: "*|REGISTRATION_VALUE|*", description: "Total value of the booking" },
    { tag: "*|REGISTRATION_FEE|*", description: "One-time registration fee amount (if applicable)" },
    { tag: "*|AFFILIATE_ID|*", description: "Affiliate referral ID if booking came via affiliate link" },
    { tag: "*|ALLOW_REPLACEMENTS|*", description: "Whether make-up sessions are allowed for this booking" },
    { tag: "*|CANCELLATION_SCHEDULED|*", description: "Whether a future cancellation is scheduled" },
    { tag: "*|CANCELLATION_DATE|*", description: "Date of the scheduled cancellation" },
  ],

  programme: [
    { tag: "*|COURSE_NAME|*", description: "Name of the programme" },
    { tag: "*|COURSE_PID|*", description: "Programme's public-facing ID" },
    { tag: "*|COURSE_DATE|*", description: "Programme start date" },
    { tag: "*|COURSE_DATE_DAY|*", description: "Day of the week for the programme (e.g. Monday)" },
    { tag: "*|COURSE_DATE_START_END|*", description: "Full date range: first session to last session" },
    { tag: "*|COURSE_TIME|*", description: "Session time for the programme" },
    { tag: "*|COURSE_SUMMARY|*", description: "Date and time summary of the programme" },
    { tag: "*|COURSE_TRAINER|*", description: "Full name of the programme's default instructor" },
    { tag: "*|COURSE_PRICE|*", description: "Programme total price" },
    { tag: "*|DEFAULT_COURSE_PRICE|*", description: "Default (list) price before discounts" },
    { tag: "*|COURSE_PAYMENT|*", description: "Payment amount charged for the programme" },
    { tag: "*|COURSE_PLACE|*", description: "Full address of the programme location" },
    { tag: "*|COURSE_PLACE_ID|*", description: "Internal place ID" },
    { tag: "*|COURSE_ROOM_ID|*", description: "Internal room ID" },
    { tag: "*|SCHEDULE_NAME|*", description: "Name of the class (schedule) within the programme" },
    { tag: "*|SCHEDULE_DURATION|*", description: "Length of a single session (e.g. 60 minutes)" },
    { tag: "*|SCHEDULE_TYPE|*", description: "Class cadence type (weekly / biweekly / monthly / daily)" },
  ],

  session: [
    { tag: "*|EVENT_NAME|*", description: "Session name (if manually set)" },
    { tag: "*|EVENT_DATE|*", description: "Session date" },
    { tag: "*|EVENT_DATE_DAY|*", description: "Day of the week for the session (e.g. Friday)" },
    { tag: "*|EVENT_TIME|*", description: "Session time" },
    { tag: "*|EVENT_COURSE|*", description: "Programme name for this session" },
    { tag: "*|EVENT_TRAINER|*", description: "Trainer assigned to this specific session" },
    { tag: "*|EVENT_PLACE|*", description: "Location of the session" },
    { tag: "*|EVENT_PLACE_DIRECTIONS|*", description: "Directions text to the session location" },
    { tag: "*|EVENT_PLACE_MAP|*", description: "Map link for the session location" },
    { tag: "*|EVENT_PUBLIC_SUMMARY|*", description: "Public summary text of the session" },
    { tag: "*|EVENT_ATTENDANCE_NOTE|*", description: "Attendance note added by the operator for this session" },
    { tag: "*|EVENT_HAS_ONLINE_MEETING|*", description: "Boolean — whether this session has an online meeting room" },
    { tag: "*|EVENT_ONLINE_MEETING_LINK|*", description: "Clickable hyperlink to the session's online meeting room" },
    { tag: "*|EVENT_ONLINE_MEETING_URL|*", description: "Raw URL of the session's online meeting room" },
  ],

  financial: [
    { tag: "*|VARIABLE_SYMBOL|*", description: "Variable symbol — payment reference number (same value as REGISTRATION_ID)" },
    { tag: "*|IBAN|*", description: "Company bank account IBAN for manual transfers" },
    { tag: "*|DEBT|*", description: "Outstanding balance owed by the client (positive = owes money)" },
    { tag: "*|CURRENT_BALANCE|*", description: "Client's current balance (can be negative if in credit)" },
    { tag: "*|CURRENT_BALANCE_ABS|*", description: "Absolute value of current balance" },
    { tag: "*|PAID|*", description: "Total amount already paid for this booking" },
    { tag: "*|PAYMENT_STATUS|*", description: "Human-readable payment status" },
    { tag: "*|PAYMENT_STATUS_CODE|*", description: "Machine-readable payment status code" },
    { tag: "*|ORDER_SUMMARY|*", description: "Full order/payment summary" },
    { tag: "*|ORDER_ID|*", description: "Order ID" },
    { tag: "*|DOWNPAYMENT|*", description: "Downpayment amount (if a downpayment is required)" },
    { tag: "*|DOWNPAYMENT_DUE_DATE|*", description: "Due date for the downpayment" },
    { tag: "*|HAS_DOWNPAYMENT|*", description: "Boolean — whether a downpayment is required" },
    { tag: "*|HAS_UNPAID_DOWNPAYMENT|*", description: "Boolean — whether the downpayment has not been paid yet" },
    { tag: "*|INBOUND|*", description: "Inbound payment link or instructions (bank transfer QR / payment gateway link)" },
    {
      tag: "*|QR_CODE|*",
      description: "QR code image for the full payment amount",
      html_only: true,
      notes: "Renders as an HTML <img> tag. Does not display in SMS or plain-text channels.",
    },
    {
      tag: "*|QR_CODE_DOWNPAYMENT|*",
      description: "QR code image for the downpayment amount",
      html_only: true,
      notes: "Renders as an HTML <img> tag. Does not display in SMS or plain-text channels.",
    },
  ],

  place: [
    { tag: "*|PLACE_DIRECTIONS|*", description: "Directions text to the programme location (from the Place record)" },
    { tag: "*|PLACE_MAP|*", description: "Map link to the programme location" },
  ],

  online_meeting: [
    { tag: "*|ONLINE_MEETING_LINK|*", description: "Clickable hyperlink to the class-level online meeting room" },
    { tag: "*|ONLINE_MEETING_URL|*", description: "Raw URL of the class-level online meeting room" },
    { tag: "*|HAS_ONLINE_MEETING|*", description: "Boolean — whether the class has an online meeting room configured" },
    {
      tag: "*|WIDGET_VIDEO_URL|*",
      description: "URL to video content associated with the session (e.g. recorded class)",
    },
  ],

  extra_fields: [
    { tag: "*|EF_DOB|*", description: "Client date of birth (from extra fields)" },
    { tag: "*|EF_FULL_NAME|*", description: "Client full name from extra fields (may differ from account name)" },
    { tag: "*|EF_ADDRESS|*", description: "Client home address from extra fields" },
    { tag: "*|EF_BUSINESS_NAME|*", description: "Business / company name (for B2B invoicing clients)" },
    { tag: "*|EF_BUSINESS_ADDRESS|*", description: "Business address for invoice" },
    { tag: "*|EF_BUSINESS_ID|*", description: "Business registration number (IČO / CRN)" },
    { tag: "*|EF_TAX_ID|*", description: "Tax ID (DIČ / TIN)" },
    { tag: "*|EF_VAT|*", description: "VAT registration number (IČ DPH / VAT number)" },
    { tag: "*|IS_BUSINESS_ORDER|*", description: "Boolean — whether this is a B2B invoice order" },
    { tag: "*|EF_IDENTIFICATION_NUMBER|*", description: "Government-issued ID / identification number" },
    { tag: "*|EF_CITIZENSHIP|*", description: "Client citizenship / nationality" },
    { tag: "*|EF_EXTRA_FIELD_1|*", description: "Custom extra field 1 (company-defined label)" },
    { tag: "*|EF_EXTRA_FIELD_2|*", description: "Custom extra field 2" },
    { tag: "*|EF_EXTRA_FIELD_3|*", description: "Custom extra field 3" },
    { tag: "*|EF_EXTRA_FIELD_4|*", description: "Custom extra field 4" },
    { tag: "*|EF_EXTRA_FIELD_5|*", description: "Custom extra field 5" },
    { tag: "*|EF_EXTRA_FIELD_6|*", description: "Custom extra field 6" },
    { tag: "*|EF_EXTRA_FIELD_7|*", description: "Custom extra field 7" },
    { tag: "*|EF_EXTRA_FIELD_8|*", description: "Custom extra field 8" },
    { tag: "*|EF_EXTRA_FIELD_9|*", description: "Custom extra field 9" },
    { tag: "*|EF_EXTRA_FIELD_10|*", description: "Custom extra field 10" },
    { tag: "*|EF_EXTRA_FIELD_11|*", description: "Custom extra field 11" },
    { tag: "*|EF_EXTRA_FIELD_12|*", description: "Custom extra field 12" },
    { tag: "*|EF_EXTRA_FIELD_13|*", description: "Custom extra field 13" },
    { tag: "*|EF_EXTRA_FIELD_14|*", description: "Custom extra field 14" },
    { tag: "*|EF_EXTRA_FIELD_15|*", description: "Custom extra field 15" },
  ],

  system: [
    { tag: "*|COMPANY|*", description: "Company name" },
    { tag: "*|NOW|*", description: "Current date and time at send time" },
    { tag: "*|CURDATE|*", description: "Current date at send time" },
    { tag: "*|PROFILE_TOKEN|*", description: "Client's authentication token for self-service portal links" },
    { tag: "*|WIDGET_PROFILE_URL|*", description: "URL to the client's profile page in the booking widget" },
    { tag: "*|WIDGET_REGISTRATION_URL|*", description: "URL to the client's registrations page in the widget" },
  ],

  notification_urls: [
    {
      tag: "*|TURN_OFF_EVENT_NOTIFICATIONS_URL|*",
      description: "URL that lets the client unsubscribe from session reminder notifications",
      notes: "Only available in session reminder templates. Not valid in other message types.",
    },
    {
      tag: "*|CANCELED_CONFIRMATION_URL|*",
      description: "URL that allows the client to cancel their attendance for this session",
      notes: "Only available in session reminder templates. Not valid in other message types.",
    },
  ],
};

// ─── Tool implementation ─────────────────────────────────────────────────────

const inputSchema = z.object({
  category: z
    .enum([
      "client",
      "booking",
      "programme",
      "session",
      "financial",
      "place",
      "online_meeting",
      "extra_fields",
      "system",
      "notification_urls",
    ])
    .optional(),
  medium: z.enum(["email", "sms", "whatsapp"]).optional(),
});

const SMS_INCOMPATIBLE_NOTE =
  "⚠ This variable renders as HTML and will appear as raw text or be stripped in SMS messages.";

// ─── Completeness check ──────────────────────────────────────────────────────
// Any var in the compiled PHP list that has no entry in CATALOGUE gets surfaced
// automatically as "uncategorized" so it doesn't silently disappear.

/** All var names covered by the catalogue (excl. notification_urls added dynamically). */
function getCataloguedNames(): Set<string> {
  const names = new Set<string>();
  for (const vars of Object.values(CATALOGUE)) {
    for (const v of vars) {
      // Extract name from "*|NAME|*"
      const m = v.tag.match(/^\*\|([A-Z0-9_]+)\|\*$/);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

/** Returns vars present in compiled PHP but missing a description in the catalogue. */
function getUncategorizedVars(): MergeVar[] {
  const catalogued = getCataloguedNames();
  return COMPILED_MERGE_VAR_NAMES.filter((name) => !catalogued.has(name)).map((name) => ({
    tag: `*|${name}|*`,
    description:
      "⚠ No description yet — this variable was added to api-v1/Merge_Vars.php but " +
      "has not been categorised in list-message-merge-vars.ts. Add it to the catalogue.",
    notes: "Added automatically from compiled-vars.ts",
  }));
}

export async function runListMessageMergeVars(rawInput: unknown): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Invalid input: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
            .join("; ")}.`,
        },
      ],
    };
  }

  const { category, medium } = parsed.data;

  const categoriesToReturn = category
    ? ([category] as MergeVarCategory[])
    : (Object.keys(CATALOGUE) as MergeVarCategory[]);

  // Auto-include any new vars from PHP that haven't been described yet
  const uncategorized = getUncategorizedVars();

  const result: Record<string, MergeVar[]> = {};
  for (const cat of categoriesToReturn) {
    let vars = CATALOGUE[cat];

    // Add medium-specific notes for SMS
    if (medium === "sms" && vars) {
      vars = vars.map((v) =>
        v.html_only
          ? { ...v, notes: [v.notes, SMS_INCOMPATIBLE_NOTE].filter(Boolean).join(" ") }
          : v,
      );
    }

    result[cat] = vars ?? [];
  }

  // Append uncategorized vars (only when fetching all or explicitly "uncategorized")
  if (uncategorized.length > 0 && !category) {
    result["uncategorized"] = uncategorized;
  }

  const totalCount = Object.values(result).reduce((sum, vars) => sum + vars.length, 0);

  const envelope = {
    format: "*|VARIABLE_NAME|* (MailChimp-compatible)",
    medium_context: medium ?? "all",
    total: totalCount,
    ...(category ? { category } : {}),
    ...(uncategorized.length > 0 && !category
      ? { warning: `${uncategorized.length} variable(s) from Merge_Vars.php have no description yet — see 'uncategorized' group.` }
      : {}),
    variables: result,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}
