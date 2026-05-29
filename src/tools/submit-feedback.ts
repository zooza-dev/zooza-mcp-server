import { z } from "zod";
import type { RequestAuthContext } from "../auth/types.js";
import { config } from "../config.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";

export const submitFeedbackTitle = "Submit feedback to engineering";

export const submitFeedbackDescription = `Submit user feedback about the Zooza MCP integration to the engineering team. Two paths:

- 'path: "github"' — returns a prefilled issue-creation URL on the **public** \`zooza-dev/zooza-mcp-server\` repo. The user opens it in their browser and files the issue themselves (no MCP-side auth). The body MUST be fully anonymized (no user_id, company_id, company name, user email/name, course/class/event names, customer/client identifiers). The server runs a safety-net regex and will reject the call if obvious identifiers (long numbers, emails) remain.
- 'path: "internal"' — files an issue on the user's behalf in the **private** \`zooza-dev/zooza-mcp\` repo, recording their authenticated user_id and company_id so engineering can follow up. Use this for users who don't have GitHub or prefer the private channel.

ALWAYS show the user the exact 'title' and 'body' and get explicit affirmative confirmation before calling — once invoked with 'path: "internal"', the issue is filed and cannot be undone from this tool. The 'feedback-nudge' skill (load via \`get_skill name=feedback-nudge\`) describes when to proactively offer this tool and how to anonymize properly.`;

export const submitFeedbackInputSchema = {
  path: z
    .enum(["github", "internal"])
    .describe(
      "Which feedback channel to use. Decided by asking the user 'do you have a GitHub account?' — yes → 'github' (returns a URL they open themselves), no → 'internal' (server files the issue on their behalf). NEVER surface the 'github'/'internal' labels or the words 'public'/'private' to the user — those are implementation detail. Use 'I have GitHub' / 'I don't have GitHub' as the user-facing option labels.",
    ),
  title: z
    .string()
    .min(1)
    .describe(
      "Short, search-friendly issue title (one line). Becomes the GitHub issue title verbatim.",
    ),
  body: z
    .string()
    .min(1)
    .describe(
      "Full feedback in markdown. For path='github' MUST be pre-anonymized — strip user_id, company_id, company name, user email/name, course/class/event names, customer/client info. For path='internal' the user/company context is added automatically by the server.",
    ),
  category: z
    .enum(["bug", "feature_request", "praise", "other"])
    .optional()
    .describe(
      "Optional. Drives GitHub labels. Pick the closest match — when in doubt use 'other'.",
    ),
  related_tool: z
    .string()
    .optional()
    .describe(
      "Optional. Snake-case name of the MCP tool the feedback is about (e.g. 'create_class', 'find_courses'). For path='internal' it's embedded in the issue header; for path='github' it's omitted from the URL (mildly fingerprinting).",
    ),
};

const inputSchema = z.object(submitFeedbackInputSchema);

const BODY_CAP = 60_000;
const PUBLIC_REPO = "zooza-dev/zooza-mcp-server";
const INTERNAL_REPO = "zooza-dev/zooza-mcp";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export async function runSubmitFeedback(
  rawInput: unknown,
  ctx: RequestAuthContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(
      `Missing or invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}.`,
    );
  }
  const input = parsed.data;

  if (input.body.length > BODY_CAP) {
    return errorResult(
      `body is too long (${input.body.length} chars, max ${BODY_CAP}). Ask the user to shorten or split the report into multiple issues.`,
    );
  }

  const labels = ["feedback", ...(input.category ? [input.category] : [])];

  if (input.path === "github") {
    const hits = anonymizationHits(input.body);
    if (hits.length > 0) {
      return errorResult(
        `Refusing to build a public URL — body still contains identifying patterns: ${hits.join("; ")}. Anonymize and retry, or switch to path: "internal" if the user prefers the private flow.`,
      );
    }
    const url = buildGithubUrl(input.title, input.body, labels);
    await recordFeedbackEvent("github", input.category, ctx);
    return ok({
      path: "github",
      url,
      preview: { title: input.title, body: input.body },
    });
  }

  // path === "internal"
  const token = config.feedback.githubToken;
  if (!token) {
    return errorResult(
      `Server is missing the internal feedback token. Tell the user the internal-feedback path is temporarily unavailable and offer path: "github" as a workaround.`,
    );
  }

  const userId = extractUserId(ctx);
  const companyId = extractCompanyId(ctx);
  const enrichedBody = buildEnrichedBody(
    input.body,
    userId,
    companyId,
    input.related_tool,
  );

  let created: { number: number; html_url: string };
  try {
    created = await postInternalIssue(input.title, enrichedBody, labels, token);
  } catch (error) {
    if (error instanceof GithubIssuesError) {
      if (error.status === 401 || error.status === 403) {
        return errorResult(
          `Internal feedback channel authentication failed. The engineering team has been notified — for now, offer path: "github" as a workaround.`,
        );
      }
      return errorResult(
        `GitHub Issues API is currently unavailable (status ${error.status}). Suggest the user retries in a few minutes, or use path: "github" to open the prefilled URL themselves.`,
      );
    }
    return errorResult(
      `Failed to reach GitHub Issues API: ${error instanceof Error ? error.message : String(error)}. Suggest the user retries in a few minutes, or use path: "github" to open the prefilled URL themselves.`,
    );
  }

  const submittedAt = new Date().toISOString();
  await recordFeedbackEvent("internal", input.category, ctx);

  return ok({
    path: "internal",
    issue_number: created.number,
    issue_url: created.html_url,
    recorded: {
      user_id: userId,
      company_id: companyId,
      submitted_at: submittedAt,
    },
  });
}

