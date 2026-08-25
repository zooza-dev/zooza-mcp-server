import { z } from "zod";

/**
 * Shared contract for dual-phase tools (spec ZMCP-20260824-001, admitted to the
 * taxonomy by ZMCP-20260611-007 Amendment 1a).
 *
 * A dual-phase tool replaces what used to be a `prepare_*` / `commit_*` PAIR of
 * registrations with ONE tool that dispatches on whether `token` was supplied:
 *
 *   no token  → preview phase. Validate, build a diff, save a plan, return a token.
 *   token     → apply phase. Load the plan, write, burn the token.
 *
 * Dispatch is on token presence rather than an explicit `phase` argument because a
 * token can only originate from a preview call — the model cannot fabricate one, so
 * the first call is *necessarily* a preview. An explicit `phase` field would add
 * something the model can get wrong in a way the token cannot.
 *
 * ── Why `confirmed` exists ──────────────────────────────────────────────────────
 * The token already makes it impossible to write without a preview. What the old
 * two-tool split additionally bought was a SECOND, independent signal: a tool
 * literally named `commit_*` reads as consequential, so calling it was a deliberate
 * act. One merged tool can be called twice in immediate succession with the token
 * handed straight back, skipping the beat where the user actually sees the diff.
 * `confirmed: true` restores a deliberate schema-level act.
 *
 * It cannot stop a model that asserts falsely — that is accepted. What it buys is
 * that a skipped confirmation becomes explicit and auditable rather than incidental:
 * `logs/audit.log` records `args`, so the flag lands in the audit trail.
 */

/**
 * Fields injected by the wrapper chain in `src/index.ts`, NOT by the caller.
 *
 * `resolveCompanyId` (index.ts:279-292) fills `company_id` in BEFORE the handler
 * runs, so it is present in `args` on every phase whether or not the model sent it —
 * and the handler cannot tell the two apart. It must therefore be tolerated on the
 * apply phase rather than rejected as a stray field.
 *
 * Tolerated is not the same as honoured: the apply phase MUST read its company from
 * the stored plan and never from `args`. That is the security property the old
 * split enforced structurally (commit halves were registered without
 * `resolveCompanyId`), and it is preserved here by convention plus the plan lookup —
 * a caller passing `company_id` alongside a token cannot redirect the write.
 */
const WRAPPER_INJECTED_FIELDS: readonly string[] = ["company_id"];

/** Always accepted on the apply phase, for every dual-phase tool. */
const BASE_APPLY_FIELDS: readonly string[] = ["token", "confirmed"];

export const dualPhaseTokenSchema = z
  .string()
  .optional()
  .describe(
    "Omit on the FIRST call — that call previews the change and returns a token. " +
      "Pass the token back on the SECOND call to apply the previewed change. " +
      "Single-use, expires in 15 minutes; if it is expired or already used, run the preview again.",
  );

export const dualPhaseConfirmedSchema = z
  .boolean()
  .optional()
  .describe(
    "Required (true) on the apply call, alongside `token`. Asserts that you have SHOWN " +
      "the user the preview from the first call and they approved it — not that you " +
      "believe the change is correct. If the user has not seen the preview, show it and " +
      "ask before setting this. Must be omitted on the preview call.",
  );

export type PhaseDecision =
  | { kind: "preview" }
  | { kind: "apply"; token: string }
  | { kind: "error"; message: string };

/**
 * Decide which phase a call is in, and enforce the three guards that every
 * dual-phase tool shares. Returns an `error` decision rather than throwing so the
 * caller can turn it into the tool's standard error envelope.
 *
 * @param rawArgs     the handler's incoming args, AFTER the wrapper chain has run
 * @param extraApplyFields  apply-phase fields beyond `token`/`confirmed` that this
 *                          specific tool accepts (e.g. `confirm_large_send` on
 *                          comms_send_message). Everything else sent with a token
 *                          is rejected.
 */
export function resolveDualPhase(
  rawArgs: unknown,
  extraApplyFields: readonly string[] = [],
): PhaseDecision {
  const args =
    rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};

  const token = args.token;
  const hasToken = typeof token === "string" && token.trim().length > 0;

  if (!hasToken) {
    // Guard 1 — `confirmed` is meaningless without a token. Rejecting it here stops
    // the model learning to send it pre-emptively, which would hollow the flag out.
    if (args.confirmed !== undefined) {
      return {
        kind: "error",
        message:
          "`confirmed` only applies when applying a previously previewed change. Omit it on this " +
          "call — this call returns a preview plus a token. Show the preview to the user, then " +
          "call again with that token and confirmed: true.",
      };
    }
    return { kind: "preview" };
  }

  // Guard 2 — nothing may ride along with a token except this tool's apply fields.
  // The plan already carries the change; accepting preview inputs here would let a
  // second call silently differ from what the user approved.
  const allowed = new Set<string>([
    ...BASE_APPLY_FIELDS,
    ...extraApplyFields,
    ...WRAPPER_INJECTED_FIELDS,
  ]);
  const stray = Object.keys(args)
    .filter((k) => args[k] !== undefined)
    .filter((k) => !allowed.has(k))
    .sort();
  if (stray.length > 0) {
    const accepted = [...BASE_APPLY_FIELDS, ...extraApplyFields].join(", ");
    return {
      kind: "error",
      message:
        `${stray.map((s) => `\`${s}\``).join(", ")} cannot be sent together with a token. The token ` +
        `already carries the previewed change; this call accepts only: ${accepted}. To change the ` +
        "inputs, run the preview call again WITHOUT a token and show the user the new preview.",
    };
  }

  // Guard 3 — the confirmation assertion itself.
  if (args.confirmed !== true) {
    return {
      kind: "error",
      message:
        "This call carries a token, so it will APPLY the previewed change. Set confirmed: true to " +
        "assert that you showed the user the preview and they approved it. If they have not seen " +
        "it, show them the preview from the first call and ask before applying.",
    };
  }

  return { kind: "apply", token: token as string };
}
