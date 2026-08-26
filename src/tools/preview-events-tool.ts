import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import { eventsPreview } from "./events-preview.js";
import type {
  Cadence,
  EventsPreviewBlock,
  EventsPreviewRequest,
  PreviewEvent,
  Weekday,
} from "./types.js";

const CADENCES: [Cadence, ...Cadence[]] = ["daily", "weekly", "biweekly", "monthly"];
const WEEKDAYS: [Weekday, ...Weekday[]] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const previewEventsTitle = "Preview class session dates";

export const previewEventsDescription =
  "Expands one or more recurrence patterns and/or ad-hoc dates into the concrete list of class sessions, honouring holiday-skip flags. Stateless — performs no writes. Call this once per pattern the user describes during class creation. Accumulate the returned sessions across multiple calls (Claude side) until the user says they're done, then pass the full list to `classes_commit_class`. Each block must carry EXACTLY ONE of `count` (stop after N sessions) or `until_date` (stop on a fixed date) — count mode is preferred when the user says \"X sessions\". A top-level `to_date` acts as a fallback `until_date` for any block that omits both. `place_id` is required so api-v1 can apply the correct subdivision-scoped school-holiday calendar. When you SHOW the expanded sessions to the user, render them as a weekly GRID (days across the top, time down the left — the Zooza app calendar layout): one representative week with the run range + session count in a caption, NOT a flat date list — unless the user explicitly asks to see every date.";

export const previewEventsInputSchema = {
  company_id: companyIdSchema,
  place_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Venue (place) the sessions run at. Required so api-v1 applies the correct subdivision-scoped school-holiday calendar. Resolve with classes_find_places.",
    ),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Start of the window to expand sessions into, YYYY-MM-DD. Recurrence blocks begin generating on or after this date."),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Optional end of the window, YYYY-MM-DD. Acts as a fallback until_date for any block that supplies neither count nor until_date."),
  blocks: z
    .array(
      z.object({
        weekdays: z
          .array(z.enum(WEEKDAYS))
          .optional()
          .describe("Days of the week this recurring pattern runs on (e.g. ['mon','wed']). Omit for a single-day cadence."),
        time_minutes: z
          .number()
          .int()
          .min(0)
          .max(1439)
          .describe("Session start time as minutes past midnight (0-1439, e.g. 540 = 09:00)."),
        duration: z
          .number()
          .int()
          .positive()
          .describe("Session length in minutes."),
        all_day: z
          .boolean()
          .optional()
          .describe("When true, the session has no fixed start time (an all-day session)."),
        cadence: z
          .enum(CADENCES)
          .optional()
          .describe("How often the pattern repeats: daily, weekly, biweekly, or monthly. Defaults to weekly."),
        trainer_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional per-block instructor override. Resolve with trainers_find."),
        count: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Stop after generating this many sessions. Provide EXACTLY ONE of count or until_date; preferred when the user says 'X sessions'."),
        until_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Stop generating sessions on this date (inclusive), YYYY-MM-DD. Provide EXACTLY ONE of count or until_date."),
      }),
    )
    .optional()
    .describe("Recurrence patterns to expand into concrete sessions. Each block describes one repeating rhythm; add multiple blocks for classes with several patterns."),
  additional_dates: z
    .array(
      z.object({
        date_string: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Date of this ad-hoc session, YYYY-MM-DD."),
        time_minutes: z
          .number()
          .int()
          .min(0)
          .max(1439)
          .describe("Session start time as minutes past midnight (0-1439, e.g. 540 = 09:00)."),
        duration: z
          .number()
          .int()
          .positive()
          .describe("Session length in minutes."),
        trainer_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional per-session instructor override. Resolve with trainers_find."),
      }),
    )
    .optional()
    .describe("One-off sessions on specific dates, added on top of any recurrence blocks (e.g. an extra makeup date)."),
  skip_holidays: z
    .boolean()
    .optional()
    .describe(
      "When true, skip generating sessions that fall on public / state-wide holidays. Holiday calendars are " +
        "system-wide (shared across all companies) and applied per the venue's region: a regional (non-country-wide) " +
        "holiday only applies when the venue's location has a region set — otherwise only country/state-wide " +
        "holidays are skipped.",
    ),
  skip_school_holidays: z
    .boolean()
    .optional()
    .describe(
      "When true, skip sessions that fall within school-holiday periods. Same system-wide, region-distributed " +
        "calendar as skip_holidays — the venue's location must have a region set for region-specific school " +
        "holidays to apply; otherwise only country-wide ones are skipped.",
    ),
  skip_custom_holidays: z
    .boolean()
    .optional()
    .describe(
      "When true, skip sessions on dates the company itself has defined as holidays/closures — company-specific, " +
        "independent of the shared public/school-holiday calendars.",
    ),
};

