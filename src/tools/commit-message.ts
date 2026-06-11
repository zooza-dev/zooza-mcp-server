import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { getPlan, markPlanUsed } from "./message-plan-store.js";

export const commitMessageTitle = "Send a previously planned message";

export const commitMessageDescription =
  "Executes a message plan previously created by comms_prepare_message. Only call this after the operator has " +
  "seen the plan (recipient count, content) and EXPLICITLY confirmed sending. Takes only the `token` — the " +
  "audience and content are frozen in the plan and cannot be changed here; to change anything, call " +
  "comms_prepare_message again. Returns the created message job id and status. Jobs above the company's approval " +
  "threshold additionally require approval in the Zooza admin — the result says so when that applies.";

export const commitMessageInputSchema = {
  token: z
    .string()
    .describe("Single-use token from comms_prepare_message; expires after 15 minutes."),
};

const inputSchema = z.object(commitMessageInputSchema);

/** Defensive view of the POST /v1/message_jobs response. */
interface MessageJobResponse {
  id?: number;
  job_id?: number;
  status?: string;
  total_recipients?: number;
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

  const lookup = getPlan(parsed.data.token);
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
    // Success — burn the token so the same plan can't be sent twice.
    markPlanUsed(parsed.data.token);

    const status = raw?.status ?? "queued";
    const approvalRequired = status === "pending_approval";
    const result = {
      job_id: raw?.id ?? raw?.job_id ?? null,
      status,
      recipient_count: raw?.total_recipients ?? plan.recipient_count,
      approval_required: approvalRequired,
      audience: plan.audience_echo,
      scheduled_for: plan.schedule_at ?? null,
      note: approvalRequired
        ? "Job created but exceeds the company's approval threshold — the operator must approve it in " +
          "Zooza admin → Messages before anything is sent."
        : "Job accepted. Track progress in Zooza admin → Messages.",
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

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