// ─── Anonymization safety net ─────────────────────────────────────────────────
// This is a backstop — the feedback-nudge skill is the primary defense. The
// regex catches obvious leakage; it does NOT rewrite, only rejects.

function anonymizationHits(body: string): string[] {
  const hits: string[] = [];
  const numericMatches = body.match(/\b\d{4,}\b/g);
  if (numericMatches && numericMatches.length > 0) {
    const sample = numericMatches.slice(0, 3).join(", ");
    const more = numericMatches.length > 3 ? `, +${numericMatches.length - 3} more` : "";
    hits.push(`numeric identifiers (${sample}${more})`);
  }
  const emailMatches = body.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  );
  if (emailMatches && emailMatches.length > 0) {
    const sample = emailMatches.slice(0, 2).join(", ");
    const more = emailMatches.length > 2 ? `, +${emailMatches.length - 2} more` : "";
    hits.push(`email addresses (${sample}${more})`);
  }
  return hits;
}

// ─── URL + HTTP helpers ───────────────────────────────────────────────────────

function buildGithubUrl(title: string, body: string, labels: string[]): string {
  const params = new URLSearchParams();
  params.set("title", title);
  params.set("body", body);
  params.set("labels", labels.join(","));
  return `https://github.com/${PUBLIC_REPO}/issues/new?${params.toString()}`;
}

class GithubIssuesError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(`GitHub Issues API ${status}: ${responseText.slice(0, 200)}`);
    this.name = "GithubIssuesError";
  }
}

async function postInternalIssue(
  title: string,
  body: string,
  labels: string[],
  token: string,
): Promise<{ number: number; html_url: string }> {
  const response = await fetch(
    `https://api.github.com/repos/${INTERNAL_REPO}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "zooza-mcp/feedback",
      },
      body: JSON.stringify({ title, body, labels }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new GithubIssuesError(response.status, text);
  }
  const parsed = JSON.parse(text) as { number?: unknown; html_url?: unknown };
  const number =
    typeof parsed.number === "number" ? parsed.number : Number(parsed.number);
  const htmlUrl =
    typeof parsed.html_url === "string" ? parsed.html_url : String(parsed.html_url);
  if (!Number.isFinite(number) || htmlUrl.length === 0) {
    throw new GithubIssuesError(
      200,
      `Unexpected response shape: ${text.slice(0, 200)}`,
    );
  }
  return { number, html_url: htmlUrl };
}

// ─── api-v1 event recording (best effort) ─────────────────────────────────────

async function recordFeedbackEvent(
  path: "github" | "internal",
  category: string | undefined,
  ctx: RequestAuthContext,
): Promise<void> {
  try {
    await zoozaFetch(
      "/user/mcp_feedback_events",
      {
        method: "POST",
        body: { path, ...(category ? { category } : {}) },
      },
      ctx.auth,
    );
  } catch (error) {
    const message =
      error instanceof ZoozaApiError
        ? error.humanMessage
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(
      `[submit_feedback] failed to record event in api-v1 (path=${path}): ${message}`,
    );
  }
}

// ─── Context extraction ───────────────────────────────────────────────────────

function extractUserId(ctx: RequestAuthContext): number | null {
  const sub = ctx.session?.sub ?? ctx.claims?.sub;
  if (!sub) return null;
  const n = Number.parseInt(String(sub), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractCompanyId(ctx: RequestAuthContext): number | null {
  const n = Number.parseInt(ctx.auth.company, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildEnrichedBody(
  body: string,
  userId: number | null,
  companyId: number | null,
  relatedTool: string | undefined,
): string {
  const lines: string[] = [
    "## Submitted via MCP",
    "",
    `- **user_id:** ${userId ?? "(unknown)"}`,
    `- **company_id:** ${companyId ?? "(unknown)"}`,
  ];
  if (relatedTool) {
    lines.push(`- **related_tool:** \`${relatedTool}\``);
  }
  lines.push("", "---", "", body);
  return lines.join("\n");
}

// ─── Result helpers ───────────────────────────────────────────────────────────

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
