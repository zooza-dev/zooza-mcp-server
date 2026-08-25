import { z } from "zod";
import type { ZoozaAuth } from "../auth/types.js";
import { companyIdSchema } from "./common.js";
import { runCommitCourseSettings } from "./commit-course-settings.js";
import { dualPhaseConfirmedSchema, dualPhaseTokenSchema, resolveDualPhase } from "./dual-phase.js";
import { runPrepareCourseSettings } from "./prepare-course-settings.js";
import { SECTION_NAMES } from "./course-settings-model.js";

/**
 * Dual-phase merge of the former `classes_prepare_course_settings` /
 * `classes_commit_course_settings` pair (spec ZMCP-20260824-001).
 *
 * The two phases' logic is UNCHANGED — this module only owns the tool surface and
 * the dispatch. `runPrepareCourseSettings` and `runCommitCourseSettings` keep their
 * own zod parsing, so every error-catalog and warning-catalog row from both halves
 * stays reachable with its original message text, and their unit tests keep testing
 * the same functions.
 *
 * Preview-phase fields are declared optional here because they are absent on the
 * apply call. Their real validation still happens inside `runPrepareCourseSettings`,
 * which rejects a missing `course_id` / `section` exactly as before.
 */

export const updateCourseSettingsTitle = "Change programme settings (preview, then apply)";

export const updateCourseSettingsDescription =
  "Change the settings of an existing programme (course) — pricing, online booking, make-up sessions, trial, " +
  "auto-enrolment, attendance, feedback, basic info, or archiving. Works one section at a time, like the settings " +
  "tiles in the Zooza app.\n\n" +
  "TWO CALLS. First call WITHOUT `token`: returns a diff of current → proposed values, warnings, and a single-use " +
  "token. Show that diff to the user and get their approval. Second call with `token` + `confirmed: true`: applies " +
  "it. Send nothing else on the second call — the token already carries the change. The token expires in 15 " +
  "minutes; if it is expired or used, run the first call again.\n\n" +
  "Resolve the programme first with `classes_find_courses` (needs `course_id`). This tool edits the PROGRAMME " +
  "level — rules inherited by all its classes. To change one class/group (capacity, venue, instructor, time), use " +
  "the classes tools instead. Some sections only apply to \"booking for full programme duration\" programmes: " +
  "trial, make-up sessions, auto-enrolment.";

export const updateCourseSettingsInputSchema = {
  company_id: companyIdSchema,
  token: dualPhaseTokenSchema,
  confirmed: dualPhaseConfirmedSchema,
  course_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Programme (course) id — required on the FIRST call. Resolve names with classes_find_courses; never guess ids.",
    ),
  section: z
    .enum(SECTION_NAMES)
    .optional()
    .describe(
      "Which settings tile to change — required on the FIRST call. One section per call, mirroring the Zooza " +
        "app's settings dashboard. 'trial', 'makeup_sessions' and 'auto_enrolment' only exist for 'booking for " +
        "full programme duration' (full2) programmes.",
    ),
  changes: z
    .record(z.unknown())
    .optional()
    .describe(
      "Field → new value, required on the FIRST call. Keys limited to the chosen section's whitelist (an invalid " +
        'field returns the allowed list). Booleans as true/false, enums as their string value. Example: {"online_registration": false}.',
    ),
};

export async function runUpdateCourseSettings(
  rawInput: unknown,
  auth: ZoozaAuth,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  const decision = resolveDualPhase(rawInput);

  if (decision.kind === "error") {
    return { isError: true, content: [{ type: "text" as const, text: decision.message }] };
  }

  if (decision.kind === "preview") {
    return runPrepareCourseSettings(rawInput, auth);
  }

  // Apply phase. Only the token is forwarded — the company, course and put_body all
  // come from the stored plan, so a caller cannot redirect the write by passing
  // company_id alongside the token (see dual-phase.ts WRAPPER_INJECTED_FIELDS).
  return runCommitCourseSettings({ token: decision.token }, auth);
}
