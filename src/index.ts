import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { audit } from "./audit.js";
import {
  AuthChallengeError,
  buildResourceMetadata,
  resolveAuthContext,
} from "./auth/middleware.js";
import { hasScope, type Scope, SCOPE_READ, SCOPE_WRITE } from "./auth/scopes.js";
import type { RequestAuthContext } from "./auth/types.js";
import { config } from "./config.js";
import { ZOOZA_ICON_PNG_BASE64 } from "./icon.js";
import { buildSkillInstructions, loadAllSkills } from "./skills.js";
import { TERMINOLOGY_INSTRUCTIONS, TERMINOLOGY_INDEX } from "./terminology/index.js";
import { ROUTING_INSTRUCTIONS } from "./instructions.js";
import {
  commitClassDescription,
  commitClassInputSchema,
  commitClassTitle,
  runCommitClass,
} from "./tools/commit-class.js";
import {
  findBillingPeriodsDescription,
  findBillingPeriodsInputSchema,
  findBillingPeriodsTitle,
  runFindBillingPeriods,
} from "./tools/find-billing-periods.js";
import {
  findClassesDescription,
  findClassesInputSchema,
  findClassesTitle,
  runFindClasses,
} from "./tools/find-classes.js";
import {
  findCoursesDescription,
  findCoursesInputSchema,
  findCoursesTitle,
  runFindCourses,
} from "./tools/find-courses.js";
import {
  findEventsDescription,
  findEventsInputSchema,
  findEventsTitle,
  runFindEvents,
} from "./tools/find-events.js";
import {
  getAttendanceDescription,
  getAttendanceInputSchema,
  getAttendanceTitle,
  runGetAttendance,
} from "./tools/get-attendance.js";
import {
  markAttendanceDescription,
  markAttendanceInputSchema,
  markAttendanceTitle,
  runMarkAttendance,
} from "./tools/mark-attendance.js";
import {
  addSessionSummaryDescription,
  addSessionSummaryInputSchema,
  addSessionSummaryTitle,
  runAddSessionSummary,
} from "./tools/add-session-summary.js";
import {
  findPlacesDescription,
  findPlacesInputSchema,
  findPlacesTitle,
  runFindPlaces,
} from "./tools/find-places.js";
import {
  findTrainersDescription,
  findTrainersInputSchema,
  findTrainersTitle,
  runFindTrainers,
} from "./tools/find-trainers.js";
import {
  previewEventsDescription,
  previewEventsInputSchema,
  previewEventsTitle,
  runPreviewEvents,
} from "./tools/preview-events-tool.js";
import {
  previewScheduleDescription,
  previewScheduleInputSchema,
  previewScheduleTitle,
  runPreviewSchedule,
} from "./tools/preview-schedule.js";
import {
  runWhoami,
  whoamiDescription,
  whoamiInputSchema,
  whoamiTitle,
} from "./tools/whoami.js";
import {
  getTerminologyDescription,
  getTerminologyInputSchema,
  getTerminologyTitle,
  runGetTerminology,
} from "./tools/get-terminology.js";
import {
  negotiateTerminologyDescription,
  negotiateTerminologyInputSchema,
  negotiateTerminologyTitle,
  runNegotiateTerminology,
} from "./tools/negotiate-terminology.js";
import {
  explainDataModelDescription,
  explainDataModelInputSchema,
  explainDataModelTitle,
  runExplainDataModel,
} from "./tools/explain-data-model.js";
import {
  listMessageMergeVarsDescription,
  listMessageMergeVarsInputSchema,
  listMessageMergeVarsTitle,
  runListMessageMergeVars,
} from "./tools/list-message-merge-vars.js";
import {
  listMessageTemplatesDescription,
  listMessageTemplatesInputSchema,
  listMessageTemplatesTitle,
  runListMessageTemplates,
} from "./tools/list-message-templates.js";
import {
  prepareMessageDescription,
  prepareMessageInputSchema,
  prepareMessageTitle,
  runPrepareMessage,
} from "./tools/prepare-message.js";
import {
  commitMessageDescription,
  commitMessageInputSchema,
  commitMessageTitle,
  runCommitMessage,
} from "./tools/commit-message.js";
import {
  listSchedulePatternsDescription,
  listSchedulePatternsInputSchema,
  listSchedulePatternsTitle,
  runListSchedulePatterns,
} from "./tools/list-schedule-patterns.js";
import {
  runSubmitFeedback,
  submitFeedbackDescription,
  submitFeedbackInputSchema,
  submitFeedbackTitle,
} from "./tools/submit-feedback.js";
import {
  getReportDataDescription,
  getReportDataInputSchema,
  getReportDataTitle,
  runGetReportData,
} from "./tools/get-report-data.js";
import { REPORTS_INSTRUCTIONS } from "./instructions.js";

