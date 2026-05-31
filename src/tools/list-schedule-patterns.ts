import { z } from "zod";

export const listSchedulePatternsTitle = "List valid Zooza schedule patterns";

export const listSchedulePatternsDescription =
  "Returns all valid field values for building class schedules and payment plans in Zooza. " +
  "No Zooza API call — hardcoded from Events_Preview.php and Payment_Schedule.php. " +
  "Call this BEFORE preview_schedule or commit_class to avoid validation errors. " +
  "Critical: weekdays must be 3-letter lowercase (mon/tue/wed...), NOT 'monday' or '1'. " +
  "Critical: until_date and count are mutually exclusive — sending both causes an API error. " +
  'Examples: domain="event_generation" → cadences, weekdays, time format; ' +
  'domain="payment_schedule" → schedule types and billing frequencies; ' +
  "empty call → both sections.";

export const listSchedulePatternsInputSchema = {
  domain: z
    .enum(["event_generation", "payment_schedule"])
    .optional()
    .describe(
      "Filter to one section. Omit to return both event generation and payment schedule references.",
    ),
};

// ─── Data ─────────────────────────────────────────────────────────────────────

const EVENT_GENERATION = {
  description:
    "Parameters for the schedule block passed to preview_schedule and commit_class. " +
    "Each block defines one repeating pattern (cadence + weekdays + time + termination).",
  cadences: [
    {
      value: "weekly",
      label: "Weekly",
      weekdays_required: true,
      notes: "Repeats on the specified weekdays every 7 days.",
    },
    {
      value: "biweekly",
      label: "Every other week",
      weekdays_required: true,
      notes:
        "Repeats on the specified weekdays every 14 days. " +
        "UK operators may say 'fortnightly' — the API value is 'biweekly'.",
    },
    {
      value: "monthly",
      label: "Monthly",
      weekdays_required: true,
      notes:
        "Generates the first occurrence of the specified weekday(s) per calendar month. " +
        "E.g. cadence=monthly + weekdays=['mon'] = first Monday of each month.",
    },
    {
      value: "daily",
      label: "Daily",
      weekdays_required: false,
      notes: "Repeats every day. weekdays array is ignored.",
    },
  ],
  weekdays: {
    description:
      "Array of 3-letter lowercase day codes. MUST use exactly these values. " +
      "'monday', 'Monday', '1', 'MO', 'MONDAY' are all invalid and return a 400 error.",
    values: [
      { key: "mon", day: "Monday", iso: 1 },
      { key: "tue", day: "Tuesday", iso: 2 },
      { key: "wed", day: "Wednesday", iso: 3 },
      { key: "thu", day: "Thursday", iso: 4 },
      { key: "fri", day: "Friday", iso: 5 },
      { key: "sat", day: "Saturday", iso: 6 },
      { key: "sun", day: "Sunday", iso: 7 },
    ],
  },
  termination: {
    description:
      "Exactly ONE of until_date or count must be present — not both, not neither. " +
      "Sending both or neither returns: wrong_parameters_sent: block_repeat_mode.",
    options: [
      {
        field: "until_date",
        type: "string",
        format: "YYYY-MM-DD",
        description: "Generate sessions up to and including this date.",
        example: "2026-09-30",
      },
      {
        field: "count",
        type: "integer",
        format: "positive integer",
        description: "Generate exactly this many sessions.",
        example: 20,
      },
    ],
  },
  time_format: {
    field: "time_minutes",
    type: "integer",
    description:
      "Session start time expressed as minutes from midnight (00:00 = 0). " +
      "Claude commonly formats time as 'HH:MM' — convert to minutes before calling the API.",
    examples: [
      { time: "09:00", time_minutes: 540 },
      { time: "10:30", time_minutes: 630 },
      { time: "14:00", time_minutes: 840 },
      { time: "17:45", time_minutes: 1065 },
      { time: "18:00", time_minutes: 1080 },
      { time: "20:30", time_minutes: 1230 },
    ],
  },
  duration_format: {
    field: "duration_minutes",
    type: "integer",
    description: "Session duration in minutes. Any positive integer.",
    examples: [30, 45, 60, 90, 120],
  },
  example_block: {
    description: "Example: weekly class on Monday and Wednesday at 18:00 for 60 minutes, running until 30 June 2026.",
    value: {
      cadence: "weekly",
      weekdays: ["mon", "wed"],
      time_minutes: 1080,
      duration_minutes: 60,
      until_date: "2026-06-30",
    },
  },
};

const PAYMENT_SCHEDULE = {
  description:
    "Determines how and when clients are billed for their booking. " +
    "The schedule_type defines the billing model; frequency applies only to certain types.",
  schedule_types: [
    {
      value: "single_payment",
      label: "Single payment",
      description: "Full amount paid once at registration or before the first session.",
      frequency_applicable: false,
      use_cases: ["Short workshops", "One-time events", "Seminars"],
    },
    {
      value: "in_advance",
      label: "In advance (installments)",
      description:
        "Fixed installment plan — client pays in equal installments on a defined schedule. " +
        "Total is divided by the number of installment periods.",
      frequency_applicable: true,
      use_cases: ["Term-based courses", "Semester programmes", "Multi-month classes"],
    },
    {
      value: "by_attendance",
      label: "By attendance",
      description:
        "Client is charged per session they attend. Amount is set per session. " +
        "Used when clients pay as they drop in, not in advance.",
      frequency_applicable: false,
      use_cases: ["Drop-in classes", "Open attendance businesses", "Pay-per-class"],
    },
    {
      value: "pay_as_you_go",
      label: "Pay as you go",
      description:
        "Recurring billing as sessions occur. Suitable for rolling monthly memberships " +
        "where clients pay each month for that month's sessions.",
      frequency_applicable: true,
      use_cases: ["Monthly memberships", "Rolling subscriptions", "Ongoing classes"],
    },
  ],
  frequencies: {
    description:
      "Applies only to 'in_advance' and 'pay_as_you_go' schedule types. " +
      "Defines how often installments are billed.",
    values: [
      { value: "monthly", label: "Monthly", notes: "Most common for rolling programmes" },
      { value: "quarterly", label: "Quarterly", notes: "Every 3 months" },
      { value: "half_yearly", label: "Half-yearly", notes: "Every 6 months" },
      { value: "yearly", label: "Yearly", notes: "Annual billing" },
      { value: "after_events", label: "After N events", notes: "Bill after a configured number of sessions" },
      { value: "absolute", label: "Fixed date", notes: "Bill on a specific absolute calendar date" },
      { value: "segments", label: "By segment", notes: "Used with segmented schedule blocks" },
    ],
  },
};

// ─── Tool implementation ─────────────────────────────────────────────────────

const inputSchema = z.object({
  domain: z.enum(["event_generation", "payment_schedule"]).optional(),
});

export async function runListSchedulePatterns(rawInput: unknown): Promise<{
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

  const { domain } = parsed.data;

  let result: Record<string, unknown>;

  if (domain === "event_generation") {
    result = { event_generation: EVENT_GENERATION };
  } else if (domain === "payment_schedule") {
    result = { payment_schedule: PAYMENT_SCHEDULE };
  } else {
    result = {
      event_generation: EVENT_GENERATION,
      payment_schedule: PAYMENT_SCHEDULE,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
