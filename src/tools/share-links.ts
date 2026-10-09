import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, pickStr, unwrapList } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { getPlan, markPlanUsed, savePlan } from "./share-link-plan-store.js";
import type { ApiListResponse } from "./types.js";

// classes_add_share_link + classes_list_share_links — private (secret) registration
// links for one class, e.g. late enrolment until a date (GitHub #18, spec
// ZMCP-20261009-005). The same thing as "private access link" in the Zooza app's
// share modal (app components/share_modal/share_modal.js).
//
// api-v1 contract:
//  - GET  /schedules/{id}/share_links → the class's links (schedules.php:54-56 →
//    __get_share_links, :268-289; company-scoped).
//  - POST /schedules/{id}/share_links {application_id, expires: "YYYY-MM-DD" | null}
//    (schedules.php:409-411 → __post_share_links, :304-326; body as the app sends it,
//    share_modal.js:64-76). Share_Link::insert (class/Share_Link.php:115-159) stores a
//    row with a random token and link = the project's registration widget URL +
//    ?share=<token> (regenerate_link, :41-62 — widgets_2 row with type='registration';
//    without one the link stays empty). application_id is required
//    (class/Zooza/Resource/Share_Link.php:41).
//  - `expires` is parsed with createFromFormat('Y-m-d') and no `!` (Share_Link.php:120,
//    Utils.php:83-117), so it takes the CURRENT time of day: a link made at 14:00 with
//    expires 2026-11-01 expires 2026-11-01 14:00. A cron flips status to 'expired' once
//    expires < NOW() (class/Cron/Share_Links.php). Hence "today" is refused below: it
//    would expire at the next cron run.
//  - A link only works while it is active and not expired AND its class is active and
//    not ended (Share_Link.php:283-310; Schedule::ended, class/Schedule.php:886-899).
//  - Registration widgets come from GET /companies/{id}/applications — the app's boot
//    call (app main.js:4566) — filtered like the share modal: type 'widget'
//    (applications.js:53-56) with a 'registration' widget.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_EXPIRY_DAYS = 7; // the app's default (share_modal.js:182)

export const classesAddShareLinkTitle = "Create a private registration link for a class";

export const classesAddShareLinkDescription =
  "Create a private (secret) registration link for ONE class, e.g. late enrolment into a full or closed class " +
  "until a date — the Zooza app's \"private access link\". Only works for that class, while it is active and not " +
  "ended. Call it TWICE: first without a token → preview (class, expiry, registration widget, warnings); show it " +
  "and get a yes; then call with the token and confirmed:true. Several classes = one call each. The returned link " +
  "contains a secret token: give it only to the operator / the intended clients. Resolve schedule_id with " +
  "classes_find_classes; see existing links with classes_list_share_links.";

export const classesAddShareLinkInputSchema = {
  company_id: companyIdSchema,
  schedule_id: z.number().int().positive().optional().describe("Class (schedule) id. Preview call only."),
  expires: z
    .string()
    .regex(DATE, "expires must be YYYY-MM-DD")
    .nullable()
    .optional()
    .describe(
      `Last day the link works (YYYY-MM-DD, after today). Omit = today + ${DEFAULT_EXPIRY_DAYS} days; null = never expires.`,
    ),
  application_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Registration widget the link opens. Omit when the company has one; the preview lists choices otherwise."),
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
};

const addPreviewSchema = z.object({
  company_id: z.number().int().positive().optional(),
  schedule_id: z.number().int().positive(),
  expires: z.string().regex(DATE).nullable().optional(),
  application_id: z.number().int().positive().optional(),
});

export const classesListShareLinksTitle = "List a class's private registration links";

export const classesListShareLinksDescription =
  "List the private (secret) registration links of ONE class: link, status (active / inactive / expired), expiry, " +
  "how often it was opened and used. Links contain a secret token — share them only with the operator.";

export const classesListShareLinksInputSchema = {
  company_id: companyIdSchema,
  schedule_id: z.number().int().positive().describe("Class (schedule) id — resolve with classes_find_classes."),
};

const listSchema = z.object(classesListShareLinksInputSchema);

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

interface RawSchedule {
  id?: number;
  name?: string | null;
  course_id?: number;
  status?: string;
  end?: string | null;
  time?: number | string | null;
  total_events?: number | string | null;
}

interface RawApplication {
  id?: number;
  type?: string;
  active?: boolean;
  domain?: string;
  widgets?: Array<{ type?: string; url?: string }>;
}

interface RawShareLink {
  id?: number;
  application_id?: number;
  link?: string | null;
  status?: string;
  expires?: string | null;
  created?: string;
  __calc__opened?: number | null;
  __calc__used?: number | null;
}