const SKILLS = loadAllSkills();
const SKILL_INSTRUCTIONS = buildSkillInstructions(SKILLS);

const COMBINED_INSTRUCTIONS = [ROUTING_INSTRUCTIONS,TERMINOLOGY_INSTRUCTIONS, SKILL_INSTRUCTIONS, REPORTS_INSTRUCTIONS]
  .filter(Boolean)
  .join("\n\n---\n\n");

// Connector icon — Zooza "Z" mark (brand orange on white). PNG is the
// MUST-support icon format per the MCP spec; the SVG is a secondary entry for
// hosts that prefer vector.
const ZOOZA_ICON_PNG = Buffer.from(ZOOZA_ICON_PNG_BASE64, "base64");
const ZOOZA_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
  '<rect width="120" height="120" fill="#ffffff"/>' +
  '<g transform="translate(11,4) scale(0.85)"><path fill="#FA6900" d="M66.2,83.3l23.5-2.9v17.4l-65.9,17.9l40.8-68.4L31.4,43V17l60.1,16.6L66.2,83.3z"/></g>' +
  "</svg>";
// Public origin for the same-origin icon URL — the canonical form the Claude
// Connectors Directory (and faithful hosts) fetch. Derived from the configured
// resource URL: in prod MCP_RESOURCE_URL=https://mcp.zooza.app/mcp → origin
// https://mcp.zooza.app, so the icon is https://mcp.zooza.app/icon.png. Returns
// "" only if the URL can't be parsed (then we advertise only the data URI).
function iconOrigin(): string {
  try {
    return new URL(config.auth.resourceUrl).origin;
  } catch {
    return "";
  }
}
// Self-contained PNG data URI — a universal fallback advertised alongside the
// hosted URL so the logo still resolves when the origin isn't fetchable (local
// dev, sandboxed hosts). The /icon.png + /icon.svg HTTP routes back the URL form.
const ZOOZA_ICON_PNG_DATA_URI = `data:image/png;base64,${ZOOZA_ICON_PNG_BASE64}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  // Carried through the wrapper chain so a future wrapper that reconstructs the
  // result can't silently drop the App-card / chaining sidecar (sessions_find_events,
  // sessions_get_attendance). Wrappers must preserve it.
  structuredContent?: Record<string, unknown>;
};

function scopeGuard<Args>(
  required: Scope,
  ctx: RequestAuthContext,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args) => {
    if (!hasScope(ctx.claims, required)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `insufficient_scope: this tool requires the "${required}" scope. Ask the user to re-authenticate with the appropriate scope.`,
          },
        ],
      };
    }
    return handler(args);
  };
}

/**
 * Fills in `company_id` from the session when the caller omits it (single-
 * company case) or returns a directive error listing the options when the
 * user has access to multiple companies. Wraps tool handlers BEFORE their
 * zod parse step — by the time the handler runs, `args.company_id` is set.
 */
function resolveCompanyId<Args extends Record<string, unknown>>(
  ctx: RequestAuthContext,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args) => {
    const incoming = (args ?? ({} as Args)) as Args & { company_id?: number };
    if (incoming.company_id !== undefined && incoming.company_id !== null) {
      return handler(incoming);
    }
    if (ctx.session.companies.length === 1) {
      return handler({
        ...incoming,
        company_id: ctx.session.companies[0].id,
      } as Args);
    }
    if (ctx.session.companies.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "No companies available in this session. Call `whoami` first to populate the company list, then pass `company_id` explicitly.",
          },
        ],
      };
    }
    const options = ctx.session.companies
      .map((c) => `${c.id} (${c.name})`)
      .join(", ");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `company_id is required — this user has access to multiple companies. Ask the user which one to use, then pass that id explicitly. Options: ${options}.`,
        },
      ],
    };
  };
}

function createMcpServer(ctx: RequestAuthContext): McpServer {
  const server = new McpServer(
    {
      name: "zooza-mcp",
      version: "0.1.0",
      title: "Zooza",
      // Directory-submission canonical: same-origin HTTPS PNG first (256×256,
      // the MUST-support format), then the self-contained data URI as fallback.
      // SVG is intentionally omitted — it's SHOULD-only and several hosts reject
      // it; the /icon.svg route stays for hosts that ask for it by URL.
      icons: [
        ...(iconOrigin()
          ? [{ src: iconOrigin() + "/icon.png", mimeType: "image/png", sizes: ["256x256"] }]
          : []),
        { src: ZOOZA_ICON_PNG_DATA_URI, mimeType: "image/png", sizes: ["256x256"] },
      ],
    },
    COMBINED_INSTRUCTIONS ? { instructions: COMBINED_INSTRUCTIONS } : undefined,
  );

  // MCP Resource — full structured glossary (market-first: no other major MCP server exposes this)
  server.registerResource(
    "Zooza Glossary",
    "domain://zooza/glossary",
    {
      description:
        "Full domain terminology — canonical terms, translations, intent keywords, and " +
        "disambiguation rules for all Zooza concepts across 9 languages. " +
        "Read once per session and cache; the condensed version is already in server instructions.",
      mimeType: "application/json",
    },
    async (_uri) => ({
      contents: [
        {
          uri: "domain://zooza/glossary",
          mimeType: "application/json",
          text: JSON.stringify(TERMINOLOGY_INDEX, null, 2),
        },
      ],
    }),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "get_terminology",
    {
      title: getTerminologyTitle,
      description: getTerminologyDescription,
      inputSchema: getTerminologyInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("get_terminology", ctx, scopeGuard(SCOPE_READ, ctx, async (args) => runGetTerminology(args))),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "explain_data_model",
    {
      title: explainDataModelTitle,
      description: explainDataModelDescription,
      inputSchema: explainDataModelInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("explain_data_model", ctx, scopeGuard(SCOPE_READ, ctx, async (args) => runExplainDataModel(args))),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "comms_list_merge_vars",
    {
      title: listMessageMergeVarsTitle,
      description: listMessageMergeVarsDescription,
      inputSchema: listMessageMergeVarsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("comms_list_merge_vars", ctx, scopeGuard(SCOPE_READ, ctx, async (args) => runListMessageMergeVars(args))),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "classes_list_schedule_patterns",
    {
      title: listSchedulePatternsTitle,
      description: listSchedulePatternsDescription,
      inputSchema: listSchedulePatternsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("classes_list_schedule_patterns", ctx, scopeGuard(SCOPE_READ, ctx, async (args) => runListSchedulePatterns(args))),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "negotiate_terminology",
    {
      title: negotiateTerminologyTitle,
      description: negotiateTerminologyDescription,
      inputSchema: negotiateTerminologyInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("negotiate_terminology", ctx, scopeGuard(SCOPE_READ, ctx, async (args) => runNegotiateTerminology(args))),
  );

  server.registerTool(
    "whoami",
    {
      title: whoamiTitle,
      description: whoamiDescription,
      inputSchema: whoamiInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit("whoami", ctx, scopeGuard<Record<string, never>>(SCOPE_READ, ctx, async () => runWhoami(ctx))),
  );

  server.registerTool(
    "classes_find_courses",
    {
      title: findCoursesTitle,
      description: findCoursesDescription,
      inputSchema: findCoursesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_find_courses",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindCourses(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_find_classes",
    {
      title: findClassesTitle,
      description: findClassesDescription,
      inputSchema: findClassesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_find_classes",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindClasses(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_find_billing_periods",
    {
      title: findBillingPeriodsTitle,
      description: findBillingPeriodsDescription,
      inputSchema: findBillingPeriodsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_find_billing_periods",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindBillingPeriods(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "trainers_find",
    {
      title: findTrainersTitle,
      description: findTrainersDescription,
      inputSchema: findTrainersInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "trainers_find",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindTrainers(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_find_places",
    {
      title: findPlacesTitle,
      description: findPlacesDescription,
      inputSchema: findPlacesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_find_places",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindPlaces(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "sessions_find_events",
    {
      title: findEventsTitle,
      description: findEventsDescription,
      inputSchema: findEventsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "sessions_find_events",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runFindEvents(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "sessions_get_attendance",
    {
      title: getAttendanceTitle,
      description: getAttendanceDescription,
      inputSchema: getAttendanceInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "sessions_get_attendance",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runGetAttendance(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "sessions_mark_attendance",
    {
      title: markAttendanceTitle,
      description: markAttendanceDescription,
      inputSchema: markAttendanceInputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    audit(
      "sessions_mark_attendance",
      ctx,
      scopeGuard(
        SCOPE_WRITE,
        ctx,
        resolveCompanyId(ctx, async (args) => runMarkAttendance(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "sessions_add_summary",
    {
      title: addSessionSummaryTitle,
      description: addSessionSummaryDescription,
      inputSchema: addSessionSummaryInputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    audit(
      "sessions_add_summary",
      ctx,
      scopeGuard(
        SCOPE_WRITE,
        ctx,
        resolveCompanyId(ctx, async (args) => runAddSessionSummary(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_preview_schedule",
    {
      title: previewScheduleTitle,
      description: previewScheduleDescription,
      inputSchema: previewScheduleInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_preview_schedule",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runPreviewSchedule(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_preview_events",
    {
      title: previewEventsTitle,
      description: previewEventsDescription,
      inputSchema: previewEventsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "classes_preview_events",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runPreviewEvents(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "classes_commit_class",
    {
      title: commitClassTitle,
      description: commitClassDescription,
      inputSchema: commitClassInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    },
    audit(
      "classes_commit_class",
      ctx,
      scopeGuard(
        SCOPE_WRITE,
        ctx,
        resolveCompanyId(ctx, async (args) => runCommitClass(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "comms_list_templates",
    {
      title: listMessageTemplatesTitle,
      description: listMessageTemplatesDescription,
      inputSchema: listMessageTemplatesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "comms_list_templates",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runListMessageTemplates(args, ctx.auth)),
      ),
    ),
  );

  server.registerTool(
    "comms_prepare_message",
    {
      title: prepareMessageTitle,
      description: prepareMessageDescription,
      inputSchema: prepareMessageInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "comms_prepare_message",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runPrepareMessage(args, ctx.auth)),
      ),
    ),
  );

  // No resolveCompanyId — the company is frozen inside the plan the token
  // points at; commit-time args must not be able to redirect it.
  server.registerTool(
    "comms_commit_message",
    {
      title: commitMessageTitle,
      description: commitMessageDescription,
      inputSchema: commitMessageInputSchema,
      annotations: {
        readOnlyHint: false,
        // Sends real email to real clients — reaches outside the Zooza stack.
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    audit(
      "comms_commit_message",
      ctx,
      scopeGuard(SCOPE_WRITE, ctx, async (args) => runCommitMessage(args, ctx.auth)),
    ),
  );

  // Per-user feedback channel. No company_id — feedback is about the MCP
  // integration itself, not a particular company. See ZMCP-20260527-001 and
  // the feedback-nudge skill for when to offer this proactively.
  server.registerTool(
    "submit_feedback",
    {
      title: submitFeedbackTitle,
      description: submitFeedbackDescription,
      inputSchema: submitFeedbackInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    audit("submit_feedback", ctx, scopeGuard(SCOPE_WRITE, ctx, async (args) => runSubmitFeedback(args, ctx))),
  );

  // Real report data for LLM-composed client reports (ZMCP-20260612-003). The anti-
  // fabrication anchor — numbers shown to clients come from here, never the model.
  // (Dropped by the main merge; restored.)
  server.registerTool(
    "reports_get_data",
    {
      title: getReportDataTitle,
      description: getReportDataDescription,
      inputSchema: getReportDataInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "reports_get_data",
      ctx,
      scopeGuard(
        SCOPE_READ,
        ctx,
        resolveCompanyId(ctx, async (args) => runGetReportData(args, ctx)),
      ),
    ),
  );

  const skillNames = SKILLS.map((s) => s.name);
  const skillNameList = skillNames.length > 0 ? skillNames.join(", ") : "(none)";

  server.registerTool(
    "get_skill",
    {
      title: "Load a skill playbook",
      description: `Returns the full markdown playbook for one of the registered skills. Call this BEFORE starting a flow named in the server's instructions — the playbook contains the interview steps, mapping rules, and confirmation pattern for that scenario. Available skills: ${skillNameList}.`,
      inputSchema: {
        name: z.string().describe("Exact skill name from the available list."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    audit(
      "get_skill",
      ctx,
      scopeGuard<{ name: string }>(SCOPE_READ, ctx, async ({ name }) => {
        const skill = SKILLS.find((s) => s.name === name);
        if (!skill) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown skill "${name}". Available: ${skillNameList}.`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: skill.body }],
        };
      }),
    ),
  );

  // Skill-based prompts — one per skill file, title from frontmatter.
  for (const skill of SKILLS) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.title,
        description: skill.description,
      },
      async () => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: skill.body },
          },
        ],
      }),
    );
  }

  // --- Standalone open-conversation prompts ---

  // "Show my programmes" — lists all programmes via classes_find_courses, no filters.
  server.registerPrompt(
    "show-programmes",
    {
      title: "Show my programmes",
      description: "List all your Zooza programmes and courses with their key details.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Show me all the programmes and courses I offer in Zooza. List them with their name, target audience, and number of active classes. Use my terminology if you know it from previous sessions.",
          },
        },
      ],
    }),
  );

  // "Who am I & what can you do?" — whoami + dynamic skill list.
  // Auto-updates as new skills are added — no manual maintenance needed.
  server.registerPrompt(
    "whoami-capabilities",
    {
      title: "Who am I & what can you do?",
      description: "See which Zooza account you're connected to and what this assistant can help you with.",
    },
    async () => {
      const skillList = SKILLS.map((s) => `- **${s.title}**: ${s.description}`).join("\n");
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Tell me who I am in Zooza — which company or account I'm connected to.",
                "Then briefly explain what you can help me with. Here are your available guided flows:",
                "",
                skillList,
                "",
                "Keep it concise. Use my language and terminology if you know it.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  return server;
}

function sendChallenge(res: express.Response, err: AuthChallengeError): void {
  if (res.headersSent) return;
  res.set("WWW-Authenticate", err.wwwAuthenticate);
  res.status(err.status).json({
    jsonrpc: "2.0",
    error: { code: err.status === 401 ? -32001 : -32003, message: err.message },
    id: null,
  });
}

async function main(): Promise<void> {
  const app = express();

  // CORS — ChatGPT (Apps SDK) and other browser-based hosts issue a preflight
  // against /mcp and fetch the discovery/icon routes cross-origin. MCP auth is
  // a Bearer header (no cookies), so reflecting the origin with `*` is safe.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    );
    res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    res.set("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "4mb" }));

  // Request log — useful for diagnosing OAuth-discovery / connector flows.
  app.use((req, _res, next) => {
    const ua = req.header("user-agent") ?? "";
    const auth = req.header("authorization") ? "Bearer ***" : "(none)";
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} auth=${auth} ua="${ua.slice(0, 80)}"`,
    );
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "zooza-mcp" });
  });

  // Connector icon — served unauthenticated so hosts can fetch the brand avatar
  // (referenced from serverInfo.icons). PNG is primary (/icon.png, /favicon.ico);
  // SVG offered at /icon.svg for hosts that prefer it.
  app.get(["/icon.png", "/favicon.ico"], (_req, res) => {
    res.type("image/png").set("Cache-Control", "public, max-age=3600").send(ZOOZA_ICON_PNG);
  });
  app.get("/icon.svg", (_req, res) => {
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(ZOOZA_ICON_SVG);
  });

  // OpenAI ChatGPT App domain verification — place token in OPENAI_DOMAIN_CHALLENGE_TOKEN env var.
  // Required for ChatGPT MCP app submission (platform.openai.com/apps).
  // URL: https://mcp.zooza.app/.well-known/openai-apps-challenge
  if (config.openaiDomainChallengeToken) {
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
      res.type("text/plain").send(config.openaiDomainChallengeToken);
    });
  }

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(buildResourceMetadata());
  });

  // OpenAI Apps domain-verification challenge. One-time static check-in — the
  // token is issued per-domain by the OpenAI Apps console and proves we control
  // mcp.zooza.app. Not secret and not an env var: it only echoes a value OpenAI
  // already generated for us. Safe to remove once the domain shows verified.
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res.type("text/plain").send("6M9DLBUnonwxKpzFOYio6ULHGsi4GOMPPbSQdvQteHI");
  });

  // Fallback discovery path — some OAuth clients try this on the resource
  // server before / alongside `oauth-protected-resource`. Mirror the auth
  // server's own document verbatim so clients get a valid OAuth 2.0
  // authorization-server metadata response no matter which URL they probe.
  app.get(
    ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"],
    async (_req, res) => {
      try {
        const upstream = new URL(
          "/.well-known/oauth-authorization-server",
          config.auth.authServerUrl.endsWith("/")
            ? config.auth.authServerUrl
            : config.auth.authServerUrl + "/",
        );
        const r = await fetch(upstream.toString());
        const body = await r.text();
        res.status(r.status).type(r.headers.get("content-type") ?? "application/json").send(body);
      } catch (err) {
        res.status(502).json({
          error: "upstream_unreachable",
          error_description: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // Guest context for unauthenticated discovery requests (initialize, tools/list).
  // Tool handlers are never invoked during discovery — the MCP SDK only reads
  // the registered tool metadata. hasScope(null, ...) returns true (legacy bypass)
  // so scopeGuard doesn't block, but no actual Zooza API calls are made.
  const GUEST_CTX: RequestAuthContext = {
    mode: "legacy",
    auth: { mode: "legacy", apiKey: "", company: "", legacyToken: "", baseUrl: "" },
    session: { sub: "guest", companies: [] },
    claims: null,
  };

  // Methods that are safe to serve without a JWT — they only return server
  // metadata and the tool catalogue, never any Zooza account data.
  const DISCOVERY_METHODS = new Set(["initialize", "tools/list"]);

  app.all("/mcp", async (req, res) => {
    const isDiscovery = DISCOVERY_METHODS.has(req.body?.method);

    let ctx: RequestAuthContext;
    if (isDiscovery) {
      ctx = GUEST_CTX;
    } else {
      try {
        ctx = await resolveAuthContext(req);
      } catch (error) {
        if (error instanceof AuthChallengeError) {
          sendChallenge(res, error);
          return;
        }
        console.error("MCP auth resolution failed:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Auth resolution failed" },
            id: null,
          });
        }
        return;
      }
    }

    try {
      const server = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.listen(config.port, () => {
    const authMode = config.auth.allowHardcoded ? "dev-fallback enabled" : "JWT required";
    const regions = Object.keys(config.zooza.regionBaseUrls);
    const regionInfo = regions.length > 0 ? regions.join(", ") : "NONE";
    console.log(
      `zooza-mcp listening on :${config.port} (Zooza API regions: ${regionInfo}; auth: ${authMode})`,
    );
    if (regions.length === 0) {
      console.warn(
        "[config] No ZOOZA_API_BASE_<REGION> env vars set — every request will be rejected for lack of a regional api-v1 base URL.",
      );
    }
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
