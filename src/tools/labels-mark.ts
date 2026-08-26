import { z } from "zod";
import { withCompany } from "../auth/session-store.js";
import type { ZoozaAuth } from "../auth/types.js";
import { ZoozaApiError, zoozaFetch } from "../zooza.js";
import { companyIdSchema, unwrapList } from "./common.js";
import type { ApiListResponse } from "./types.js";

const OBJECT_TYPES = ["course", "schedule", "registration"] as const;

export const labelsMarkTitle = "Attach or detach a label on a course, schedule, or registration";

export const labelsMarkDescription =
  "Attach or detach a label (a named tag) on a Zooza course, schedule, or registration. Set `present: true` to " +
  "attach (the label is created automatically if it doesn't exist yet — attach is idempotent), `present: false` " +
  "to detach. Use it to tag records for grouping or pipeline state — e.g. mark a lead registration `converted`, or " +
  "flag one `todo`. Works ONLY on courses, schedules, and registrations. NOTE: labels on a SCHEDULE can be " +
  "customer-visible on the public booking widget (output flags this as `public_facing`); labels on courses and " +
  "registrations are internal. Does not send anything.";

export const labelsMarkInputSchema = {
  company_id: companyIdSchema,
  object_type: z
    .enum(OBJECT_TYPES)
    .describe("What kind of thing to tag: 'course', 'schedule', or 'registration'. Zooza labels attach only to these three."),
  object_id: z.number().int().positive().describe("Id of the course/schedule/registration to tag."),
  label: z.string().min(1).describe("Label name (the whole identity — labels have no colour). Created on first attach."),
  present: z.boolean().describe("true = attach the label, false = detach it."),
};

const inputSchema = z.object(labelsMarkInputSchema);

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: LabelMarkResult;
};

export interface LabelMarkResult {
  [key: string]: unknown;
  label: string;
  object_type: (typeof OBJECT_TYPES)[number];
  object_id: number;
  present: boolean;
  public_facing: boolean;
  changed: boolean;
}

interface RawLabelRelation {
  id?: number;
  object_type?: string;
  object_id?: number | string;
}
interface RawLabelRecord {
  id?: number;
  label?: string;
  relations?: RawLabelRelation[];
}

export async function runLabelsMark(rawInput: unknown, auth: ZoozaAuth): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    // Surface the supported-types teaching message for a bad object_type.
    if (path === "object_type") {
      return errorResult(
        "labels_mark supports object_type course, schedule or registration. Zooza labels attach only to those three.",
      );
    }
    return errorResult(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ")}.`,
    );
  }
  const input = parsed.data;
  const callAuth = withCompany(auth, input.company_id!);
  const publicFacing = input.object_type === "schedule";

  if (input.present) {
    // Attach — idempotent create-or-get on the name + attach the relation in one call.
    try {
      await zoozaFetch(
        "/labels",
        {
          method: "POST",
          body: { label: input.label, relations: [{ object_type: input.object_type, object_id: input.object_id }] },
        },
        callAuth,
      );
    } catch (error) {
      return upstreamError(error, "attach the label");
    }
    return ok({
      label: input.label,
      object_type: input.object_type,
      object_id: input.object_id,
      present: true,
      public_facing: publicFacing,
      changed: true,
    });
  }

  // Detach — resolve the relation id first, then delete it.
  let labels: RawLabelRecord[];
  try {
    const raw = await zoozaFetch<ApiListResponse<RawLabelRecord> | RawLabelRecord[]>(
      "/labels",
      {
        query: {
          label: input.label,
          object_type: input.object_type,
          object_id: input.object_id,
          load_relations: "true",
        },
      },
      callAuth,
    );
    labels = unwrapList<RawLabelRecord>(raw).records;
  } catch (error) {
    return upstreamError(error, "look up the label");
  }

  const match = findRelation(labels, input.label, input.object_type, input.object_id);
  if (!match) {
    // Not present (or the ~1-day Redis cache is behind). Idempotent no-op.
    return ok({
      label: input.label,
      object_type: input.object_type,
      object_id: input.object_id,
      present: false,
      public_facing: publicFacing,
      changed: false,
    });
  }

  try {
    await zoozaFetch(
      `/labels/${match.labelId}/relations/${match.relationId}`,
      { method: "DELETE" },
      callAuth,
    );
  } catch (error) {
    return upstreamError(error, "detach the label");
  }

  return ok({
    label: input.label,
    object_type: input.object_type,
    object_id: input.object_id,
    present: false,
    public_facing: publicFacing,
    changed: true,
  });
}

function findRelation(
  labels: RawLabelRecord[],
  name: string,
  objectType: string,
  objectId: number,
): { labelId: number; relationId: number } | undefined {
  const wanted = name.trim().toLowerCase();
  for (const l of labels) {
    if (l.id === undefined) continue;
    if ((l.label ?? "").trim().toLowerCase() !== wanted) continue;
    for (const r of l.relations ?? []) {
      if (r.id === undefined) continue;
      if (r.object_type !== objectType) continue;
      if (Number(r.object_id) !== objectId) continue;
      return { labelId: l.id, relationId: r.id };
    }
  }
  return undefined;
}

function ok(result: LabelMarkResult): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function upstreamError(error: unknown, action: string): ToolResult {
  if (error instanceof ZoozaApiError) {
    if (error.status === 404) {
      return errorResult(`Could not ${action}: the object was not found (api-v1 404: ${error.humanMessage}).`);
    }
    return errorResult(`Zooza did not confirm the label change while trying to ${action} (api-v1 ${error.status}: ${error.humanMessage}). State may be unchanged — safe to retry.`);
  }
  return errorResult(error instanceof Error ? error.message : String(error));
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
