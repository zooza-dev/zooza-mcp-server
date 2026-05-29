import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { RequestAuthContext } from "./auth/types.js";
import { config } from "./config.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface AuditEntry {
  timestamp: string;
  request_id: string;
  tool: string;
  auth_mode: "jwt" | "legacy";
  sub: string;
  company_id: number | null;
  args: unknown;
  outcome: "ok" | "error";
  result: string | null;
  error: { message: string; stack?: string } | null;
  duration_ms: number;
}

const auditLogPath = isAbsolute(config.audit.logPath)
  ? config.audit.logPath
  : resolve(process.cwd(), config.audit.logPath);

let dirEnsured: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirEnsured) {
    dirEnsured = mkdir(dirname(auditLogPath), { recursive: true }).then(() => undefined);
  }
  return dirEnsured;
}

async function write(entry: AuditEntry): Promise<void> {
  let line: string;
  try {
    line = JSON.stringify(entry) + "\n";
  } catch (err) {
    line =
      JSON.stringify({
        timestamp: entry.timestamp,
        request_id: entry.request_id,
        tool: entry.tool,
        outcome: "error",
        error: {
          message: `audit_serialize_failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        duration_ms: entry.duration_ms,
      }) + "\n";
  }
  try {
    await ensureDir();
    await appendFile(auditLogPath, line, "utf8");
  } catch (err) {
    console.error(`[audit] failed to write entry for ${entry.tool}:`, err);
  }
}

function effectiveCompanyId(args: unknown, ctx: RequestAuthContext): number | null {
  const direct = (args as { company_id?: unknown } | undefined)?.company_id;
  if (typeof direct === "number") return direct;
  if (ctx.session.companies.length === 1) return ctx.session.companies[0].id;
  return null;
}

function joinContent(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractErrorFromResult(result: ToolResult): { message: string } {
  const text = joinContent(result);
  return { message: text.length > 0 ? text : "(empty error content)" };
}

/**
 * Wraps a tool handler so every invocation appends one JSONL entry to the
 * audit log. Place this OUTERMOST in the wrapper chain — outside scopeGuard
 * and resolveCompanyId — so scope denials and missing-company-id directives
 * are captured too.
 */
export function audit<Args>(
  toolName: string,
  ctx: RequestAuthContext,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args) => {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      const outcome: "ok" | "error" = result.isError ? "error" : "ok";
      await write({
        timestamp,
        request_id: requestId,
        tool: toolName,
        auth_mode: ctx.mode,
        sub: ctx.session.sub,
        company_id: effectiveCompanyId(args, ctx),
        args,
        outcome,
        result: outcome === "ok" ? joinContent(result) : null,
        error: outcome === "error" ? extractErrorFromResult(result) : null,
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await write({
        timestamp,
        request_id: requestId,
        tool: toolName,
        auth_mode: ctx.mode,
        sub: ctx.session.sub,
        company_id: effectiveCompanyId(args, ctx),
        args,
        outcome: "error",
        result: null,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        duration_ms: Date.now() - startedAt,
      });
      throw err;
    }
  };
}

export function auditLogLocation(): string {
  return auditLogPath;
}
