import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  AuthChallengeError,
  buildResourceMetadata,
  resolveAuthContext,
} from "./auth/middleware.js";
import { hasScope, type Scope, SCOPE_READ, SCOPE_WRITE } from "./auth/scopes.js";
import type { RequestAuthContext } from "./auth/types.js";
import { config } from "./config.js";
import { buildSkillInstructions, loadAllSkills } from "./skills.js";
import { TERMINOLOGY_INSTRUCTIONS, TERMINOLOGY_INDEX } from "./terminology/index.js";
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
  findCoursesDescription,
  findCoursesInputSchema,
  findCoursesTitle,
  runFindCourses,
} from "./tools/find-courses.js";
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

const SKILLS = loadAllSkills();
const SKILL_INSTRUCTIONS = buildSkillInstructions(SKILLS);

const COMBINED_INSTRUCTIONS = [TERMINOLOGY_INSTRUCTIONS, SKILL_INSTRUCTIONS]
  .filter(Boolean)
  .join("\n\n---\n\n");

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
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
    { name: "zooza-mcp", version: "0.1.0" },
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
      annotations: { readOnlyHint: true },
    },
    scopeGuard(SCOPE_READ, ctx, async (args) => runGetTerminology(args)),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "explain_data_model",
    {
      title: explainDataModelTitle,
      description: explainDataModelDescription,
      inputSchema: explainDataModelInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(SCOPE_READ, ctx, async (args) => runExplainDataModel(args)),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "list_message_merge_vars",
    {
      title: listMessageMergeVarsTitle,
      description: listMessageMergeVarsDescription,
      inputSchema: listMessageMergeVarsInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(SCOPE_READ, ctx, async (args) => runListMessageMergeVars(args)),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "list_schedule_patterns",
    {
      title: listSchedulePatternsTitle,
      description: listSchedulePatternsDescription,
      inputSchema: listSchedulePatternsInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(SCOPE_READ, ctx, async (args) => runListSchedulePatterns(args)),
  );

  // Free tool — no Zooza API call, no company_id needed
  server.registerTool(
    "negotiate_terminology",
    {
      title: negotiateTerminologyTitle,
      description: negotiateTerminologyDescription,
      inputSchema: negotiateTerminologyInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(SCOPE_READ, ctx, async (args) => runNegotiateTerminology(args)),
  );

  server.registerTool(
    "whoami",
    {
      title: whoamiTitle,
      description: whoamiDescription,
      inputSchema: whoamiInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard<Record<string, never>>(SCOPE_READ, ctx, async () => runWhoami(ctx)),
  );

  server.registerTool(
    "find_courses",
    {
      title: findCoursesTitle,
      description: findCoursesDescription,
      inputSchema: findCoursesInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runFindCourses(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "find_billing_periods",
    {
      title: findBillingPeriodsTitle,
      description: findBillingPeriodsDescription,
      inputSchema: findBillingPeriodsInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runFindBillingPeriods(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "find_trainers",
    {
      title: findTrainersTitle,
      description: findTrainersDescription,
      inputSchema: findTrainersInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runFindTrainers(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "find_places",
    {
      title: findPlacesTitle,
      description: findPlacesDescription,
      inputSchema: findPlacesInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runFindPlaces(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "preview_schedule",
    {
      title: previewScheduleTitle,
      description: previewScheduleDescription,
      inputSchema: previewScheduleInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runPreviewSchedule(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "preview_events",
    {
      title: previewEventsTitle,
      description: previewEventsDescription,
      inputSchema: previewEventsInputSchema,
      annotations: { readOnlyHint: true },
    },
    scopeGuard(
      SCOPE_READ,
      ctx,
      resolveCompanyId(ctx, async (args) => runPreviewEvents(args, ctx.auth)),
    ),
  );

  server.registerTool(
    "commit_class",
    {
      title: commitClassTitle,
      description: commitClassDescription,
      inputSchema: commitClassInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    scopeGuard(
      SCOPE_WRITE,
      ctx,
      resolveCompanyId(ctx, async (args) => runCommitClass(args, ctx.auth)),
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
    scopeGuard(SCOPE_WRITE, ctx, async (args) => runSubmitFeedback(args, ctx)),
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
      annotations: { readOnlyHint: true },
    },
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

  // "Show my programmes" — lists all programmes via find_courses, no filters.
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

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(buildResourceMetadata());
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

  app.all("/mcp", async (req, res) => {
    let ctx: RequestAuthContext;
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
    console.log(
      `zooza-mcp listening on :${config.port} (Zooza API: ${config.zooza.baseUrl}; auth: ${authMode})`,
    );
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
