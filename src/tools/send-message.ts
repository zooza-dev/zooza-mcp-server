import { z } from "zod";
import type { ZoozaAuth } from "../auth/types.js";
import { companyIdSchema } from "./common.js";
import { runCommitMessage } from "./commit-message.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { prepareMessageInputSchema, runPrepareMessage } from "./prepare-message.js";

/**
 * Dual-phase merge of the former `comms_prepare_message` / `comms_commit_message`
 * pair (spec ZMCP-20260824-001). Phase logic is unchanged — both run functions keep
 * their own zod parsing, so every warning, consent rule and error message survives.
 *
 * TWO confirmation flags coexist here, and they assert DIFFERENT things. They must
 * not be merged (spec ZMCP-20260824-001, Approach):
 *
 *   confirmed          — "the operator saw the plan and approved it." Required on
 *                        EVERY apply call.
 *   confirm_large_send — "the operator accepted the recipient COUNT." Required only
 *                        on the follow-up call when the send exceeded api-v1's
 *                        approval threshold and came back `pending_approval`.
 *
 * Note the apply phase is legitimately repeatable here: when api-v1 parks a large
 * send in `pending_approval`, `runCommitMessage` does NOT burn the plan — it
 * re-surfaces the gate. So the same token is used twice, and `confirmed: true` rides
 * on both calls. That is correct: the operator confirmed the plan, then the size.
 */

export const sendMessageTitle = "Email clients (plan, then send)";

export const sendMessageDescription =
  "Email clients of this company. Describe the audience (a course/programme, a class schedule, a specific " +
  "booking, one client, a saved segment, an ad-hoc cohort, or course-level labels) and the content (an existing " +
  "template `type` from comms_list_templates, or a custom subject + body which may use *|MERGE_VAR|* tags from " +
  "comms_list_merge_vars).\n\n" +
  "TWO CALLS. First WITHOUT `token`: sends NOTHING. Returns the estimated recipient count, a sample of " +
  "recipients, the content as it will be sent, warnings (unknown merge tags, zero recipients), and a single-use " +
  "token. Show that plan to the operator and get explicit confirmation. Then call again with `token` + " +
  "`confirmed: true` to actually send. Calling the first form again with adjusted filters is free and repeatable — " +
  "refine the audience that way rather than guessing.\n\n" +
  "LARGE SENDS need a SECOND confirmation. If the recipient count exceeds the approval threshold, the sending " +
  "call returns `requires_second_confirmation: true` with the count and job id and sends NOTHING yet. Show the " +
  "operator the exact recipient count and ask again (e.g. \"Send to all 105 clients?\"). Only after they " +
  "explicitly agree, call once more with the SAME token, `confirmed: true`, and `confirm_large_send: true`. If " +
  "they decline, send nothing.\n\n" +
  "Resolve names to ids first: classes_find_courses for a course/programme → course_id, classes_find_classes for " +
  "a class/group by name → schedule_id, sessions_find_events for a single session → event_id; never guess ids. " +
  "When the operator names an ad-hoc cohort rather than the whole company — \"everyone who hasn't paid\", the " +
  "unpaid roster, the waitlist, this week's sign-ups — resolve it with bookings_find and pass the resulting " +
  "registration_id LIST as audience.registration_id. Reserve audience.whole_company for genuinely company-wide " +
  "sends; do NOT use it as a shortcut for a named subset, or you email far more people than the operator asked for.";

/**
 * Preview fields are reused verbatim from the prepare schema but made optional —
 * they are absent on the apply call, and `runPrepareMessage` still enforces them.
 */
export const sendMessageInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  confirm_large_send: z
    .boolean()
    .optional()
    .describe(
      "Different from `confirmed`. Set true ONLY on the follow-up call after a send came back " +
        "requires_second_confirmation: true AND the operator explicitly approved the recipient COUNT. Never set " +
        "it on the first sending call, and never without that separate approval.",
    ),
  channel: prepareMessageInputSchema.channel.optional(),
  audience: prepareMessageInputSchema.audience.optional(),
  content: prepareMessageInputSchema.content.optional(),
  marketing: prepareMessageInputSchema.marketing
    .optional()
    .describe(
      "REQUIRED on the FIRST call. true = promotional content (consent rules apply; say so to the operator). " +
        "false = operational (schedule changes, payment reminders, session info).",
    ),
  schedule_at: prepareMessageInputSchema.schedule_at,
  bcc: prepareMessageInputSchema.bcc,
};

export async function runSendMessage(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const decision = resolveDualPhase(rawInput, ["confirm_large_send"]);

  if (decision.kind === "error") {
    return { isError: true, content: [{ type: "text" as const, text: decision.message }] };
  }

  if (decision.kind === "preview") {
    return runPrepareMessage(rawInput, auth);
  }

  const args = (rawInput ?? {}) as Record<string, unknown>;
  return runCommitMessage(
    {
      token: decision.token,
      // Forwarded deliberately: it is an apply-phase input, unlike everything else,
      // which the plan already carries.
      confirm_large_send: args.confirm_large_send === true ? true : undefined,
    },
    auth,
  );
}