const inputSchema = z.object(previewEventsInputSchema);

export async function runPreviewEvents(
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

  if ((input.blocks?.length ?? 0) === 0 && (input.additional_dates?.length ?? 0) === 0) {
    return errorResult(
      "Provide at least one block (recurrence pattern) or one entry in additional_dates.",
    );
  }

  const blocks: EventsPreviewBlock[] = [];
  const issues: string[] = [];
  (input.blocks ?? []).forEach((b, idx) => {
    const hasCount = b.count !== undefined;
    const hasUntil = b.until_date !== undefined;
    let resolvedUntil: string | undefined;
    if (hasCount && hasUntil) {
      issues.push(
        `blocks[${idx}]: pass either count or until_date, not both.`,
      );
      return;
    }
    if (!hasCount && !hasUntil) {
      if (input.to_date) {
        resolvedUntil = input.to_date;
      } else {
        issues.push(
          `blocks[${idx}]: needs count or until_date (or supply a top-level to_date as fallback).`,
        );
        return;
      }
    }

    const block: EventsPreviewBlock = {
      ...(b.weekdays ? { weekdays: b.weekdays } : {}),
      time_minutes: b.time_minutes,
      duration: b.duration,
      all_day: b.all_day ?? false,
      // Billable — must match what classes_commit_class actually creates, or the
      // preview lies about what the class will cost. See the note there.
      billable: true,
      ...(b.cadence ? { cadence: b.cadence } : {}),
      ...(b.trainer_id ? { trainer_id: b.trainer_id } : {}),
      ...(hasCount ? { count: b.count } : {}),
      ...(hasUntil ? { until_date: b.until_date } : {}),
      ...(!hasCount && !hasUntil && resolvedUntil
        ? { until_date: resolvedUntil }
        : {}),
    };
    blocks.push(block);
  });
  if (issues.length > 0) {
    return errorResult(issues.join(" "));
  }

  const body: EventsPreviewRequest = {
    place_id: input.place_id,
    from_date: input.from_date,
    blocks,
    additional_dates: (input.additional_dates ?? []).map((d) => ({
      date_string: d.date_string,
      time_minutes: d.time_minutes,
      duration: d.duration,
      billable: true,
      ...(d.trainer_id ? { trainer_id: d.trainer_id } : {}),
    })),
    skip_holidays: input.skip_holidays ?? false,
    skip_school_holidays: input.skip_school_holidays ?? false,
    skip_custom_holidays: input.skip_custom_holidays ?? false,
  };

  try {
    // company_id guaranteed by resolveCompanyId wrapper (see index.ts).
    const { response } = await eventsPreview(body, withCompany(auth, input.company_id!));
    const events: PreviewEvent[] = response.events.map((e) => ({
      date_string: e.date_string,
      time: minutesToHHMM(e.time_minutes),
      time_minutes: e.time_minutes,
      duration: e.duration,
      ...(e.trainer_id !== undefined ? { trainer_id: e.trainer_id } : {}),
    }));
    const output = {
      events,
      event_count: events.length,
      skipped: response.skipped ?? [],
      holidays_snapshot_id: response.holidays_snapshot_id ?? null,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not expand recurrence (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
