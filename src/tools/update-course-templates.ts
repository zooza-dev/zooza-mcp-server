import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema } from "./common.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { getPlan, markPlanUsed, savePlan } from "./course-templates-plan-store.js";

/**
 * Set which payment plan templates a programme offers — attach and DETACH
 * (spec ZMCP-20260824-006).
 *
 * Detaching had no MCP path at all, which mattered because api-v1 attaches templates
 * on its own: changing a programme's price_type or money_collection deletes every
 * attached template and re-attaches EVERY company template matching the new setting
 * (Course::change_money_collection, Course.php:2500-2519). On a company with 200+
 * templates that silently put 50 plans on one class. Without a detach tool the
 * operator had to clean that up by hand in the app.
 *
 * ── Why this does NOT use api-v1's bulk endpoint ────────────────────────────────
 * `POST /courses/{id}/payment_schedules_templates` with
 * `{payment_schedules_templates: [...]}` advertises "complete desired set" semantics,
 * but `__set_payment_schedules_templates` (courses.php:1514-1543) reconciles against
 * `__get_payment_schedules_templates()`, which is PAGINATED. Templates outside the
 * current page are neither added nor removed. Verified 2026-08-24: sending [343] to a
 * course with 50 attached left 14 unrelated templates attached and did not attach 343.
 *
 * So this tool drives the per-template endpoints instead — one DELETE per removal,
 * one single-`template_id` POST per addition. Slower, correct at any template count.
 */

export const updateCourseTemplatesTitle = "Set a programme's payment plan templates";

export const updateCourseTemplatesDescription =
  "Choose which payment plan templates a programme offers clients — attach new ones, and DETACH ones that should " +
  "not be there. Detaching is the point: Zooza attaches templates by itself when a programme's price type or " +
  "payment collection changes, and on a company with many templates that can silently put dozens of plans on a " +
  "programme. This is how you clean that up.\n\n" +
  "TWO CALLS. First WITHOUT `token`: writes nothing and returns what is attached now, what would be attached, and " +
  "the exact attach/detach list. Show it to the operator. Then call again with `token` + `confirmed: true` to " +
  "apply.\n\n" +
  "`template_ids` is the COMPLETE list the programme should end up with — anything attached but missing from it is " +
  "detached. Pass an empty array to detach everything. Detaching removes the plan from the programme and from its " +
  "classes; bookings already ON that plan keep their existing payment schedule, so no client is re-billed, but new " +
  "bookings can no longer pick it.\n\n" +
  "Use setup_add_payment_template to CREATE a template. Use classes_find_courses to resolve the programme.";

export const updateCourseTemplatesInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required on the FIRST call. The programme, from classes_find_courses."),
  template_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Required on the FIRST call. The COMPLETE set of payment template ids the programme should offer. Anything " +
        "currently attached and not listed here gets detached. Empty array detaches everything.",
    ),
};

const previewInput = z.object({
  company_id: z.number().int().positive().optional(),
  course_id: z.number().int().positive(),
  template_ids: z.array(z.number().int().positive()),
});

interface AttachedTemplate {
  id: number;
  name?: string;
  schedule_type?: string;
  frequency?: string;
  value?: number | string;
}

export async function runUpdateCourseTemplates(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const decision = resolveDualPhase(rawInput);
  if (decision.kind === "error") return errorResult(decision.message);
  if (decision.kind === "apply") return applyChanges(decision.token, auth);
  return previewChanges(rawInput, auth);
}

