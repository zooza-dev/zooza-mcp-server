import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { getPlan, markPlanUsed, recordPlanJob } from "./message-plan-store.js";

export const commitMessageTitle = "Send a previously planned message";

export const commitMessageDescription =
  "Executes a message plan previously created by comms_prepare_message. Only call this after the operator has " +
  "seen the plan (recipient count, content) and EXPLICITLY confirmed sending. Takes the `token` from " +
  "comms_prepare_message — the audience and content are frozen in the plan and cannot be changed here; to change " +
  "anything, call comms_prepare_message again.\n\n" +
  "Most sends complete in this one call. BUT if the audience is larger than the company's approval threshold, " +
  "api-v1 creates the job in `pending_approval` and this tool returns `requires_second_confirmation: true` with " +
  "the recipient count and the job id — and sends NOTHING yet. When that happens: show the operator the exact " +
  "recipient count and ask a SECOND, explicit confirmation (e.g. \"Send to all 105 clients?\"). ONLY after they " +
  "explicitly say yes, call comms_commit_message again with the SAME token and `confirm_large_send: true` to " +
  "release the send. The operator never has to leave the conversation to approve. If they decline, send nothing. " +
  "Returns the created message job id and status.";

export const commitMessageInputSchema = {
  token: z
    .string()
    .describe("Single-use token from comms_prepare_message; expires after 15 minutes."),
  confirm_large_send: z
    .boolean()
    .optional()
    .describe(
      "Set to true ONLY on the SECOND call, after the operator has explicitly confirmed sending to a recipient " +
        "count that exceeded the approval threshold (the first call returned requires_second_confirmation: true). " +
        "Never set this on the first call, and never without that explicit second confirmation from the operator.",
    ),
};

const inputSchema = z.object(commitMessageInputSchema);

/** Defensive view of the POST /v1/message_jobs response. */
interface MessageJobResponse {
  id?: number;
  job_id?: number;
  status?: string;
  total_recipients?: number;
  /** Fallback deep-link to the job in the admin app — only present once api-v1 ships it (handoff 2026-06-15). */
  __view__admin_url?: string | null;
  admin_url?: string | null;
}

/** Defensive view of the POST /v1/message_jobs/{id}/approve response. */
interface MessageJobApproveResponse {
  job_id?: number;
  status?: string;
}