export interface RegistrationWidget {
  application_id: number;
  name: string;
  registration_url: string;
}

// ── classes_add_share_link ──────────────────────────────────────────────────────

export async function runClassesAddShareLink(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "apply") return applyPlan(decision.token, auth);
  return previewPlan(rawInput, auth);
}

async function previewPlan(rawInput: unknown, auth: ZoozaAuth, now: Date = new Date()): Promise<ToolResult> {
  const parsed = addPreviewSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}. ` +
        "schedule_id is required on the preview call.",
    );
  }
  const input = parsed.data;
  const today = localDate(now);

  let expires: string | null;
  if (input.expires === undefined) {
    expires = addDays(today, DEFAULT_EXPIRY_DAYS);
  } else if (input.expires === null) {
    expires = null;
  } else {
    if (!isRealDate(input.expires)) return errorResult(`expires ${input.expires} is not a real date.`);
    if (input.expires <= today) {
      return errorResult(
        `expires must be after today (${today}) — a link expires on that date at the time of day it was created, ` +
          "so today would expire it almost immediately. Pass a later date, or null for no expiry.",
      );
    }
    expires = input.expires;
  }

  const callAuth = withCompany(auth, input.company_id!);
  let schedule: RawSchedule;
  let widgets: RegistrationWidget[];
  try {
    const [rawSchedule, rawApps] = await Promise.all([
      zoozaFetch<{ data?: RawSchedule } | RawSchedule>(`/schedules/${input.schedule_id}`, {}, callAuth),
      zoozaFetch<ApiListResponse<RawApplication> | RawApplication[]>(
        `/companies/${input.company_id}/applications`,
        { query: { page_size: 100 } },
        callAuth,
      ),
    ]);
    schedule = (rawSchedule as { data?: RawSchedule })?.data ?? (rawSchedule as RawSchedule);
    widgets = registrationWidgets(unwrapList<RawApplication>(rawApps).records);
  } catch (error) {
    // api-v1 answers an unknown/foreign schedule id with 400 as well as 404 (seen on
    // api-test 2026-10-09: GET /schedules/1 → 400).
    if (error instanceof ZoozaApiError && error.path.startsWith("/schedules/") && (error.status === 404 || error.status === 400)) {
      return errorResult(
        `Class ${input.schedule_id} not found (api-v1 ${error.status}: ${error.humanMessage}). Use classes_find_classes to look it up.`,
      );
    }
    return apiError(error, "Could not load the class or registration widgets");
  }
  if (!schedule || schedule.id === undefined) {
    return errorResult(`Class ${input.schedule_id} not found. Use classes_find_classes to look it up.`);
  }

  const picked = pickWidget(widgets, input.application_id);
  if (!picked.ok) return errorResult(picked.message);
  const widget = picked.widget;

  const warnings: string[] = [];
  const status = pickStr(schedule.status) ?? "unknown";
  if (status !== "active") {
    warnings.push(`The class is ${status}, not active — the link will not work until the class is active again.`);
  }
  const end = pickStr(schedule.end ?? undefined)?.slice(0, 10);
  if (classEnded(schedule, now)) {
    warnings.push(`The class already ended (${end}) — the link will not work.`);
  } else if (end && Number(schedule.total_events ?? 0) > 0 && (expires === null || expires > end)) {
    // Without sessions Schedule::ended is never true, so the class end does not cut the link off.
    warnings.push(`The class ends ${end}; the link stops working then, before its expiry.`);
  }

  const { token, expires_in_seconds } = savePlan({
    company_id: input.company_id!,
    schedule_id: input.schedule_id,
    application_id: widget.application_id,
    expires,
  });

  const result = {
    token,
    expires_in_seconds,
    class: {
      schedule_id: schedule.id,
      name: pickStr(schedule.name ?? undefined) ?? null,
      course_id: schedule.course_id ?? null,
      status,
      end: end ?? null,
    },
    link_expires: expires,
    expiry_note: expires === null ? "never expires" : `expires on ${expires} at the time of day it is created`,
    registration_widget: widget,
    ...(warnings.length ? { warnings } : {}),
    next_step:
      "Show the operator the class, the expiry and the widget (and any warnings). After they confirm, call " +
      "classes_add_share_link again with `token` and `confirmed: true` only.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function applyPlan(token: string, auth: ZoozaAuth): Promise<ToolResult> {
  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This share-link preview is ${lookup.reason}. Run classes_add_share_link again without a token to rebuild it.`,
    );
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);
  let raw: { data?: RawShareLink } | RawShareLink;
  try {
    raw = await zoozaFetch<{ data?: RawShareLink } | RawShareLink>(
      `/schedules/${plan.schedule_id}/share_links`,
      { method: "POST", body: shareLinkBody(plan.application_id, plan.expires) },
      callAuth,
    );
  } catch (error) {
    // A single POST: if it failed, nothing was written, so the token stays usable.
    return apiError(error, "Could not create the share link");
  }
  // Burn only after the write landed (spec ZMCP-20261009-005).
  markPlanUsed(token);

  const row = (raw as { data?: RawShareLink })?.data ?? (raw as RawShareLink);
  const link = pickStr(row?.link ?? undefined) ?? null;
  const result = {
    share_link_id: row?.id ?? null,
    schedule_id: plan.schedule_id,
    link,
    expires: row?.expires ?? plan.expires,
    status: row?.status ?? null,
    ...(link
      ? { note: "The link contains a secret token — give it only to the operator / the intended clients." }
      : {
          warning:
            "Zooza created the link but returned no URL (the registration widget could not be loaded). " +
            "Check it with classes_list_share_links or in the Zooza app.",
        }),
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** POST body — the app's create payload (share_modal.js:64-76). */
export function shareLinkBody(applicationId: number, expires: string | null): Record<string, unknown> {
  return { application_id: applicationId, expires };
}

/** Projects that can host a share link: a widget-type application with a
 *  registration widget URL (what regenerate_link builds the link from). */
export function registrationWidgets(apps: RawApplication[]): RegistrationWidget[] {
  const out: RegistrationWidget[] = [];
  for (const app of apps) {
    if (app.type !== "widget" || app.active === false || typeof app.id !== "number") continue;
    const url = (app.widgets ?? []).map((w) => (w.type === "registration" ? pickStr(w.url) : undefined)).find(Boolean);
    if (!url) continue;
    out.push({ application_id: app.id, name: pickStr(app.domain) ?? `project ${app.id}`, registration_url: url });
  }
  return out;
}

export function pickWidget(
  widgets: RegistrationWidget[],
  applicationId: number | undefined,
): { ok: true; widget: RegistrationWidget } | { ok: false; message: string } {
  const choices = () => JSON.stringify(widgets);
  if (widgets.length === 0) {
    return {
      ok: false,
      message: "This company has no registration widget, so a share link has nowhere to point. Set one up in the Zooza app first.",
    };
  }
  if (applicationId !== undefined) {
    const hit = widgets.find((w) => w.application_id === applicationId);
    return hit
      ? { ok: true, widget: hit }
      : { ok: false, message: `application_id ${applicationId} is not a registration widget of this company. Choices: ${choices()}` };
  }
  if (widgets.length === 1) return { ok: true, widget: widgets[0] };
  return {
    ok: false,
    message:
      `This company has ${widgets.length} registration widgets — ask the operator which one the link should open, ` +
      `then call again with application_id. Choices: ${choices()}`,
  };
}

/** Schedule::ended (class/Schedule.php:886-899): never ended without sessions;
 *  otherwise ended once `end` + `time` (minutes from midnight) is past. */
export function classEnded(schedule: RawSchedule, now: Date): boolean {
  if (Number(schedule.total_events ?? 0) === 0) return false;
  const end = pickStr(schedule.end ?? undefined)?.slice(0, 10);
  if (!end || !isRealDate(end)) return false;
  const [y, m, d] = end.split("-").map(Number);
  const minutes = Number(schedule.time ?? 0) || 0;
  return new Date(y, m - 1, d, 0, minutes) < now;
}

// ── classes_list_share_links ────────────────────────────────────────────────────

export async function runClassesListShareLinks(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = listSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  try {
    const raw = await zoozaFetch<ApiListResponse<RawShareLink> | RawShareLink[]>(
      `/schedules/${input.schedule_id}/share_links`,
      { query: { page_size: 100 } },
      withCompany(auth, input.company_id!),
    );
    const { records, total } = unwrapList<RawShareLink>(raw);
    const result = { schedule_id: input.schedule_id, total, links: records.map(projectLink) };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return apiError(error, `Could not load share links of class ${input.schedule_id}`);
  }
}

export function projectLink(r: RawShareLink) {
  return {
    id: r.id ?? null,
    link: pickStr(r.link ?? undefined) ?? null,
    status: r.status ?? null,
    expires: r.expires ?? null,
    opened: r.__calc__opened ?? 0,
    used: r.__calc__used ?? 0,
    created: r.created ?? null,
    application_id: r.application_id ?? null,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in the server's local time (as find-events.ts todayDate). */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function isRealDate(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function apiError(error: unknown, prefix: string): ToolResult {
  if (error instanceof ZoozaApiError) return errorResult(`${prefix} (api-v1 ${error.status}: ${error.humanMessage}).`);
  return errorResult(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