async function previewChanges(rawInput: unknown, auth: ZoozaAuth) {
  const parsed = previewInput.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);

  let attached: AttachedTemplate[];
  try {
    attached = await getList<AttachedTemplate>(
      `/courses/${input.course_id}/payment_schedules_templates`,
      callAuth,
    );
  } catch (error) {
    if (error instanceof ZoozaApiError && error.status === 404) {
      return errorResult(
        `Programme ${input.course_id} not found for this company. Resolve it with classes_find_courses first.`,
      );
    }
    return errorResult(upstreamMessage(error, "read the programme's payment templates"));
  }

  const currentIds = attached.map((t) => t.id);
  const wanted = [...new Set(input.template_ids)];
  const toDetach = currentIds.filter((id) => !wanted.includes(id));
  const toAttach = wanted.filter((id) => !currentIds.includes(id));

  if (toDetach.length === 0 && toAttach.length === 0) {
    return errorResult(
      "The programme already offers exactly those templates — nothing to change. Report that to the user rather than applying.",
    );
  }

  const warnings: string[] = [];
  if (wanted.length === 0) {
    warnings.push(
      "This detaches EVERY payment template from the programme. New bookings will have no payment plan to pick, " +
        "and a programme set to instalment collection will not bill anything until one is attached again.",
    );
  }
  if (toDetach.length > 0) {
    warnings.push(
      `Detaching ${toDetach.length} template(s) also removes their plans from this programme's classes. Bookings ` +
        "already on one of those plans KEEP their existing payment schedule — nobody is re-billed — but the plan " +
        "can no longer be chosen for new bookings.",
    );
  }

  const label = (id: number) => {
    const t = attached.find((x) => x.id === id);
    return t
      ? `${id} (${t.name || "unnamed"} — ${t.schedule_type ?? "?"}/${t.frequency ?? "?"}${t.value ? ` x${t.value}` : ""})`
      : `${id}`;
  };

  const { token, expires_in_seconds } = savePlan({
    company_id: input.company_id!,
    course_id: input.course_id,
    to_attach: toAttach,
    to_detach: toDetach,
    warnings,
  });

  const result = {
    token,
    expires_in_seconds,
    course_id: input.course_id,
    currently_attached: attached.map((t) => label(t.id)),
    will_detach: toDetach.map(label),
    will_attach: toAttach,
    resulting_count: currentIds.length - toDetach.length + toAttach.length,
    warnings,
    next_step:
      "Show this attach/detach list to the operator. After they confirm, call setup_update_course_templates again " +
      "with `token` and `confirmed: true` — and nothing else.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function applyChanges(token: string, auth: ZoozaAuth) {
  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(
      `This template plan is ${lookup.reason}. Run setup_update_course_templates again without a token to rebuild it.`,
    );
  }
  const plan = lookup.plan;
  const callAuth = withCompany(auth, plan.company_id);

  // Per-template calls, deliberately — see the module note on api-v1's paginated
  // bulk reconcile. Failures are collected rather than thrown: a partial result is
  // real state the operator must be told about, not something to hide behind an error.
  const detached: number[] = [];
  const attachFailed: Array<{ id: number; reason: string }> = [];
  const detachFailed: Array<{ id: number; reason: string }> = [];

  for (const id of plan.to_detach) {
    try {
      await zoozaFetch<unknown>(
        `/courses/${plan.course_id}/payment_schedules_templates/${id}`,
        { method: "DELETE" },
        callAuth,
      );
      detached.push(id);
    } catch (error) {
      detachFailed.push({ id, reason: shortReason(error) });
    }
  }

  const attached: number[] = [];
  for (const id of plan.to_attach) {
    try {
      await zoozaFetch<unknown>(
        `/courses/${plan.course_id}/payment_schedules_templates`,
        { method: "POST", body: { template_id: id } },
        callAuth,
      );
      attached.push(id);
    } catch (error) {
      attachFailed.push({ id, reason: shortReason(error) });
    }
  }

  markPlanUsed(token);

  let finalIds: number[] | null = null;
  try {
    finalIds = (
      await getList<AttachedTemplate>(`/courses/${plan.course_id}/payment_schedules_templates`, callAuth)
    ).map((t) => t.id);
  } catch {
    // Best-effort verification only.
  }

  const warnings = [...plan.warnings];
  if (detachFailed.length > 0) {
    warnings.push(
      `Could not detach ${detachFailed.map((f) => `${f.id} (${f.reason})`).join(", ")} — they are still attached.`,
    );
  }
  if (attachFailed.length > 0) {
    warnings.push(
      `Could not attach ${attachFailed.map((f) => `${f.id} (${f.reason})`).join(", ")}. A template must match the ` +
        "programme's price type: pay_as_you_go needs membership pricing, the others need a course fee.",
    );
  }

  const result = {
    updated: detachFailed.length === 0 && attachFailed.length === 0,
    course_id: plan.course_id,
    detached,
    attached,
    now_attached: finalIds,
    warnings,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function getList<T>(path: string, auth: ZoozaAuth): Promise<T[]> {
  const raw = await zoozaFetch<{ data?: T[] } | T[]>(path, {}, auth);
  const d = (raw as { data?: T[] })?.data ?? raw;
  return Array.isArray(d) ? d : [];
}

function shortReason(error: unknown): string {
  if (error instanceof ZoozaApiError) return `api-v1 ${error.status}: ${error.humanMessage}`;
  return error instanceof Error ? error.message : String(error);
}

function upstreamMessage(error: unknown, what: string): string {
  if (error instanceof ZoozaApiError) {
    if (error.status === 403) {
      return `api-v1 rejected the request: changing a programme's payment templates needs the edit_company permission.`;
    }
    return `Could not ${what} (api-v1 ${error.status}: ${error.humanMessage}).`;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
