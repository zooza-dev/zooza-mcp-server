import type { ZoozaAuth } from "./auth/types.js";

export type ZoozaRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

export class ZoozaApiError extends Error {
  /** Best-effort human-readable summary extracted from the response body. */
  public readonly humanMessage: string;

  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly responseText: string,
  ) {
    const human = extractHumanMessage(responseText);
    super(`Zooza API ${status} on ${path}: ${human ?? responseText.slice(0, 500)}`);
    this.name = "ZoozaApiError";
    this.humanMessage = human ?? responseText.slice(0, 500);
  }
}

/**
 * Pull human-readable error strings from an api-v1 4xx body.
 *
 * api-v1 always responds to validation failures with a structured object
 * containing `error_log_raw[].{key,val}` (preferred — already i18n-resolved
 * server side) and/or `errors[]` (legacy shape with numeric-string keys
 * mapping to either a string or a [key, message] tuple).
 */
function extractHumanMessage(text: string): string | null {
  if (text.length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const messages: string[] = [];

  const log = obj.error_log_raw;
  if (Array.isArray(log)) {
    for (const entry of log) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { key?: unknown; val?: unknown };
      if (typeof e.val === "string" && e.val.length > 0) {
        messages.push(e.val);
      } else if (typeof e.key === "string" && e.key.length > 0) {
        messages.push(e.key);
      }
    }
  }

  if (messages.length === 0 && Array.isArray(obj.errors)) {
    for (const entry of obj.errors) {
      if (typeof entry === "string") {
        messages.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      for (const value of Object.values(entry)) {
        if (typeof value === "string" && value.length > 0) {
          messages.push(value);
        } else if (Array.isArray(value)) {
          const tail = value[value.length - 1];
          const head = value[0];
          if (typeof tail === "string" && tail.length > 0) {
            messages.push(tail);
          } else if (typeof head === "string" && head.length > 0) {
            messages.push(head);
          }
        }
      }
    }
  }

  // Insert_Params validators (used by Schedule::create() etc.) stuff per-field
  // failures into `error_data.invalid_params` while emitting only the generic
  // "wrong_parameters_sent" through error_log_raw. Pull invalid_params in too
  // so MCP surfaces *which* field is wrong, not just "wrong parameters sent".
  const errorData = obj.error_data;
  if (errorData && typeof errorData === "object") {
    const ed = errorData as Record<string, unknown>;
    const invalidParams = ed.invalid_params;
    if (Array.isArray(invalidParams)) {
      for (const entry of invalidParams) {
        const fields = collectInvalidFieldNames(entry);
        if (fields.length > 0) {
          messages.push(`invalid fields: ${fields.join(", ")}`);
        }
      }
    }
  }

  if (messages.length === 0) return null;
  // Dedup while preserving order — api-v1 often emits the same val twice
  // (once via error_log_raw, once via errors[]).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out.join("; ");
}

function collectInvalidFieldNames(entry: unknown): string[] {
  if (!entry) return [];
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) {
    return entry.flatMap(collectInvalidFieldNames);
  }
  if (typeof entry === "object") {
    return Object.keys(entry as Record<string, unknown>);
  }
  return [];
}

function buildUrl(baseUrl: string, path: string, query?: ZoozaRequestOptions["query"]): string {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${trimmed}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildAuthHeaders(auth: ZoozaAuth): Record<string, string> {
  const base: Record<string, string> = {
    "X-ZOOZA-API-KEY": auth.apiKey,
    "X-ZOOZA-COMPANY": auth.company,
  };
  if (auth.mode === "jwt") {
    base.Authorization = `Bearer ${auth.bearer}`;
  } else {
    base["X-ZOOZA-TOKEN"] = auth.legacyToken;
  }
  return base;
}

export async function zoozaFetch<T = unknown>(
  path: string,
  options: ZoozaRequestOptions = {},
  auth: ZoozaAuth,
): Promise<T> {
  const url = buildUrl(auth.baseUrl, path, options.query);
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...buildAuthHeaders(auth),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ZoozaApiError(response.status, path, text);
  }

  if (text.length === 0) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ZoozaApiError(
      response.status,
      path,
      `Failed to parse JSON response: ${text.slice(0, 200)}`,
    );
  }
}
