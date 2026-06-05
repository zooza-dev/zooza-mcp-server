import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { getCallerContext, type CallerContext } from "./caller-context.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import type {
  AddSessionSummaryFieldResult,
  AddSessionSummaryResult,
  EventSummaryState,
  RawAttendanceRow,
  RawEventDetail,
} from "./types.js";

const MAX_LEN = 4000;
const WRITER_ROLES = new Set(["owner", "assistant"]);

export const addSessionSummaryTitle = "Add a session summary";

export const addSessionSummaryDescription =
  "Write a post-session summary on one event. Two independent fields:\n\n- `public_summary` — visible to attendees / parents via their in-app Zooza feed. Use when the user says \"write a summary for the parents,\" \"send a recap,\" \"note for the families,\" etc. After write, every attendee's Person_Feed gets a `SUMMARY_PUBLIC` entry — parents see it in their client portal.\n- `internal_summary` — admin / team only. Use when the user says \"add a note for the team,\" \"private note,\" \"reminder for next week,\" etc. Not visible to parents.\n\nAt least one of the two must be provided. Both can be written in one call — the tool fans out the two PUTs api-v1 requires (the upstream endpoint dispatches on which field is in the body, so they cannot be combined). The tool checks the caller's role (**owner / assistant only** — trainers (`member`) cannot write summaries) and the event's `summary_public_locked` flag before writing; refuses cleanly when blocked. Returns the post-write state so you can confirm to the user what's now visible to whom.\n\n**Pairs naturally with `mark_attendance`.** After marking attendance for a session, offer to write a summary (always optional in V1; no api-v1 rule makes it mandatory). Don't volunteer a summary for an event that already has one (`summary.public_set=true` in the get_attendance / mark_attendance result) unless the user explicitly asks to update it.";

export const addSessionSummaryInputSchema = {
  company_id: companyIdSchema,
  event_id: z
    .number()
    .int()
    .positive()
    .describe("Target event id (one session of a class). Required."),
  public_summary: z
    .string()
    .max(MAX_LEN)
    .optional()
    .describe(
      "Parent-visible note. Delivered to each attendee's in-app Person_Feed. At least one of public_summary / internal_summary required.",
    ),
  internal_summary: z
    .string()
    .max(MAX_LEN)
    .optional()
    .describe(
      "Admin-only note on the event. Not visible to attendees. At least one of public_summary / internal_summary required.",
    ),
  override_locked: z
    .boolean()
    .optional()
    .describe(
      "When the event's public summary is locked AND the caller is owner, set this true to write anyway. Refused for non-owners regardless.",
    ),
};

const inputSchema = z.object(addSessionSummaryInputSchema);

