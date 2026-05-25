import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import type {
  AdditionalDate,
  Cadence,
  EventsPreviewBlock,
  EventsPreviewRequest,
  EventsPreviewResponse,
  EventsPreviewResponseEvent,
  Weekday,
} from "./types.js";

const WEEKDAY_INDEX: Record<Weekday, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

const STUB_MAX_RANGE_DAYS = 730;
const STUB_MAX_COUNT_PER_BLOCK = 500;

function stubForced(): boolean {
  const v = process.env.EVENTS_PREVIEW_USE_STUB;
  return v !== undefined && v.trim().toLowerCase() !== "false" && v.trim() !== "0" && v.trim() !== "";
}

export async function eventsPreview(
  body: EventsPreviewRequest,
  auth: ZoozaAuth,
): Promise<{ response: EventsPreviewResponse; usedStub: boolean }> {
  if (stubForced()) {
    return { response: localPreviewStub(body), usedStub: true };
  }
  try {
    const response = await zoozaFetch<EventsPreviewResponse>(
      "/events/preview/",
      { method: "POST", body },
      auth,
    );
    return { response, usedStub: false };
  } catch (error) {
    if (
      error instanceof ZoozaApiError &&
      (error.status === 404 || error.status === 405)
    ) {
      return { response: localPreviewStub(body), usedStub: true };
    }
    throw error;
  }
}

function localPreviewStub(body: EventsPreviewRequest): EventsPreviewResponse {
  const start = parseISODate(body.from_date);
  const events: EventsPreviewResponseEvent[] = [];

  for (const block of body.blocks) {
    const hasUntil = block.until_date !== undefined;
    const hasCount = block.count !== undefined;
    if (hasUntil === hasCount) {
      throw new Error(
        "Each block must carry exactly one of `until_date` or `count`.",
      );
    }
    if (hasCount && (block.count! <= 0 || block.count! > STUB_MAX_COUNT_PER_BLOCK)) {
      throw new Error(
        `Block count must be between 1 and ${STUB_MAX_COUNT_PER_BLOCK} (got ${block.count}).`,
      );
    }

    const stopDate = hasUntil ? parseISODate(block.until_date!) : addDays(start, STUB_MAX_RANGE_DAYS);
    if (hasUntil && stopDate < start) {
      throw new Error(
        `Block until_date (${block.until_date}) is before from_date (${body.from_date}).`,
      );
    }

    const limit = hasCount ? block.count! : Number.POSITIVE_INFINITY;
    walkBlock(block, start, stopDate, limit, events);
  }

  for (const extra of body.additional_dates) {
    events.push(extraToEvent(extra));
  }

  events.sort((a, b) =>
    a.date_string === b.date_string
      ? a.time_minutes - b.time_minutes
      : a.date_string.localeCompare(b.date_string),
  );

  return { events, skipped: [], holidays_snapshot_id: null };
}

function walkBlock(
  block: EventsPreviewBlock,
  start: Date,
  stopDate: Date,
  limit: number,
  out: EventsPreviewResponseEvent[],
): void {
  const cadence: Cadence = block.cadence ?? "weekly";
  const weekdays = block.weekdays?.map((w) => WEEKDAY_INDEX[w]) ?? null;
  let emitted = 0;

  const tryEmit = (day: Date): boolean => {
    out.push(makeEvent(day, block));
    emitted += 1;
    return emitted < limit;
  };

  if (cadence === "daily") {
    for (
      let day = new Date(start);
      day <= stopDate && emitted < limit;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      if (weekdays && !weekdays.includes(day.getUTCDay())) continue;
      if (!tryEmit(day)) return;
    }
    return;
  }

  if (cadence === "weekly" || cadence === "biweekly") {
    const step = cadence === "weekly" ? 7 : 14;
    const anchorWeekdays = weekdays ?? [start.getUTCDay()];
    // Produce in chronological order by merging per-weekday walks.
    type Walker = { next: Date };
    const walkers: Walker[] = anchorWeekdays.map((wd) => ({
      next: firstOccurrence(start, wd),
    }));
    while (emitted < limit) {
      let earliest: Walker | null = null;
      for (const w of walkers) {
        if (w.next > stopDate) continue;
        if (!earliest || w.next < earliest.next) earliest = w;
      }
      if (!earliest) return;
      if (!tryEmit(earliest.next)) return;
      earliest.next = addDays(earliest.next, step);
    }
    return;
  }

  if (cadence === "monthly") {
    const targetWeekdays = weekdays ?? [start.getUTCDay()];
    let monthCursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    while (emitted < limit) {
      const monthEvents: Date[] = [];
      for (const wd of targetWeekdays) {
        const diff = (wd - monthCursor.getUTCDay() + 7) % 7;
        const eventDay = new Date(monthCursor);
        eventDay.setUTCDate(1 + diff);
        if (eventDay >= start && eventDay <= stopDate) {
          monthEvents.push(eventDay);
        }
      }
      monthEvents.sort((a, b) => a.getTime() - b.getTime());
      for (const d of monthEvents) {
        if (!tryEmit(d)) return;
      }
      monthCursor = new Date(
        Date.UTC(monthCursor.getUTCFullYear(), monthCursor.getUTCMonth() + 1, 1),
      );
      // Safety: if we're in count mode and no end date, stop after 60 months.
      if (monthCursor > stopDate) return;
    }
  }
}

function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function formatISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function firstOccurrence(start: Date, weekday: number): Date {
  const d = new Date(start);
  const diff = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function makeEvent(
  day: Date,
  block: {
    time_minutes: number;
    duration: number;
    billable: boolean;
    all_day: boolean;
    trainer_id?: number;
  },
): EventsPreviewResponseEvent {
  return {
    date_string: formatISODate(day),
    time_minutes: block.all_day ? 0 : block.time_minutes,
    duration: block.duration,
    billable: block.billable,
    ...(block.trainer_id !== undefined ? { trainer_id: block.trainer_id } : {}),
  };
}

function extraToEvent(extra: AdditionalDate): EventsPreviewResponseEvent {
  return {
    date_string: extra.date_string,
    time_minutes: extra.time_minutes,
    duration: extra.duration,
    billable: extra.billable,
    ...(extra.trainer_id !== undefined ? { trainer_id: extra.trainer_id } : {}),
  };
}
