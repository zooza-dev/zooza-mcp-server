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
  "Expands one or more recurrence patterns and/or ad-hoc dates into the concrete list of class sessions, honouring holiday-skip flags. Stateless — performs no writes. Call this once per pattern the user describes during class creation. Accumulate the returned sessions across multiple calls (Claude side) until the user says they're done, then pass the full list to `classes_commit_class`. Each block must carry EXACTLY ONE of `count` (stop after N sessions) or `until_date` (stop on a fixed date) — count mode is preferred when the user says \"X sessions\". A top-level `to_date` acts as a fallback `until_date` for any block that omits both. `place_id` is required so api-v1 can apply the correct subdivision-scoped school-holiday calendar.";

export const previewEventsInputSchema = {
  company_id: companyIdSchema,
  place_id: z.number().int().positive(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  blocks: z
    .array(
      z.object({
        weekdays: z.array(z.enum(WEEKDAYS)).optional(),
        time_minutes: z.number().int().min(0).max(1439),
        duration: z.number().int().positive(),
        all_day: z.boolean().optional(),
        billable: z.boolean().optional(),
        cadence: z.enum(CADENCES).optional(),
        trainer_id: z.number().int().positive().optional(),
        count: z.number().int().min(1).max(500).optional(),
        until_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .optional(),
  additional_dates: z
    .array(
      z.object({
        date_string: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time_minutes: z.number().int().min(0).max(1439),
        duration: z.number().int().positive(),
        billable: z.boolean().optional(),
        trainer_id: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  skip_holidays: z.boolean().optional(),
  skip_school_holidays: z.boolean().optional(),
  skip_custom_holidays: z.boolean().optional(),
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
      billable: b.billable ?? true,
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
      billable: d.billable ?? true,
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
      billable: e.billable,
      ...(e.trainer_id !== undefined ? { trainer_id: e.trainer_id } : {}),
    }));
    const output = {
      events,
      event_count: events.length,
      skipped: response.skipped ?? [],
      holidays_snapshot_id: response.holidays_snapshot_id ?? null,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
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