export async function runCommitMessage(
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
  const { token, confirm_large_send } = parsed.data;

  const lookup = getPlan(token);
  if (!lookup.ok) {
    return errorResult(
      "This message plan is no longer valid (tokens are single-use and expire after 15 minutes — " +
        `this one is ${lookup.reason}). Call comms_prepare_message again and re-confirm the new plan ` +
        "with the operator before committing.",
    );
  }
  const plan = lookup.plan;

  if (plan.recipient_count === 0) {
    return errorResult(
      "Refusing to send: this plan resolved to 0 recipients. Call comms_prepare_message with refined " +
        "audience filters and confirm a non-empty plan with the operator.",
    );
  }

  // SECOND-PHASE PATH: the job was already created on a previous call and is
  // sitting in pending_approval. We only ever reach an approve call here, never
  // a second create — so a large send cannot be duplicated.
  if (plan.created_job_id !== undefined) {
    if (!confirm_large_send) {
      // Re-surface the gate instead of doing anything. Idempotent.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "pending_approval",
                requires_second_confirmation: true,
                job_id: plan.created_job_id,
                recipient_count: plan.recipient_count,
                audience: plan.audience_echo,
                next_step:
                  `Nothing sent yet — this send (${plan.recipient_count} recipients) is above the company's ` +
                  "approval threshold. Show the operator the recipient count and get an EXPLICIT second " +
                  "confirmation, then call comms_commit_message again with the same token and " +
                  "confirm_large_send: true to release it.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    return approvePendingJob(token, plan.created_job_id, plan, auth);
  }

  // FIRST-PHASE PATH: create the job.
  const body: Record<string, unknown> = {
    type: plan.channel,
    subject: plan.subject,
    message: plan.body,
    params: {
      ...plan.audience_params,
      marketing_messages: plan.marketing ? 1 : 0,
      guests: plan.guests ? 1 : 0,
      email_rejected: 0,
    },
  };
  if (plan.template_type) body.template = plan.template_type;
  if (plan.bcc) body.bcc = plan.bcc;
  if (plan.schedule_at) {
    body.date = plan.schedule_at.date;
    body.hour = String(plan.schedule_at.hour).padStart(2, "0");
    body.minute = String(plan.schedule_at.minute).padStart(2, "0");
  }

  try {
    const raw = await zoozaFetch<MessageJobResponse>(
      "/message_jobs",
      { method: "POST", body },
      withCompany(auth, plan.company_id),
    );

    const jobId = raw?.id ?? raw?.job_id ?? null;
    const status = raw?.status ?? "queued";
    const recipientCount = raw?.total_recipients ?? plan.recipient_count;
    const approvalUrl = raw?.__view__admin_url ?? raw?.admin_url ?? null;

    // Over the company's approval threshold: the job exists but is parked. Do
    // NOT burn the token and do NOT approve — record the job and bounce back for
    // the operator's explicit second confirmation.
    if (status === "pending_approval") {
      if (jobId !== null) recordPlanJob(token, jobId);
      const result = {
        status: "pending_approval",
        requires_second_confirmation: true,
        job_id: jobId,
        recipient_count: recipientCount,
        audience: plan.audience_echo,
        scheduled_for: plan.schedule_at ?? null,
        ...(approvalUrl ? { approval_url: approvalUrl } : {}),
        next_step:
          `Nothing has been sent yet. This audience (${recipientCount} recipients) is above the company's ` +
          "approval threshold. Show the operator the exact recipient count and ask them to explicitly confirm " +
          "sending to all of them. ONLY after an explicit yes, call comms_commit_message again with the SAME " +
          "token and confirm_large_send: true to release the send — no app step needed. If the operator declines, " +
          "send nothing" +
          (approvalUrl ? `; they can also approve it later in the app: ${approvalUrl}.` : "."),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // Under threshold — sent (or queued) outright. Burn the token.
    markPlanUsed(token);
    const result = {
      job_id: jobId,
      status,
      recipient_count: recipientCount,
      approval_required: false,
      audience: plan.audience_echo,
      scheduled_for: plan.schedule_at ?? null,
      note: "Job accepted. Track progress in Zooza admin → Messages.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    // Token is NOT burned on failure — one retry with the same token is safe
    // because the job was not created.
    if (error instanceof ZoozaApiError) {
      if (error.humanMessage.includes("invalid_account_status")) {
        return errorResult(
          `Could not create the message job (api-v1 ${error.status}: invalid_account_status). This company's ` +
            "account cannot send bulk messages — the operator should check their plan/account status in Zooza " +
            "admin. The send was NOT executed.",
        );
      }
      return errorResult(
        `Could not create the message job (api-v1 ${error.status}: ${error.humanMessage}). The send was NOT ` +
          "executed. You may retry comms_commit_message once with the same token; if it fails again, call " +
          "comms_prepare_message and start over.",
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Releases an already-created pending_approval job from inside the conversation,
 * after the operator's explicit second confirmation. Approval is company-scoped
 * by the plan's frozen company id — commit args can never redirect it.
 */
async function approvePendingJob(
  token: string,
  jobId: number,
  plan: { recipient_count: number; audience_echo: Record<string, unknown>; company_id: number; schedule_at?: unknown },
  auth: ZoozaAuth,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  try {
    const raw = await zoozaFetch<MessageJobApproveResponse>(
      `/message_jobs/${jobId}/approve`,
      { method: "POST", body: {} },
      withCompany(auth, plan.company_id),
    );
    // Success — burn the token so the plan can't be re-sent or re-approved.
    markPlanUsed(token);
    const result = {
      job_id: raw?.job_id ?? jobId,
      status: raw?.status ?? "approved",
      recipient_count: plan.recipient_count,
      approval_required: false,
      released_via: "in_conversation_approval",
      audience: plan.audience_echo,
      scheduled_for: plan.schedule_at ?? null,
      note: "Approved and released from the conversation — no app step needed. Track progress in Zooza admin → Messages.",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof ZoozaApiError) {
      // Already past pending (e.g. approved by a parallel action or in the app).
      // Treat as resolved so the operator isn't told to retry forever.
      if (error.humanMessage.includes("not pending approval")) {
        markPlanUsed(token);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  job_id: jobId,
                  status: "already_released",
                  note: "This job is no longer pending approval — it was already approved or cancelled (here or " +
                    "in the Zooza admin). Nothing more to do. Check Zooza admin → Messages for its status.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Transport/other failure — token NOT burned; the same token can retry the
      // approval of the same job (no duplicate, the job already exists).
      return errorResult(
        `Could not approve the message job (api-v1 ${error.status}: ${error.humanMessage}). The send was NOT ` +
          `released. Job ${jobId} is still pending approval — you may retry comms_commit_message once with the ` +
          "same token and confirm_large_send: true, or the operator can approve it in Zooza admin → Messages.",
      );
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