export async function runAddSessionSummary(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: AddSessionSummaryResult;
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

  if (
    input.public_summary === undefined &&
    input.internal_summary === undefined
  ) {
    return errorResult(
      "At least one of public_summary or internal_summary is required.",
    );
  }

  const callAuth = withCompany(auth, input.company_id!);

  // Step 1 — caller role gate. Refuse early; no upstream PUT for non-writers.
  let caller: CallerContext | null;
  try {
    caller = await getCallerContext(callAuth);
  } catch {
    caller = null;
  }
  if (!caller || caller.role === null || !WRITER_ROLES.has(caller.role)) {
    return errorResult(
      caller && caller.role
        ? `low_permissions: role "${caller.role}" cannot write session summaries — only owners and assistants can.`
        : "low_permissions: unable to determine caller role; only owners and assistants can write session summaries.",
    );
  }
  const isOwner = caller.role === "owner";

  // Step 2 — event pre-read. Also surfaces summary_public_locked for the
  // soft-guard and gives us the current values for the optimistic
  // summary_state_before / _after comparison.
  let event: RawEventDetail | undefined;
  try {
    const collection = await zoozaFetch<{ data?: RawEventDetail[] }>(
      "/events",
      { query: { filter: "filter", ids: String(input.event_id) } },
      callAuth,
    );
    event = collection?.data?.[0];
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return errorResult(
        `Could not load event ${input.event_id} (api-v1 ${error.status}: ${error.humanMessage}).`,
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  if (!event || !event.id) {
    return errorResult(
      `event_not_found: event ${input.event_id} not found in this company.`,
    );
  }
  const isLocked = !!event.summary_public_locked;

  // Step 3 — internal write (sequential per the dispatch contract).
  const results: AddSessionSummaryResult["results"] = {
    internal_summary: { status: "skipped", reason: "not_provided" },
    public_summary: { status: "skipped", reason: "not_provided" },
  };

  if (input.internal_summary !== undefined) {
    results.internal_summary = await writeField(
      callAuth,
      input.event_id,
      "summary",
      input.internal_summary,
    );
  }

  // Step 4 — public write, gated by lock soft-guard.
  if (input.public_summary !== undefined) {
    if (isLocked && !(isOwner && input.override_locked === true)) {
      results.public_summary = {
        status: "error",
        error_code: "summary_locked",
        error_message: isOwner
          ? "summary_locked: this event's public summary is locked. Re-call with override_locked=true to write anyway."
          : "summary_locked: this event's public summary is locked. Only an owner can unlock it.",
      };
    } else {
      const writeResult = await writeField(
        callAuth,
        input.event_id,
        "summary_public",
        input.public_summary,
      );
      // Successful public write → count attendees that will receive the
      // SUMMARY_PUBLIC Person_Feed item. Cheap follow-up read; gives the
      // LLM concrete confirmation for the user.
      if (writeResult.status === "ok") {
        writeResult.delivered_to_attendees = await countAttendees(
          callAuth,
          input.event_id,
        );
      }
      results.public_summary = writeResult;
    }
  }

  // Step 5 — re-read for the post-write echo. Pay one more round trip; the
  // LLM-side confirmation UX win is worth it. Tolerate failure — fall back
  // to the optimistic view from the pre-read + intent.
  const summary_state_after = await readSummaryState(
    callAuth,
    input.event_id,
    caller,
    event,
    {
      wroteInternal:
        results.internal_summary.status === "ok"
          ? input.internal_summary
          : undefined,
      wrotePublic:
        results.public_summary.status === "ok" ? input.public_summary : undefined,
    },
  );

  const result: AddSessionSummaryResult = {
    event_id: input.event_id,
    results,
    summary_state_after,
  };

  return {
    content: [{ type: "text", text: formatMarkdown(result) }],
    structuredContent: result,
  };
}

async function writeField(
  auth: ZoozaAuth,
  eventId: number,
  fieldName: "summary" | "summary_public",
  value: string,
): Promise<AddSessionSummaryFieldResult> {
  try {
    await zoozaFetch<unknown>(
      `/events/${eventId}`,
      { method: "PUT", body: { [fieldName]: value } },
      auth,
    );
    return { status: "ok" };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      return {
        status: "error",
        error_code: `upstream_${error.status}`,
        error_message: error.humanMessage,
      };
    }
    return {
      status: "error",
      error_code: "unknown",
      error_message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function countAttendees(auth: ZoozaAuth, eventId: number): Promise<number> {
  try {
    const raw = await zoozaFetch<
      RawAttendanceRow[] | { data?: RawAttendanceRow[] }
    >("/attendance", { query: { event_id: eventId } }, auth);
    const rows = unwrapList<RawAttendanceRow>(raw).records;
    return rows.length;
  } catch {
    return 0;
  }
}

async function readSummaryState(
  auth: ZoozaAuth,
  eventId: number,
  caller: CallerContext,
  prior: RawEventDetail,
  optimistic: { wroteInternal?: string; wrotePublic?: string },
): Promise<EventSummaryState> {
  let event: RawEventDetail | undefined;
  try {
    const collection = await zoozaFetch<{ data?: RawEventDetail[] }>(
      "/events",
      { query: { filter: "filter", ids: String(eventId) } },
      auth,
    );
    event = collection?.data?.[0];
  } catch {
    event = prior;
  }
  const source = event ?? prior;
  return {
    public_set: hasNonEmpty(source.summary_public) || optimistic.wrotePublic !== undefined,
    public_filled_at: pickStr(source.summary_public_filled_at) ?? null,
    public_locked: !!source.summary_public_locked,
    internal_set: hasNonEmpty(source.summary) || optimistic.wroteInternal !== undefined,
    writable_by_caller:
      caller.role !== null && WRITER_ROLES.has(caller.role),
  };
}

/**
 * Compact markdown digest summarising the write outcome — passes through
 * to the user verbatim so the LLM doesn't burn output tokens reformatting
 * the structured result.
 */
function formatMarkdown(r: AddSessionSummaryResult): string {
  const lines: string[] = [];
  lines.push(`**Session summary write — event ${r.event_id}**`);
  lines.push("");

  const fields: Array<["Internal" | "Public", AddSessionSummaryFieldResult]> = [
    ["Internal", r.results.internal_summary],
    ["Public", r.results.public_summary],
  ];
  for (const [label, fr] of fields) {
    if (fr.status === "skipped") continue;
    if (fr.status === "ok") {
      const extra =
        label === "Public" && fr.delivered_to_attendees !== undefined
          ? ` — delivered to ${fr.delivered_to_attendees} attendee${fr.delivered_to_attendees === 1 ? "" : "s"}' feeds`
          : "";
      lines.push(`- ${label}: ✓ saved${extra}`);
    } else {
      lines.push(`- ${label}: ✗ ${fr.error_code ?? "error"} — ${fr.error_message ?? "unknown"}`);
    }
  }

  const s = r.summary_state_after;
  lines.push("");
  lines.push(
    `_Current state: public ${s.public_set ? "set" : "unset"}${s.public_locked ? " (locked)" : ""}, internal ${s.internal_set ? "set" : "unset"}._`,
  );
  return lines.join("\n");
}

function hasNonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
