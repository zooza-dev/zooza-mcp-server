import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Auto-discover every tool input schema: eagerly import all tool modules and
// collect their `*InputSchema` exports. This means a NEW tool is covered by the
// guard the moment its file lands — nothing to register, nothing to drift.
const modules = (
  import.meta as unknown as {
    glob: (
      pattern: string[],
      opts: { eager: boolean },
    ) => Record<string, Record<string, unknown>>;
  }
).glob(["./tools/*.ts", "!./tools/*.test.ts"], { eager: true });

/** Raw shape = the plain object passed to server.registerTool as inputSchema. */
type RawShape = Record<string, z.ZodTypeAny>;

const SCHEMAS: Record<string, RawShape> = {};
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith(".test.ts")) continue;
  const file = path.replace("./tools/", "").replace(/\.ts$/, "");
  for (const [name, value] of Object.entries(mod)) {
    if (!name.endsWith("InputSchema") || !value || typeof value !== "object") continue;
    SCHEMAS[`${file}:${name}`] = value as RawShape;
  }
}

// Zod def wrappers we peel off to find both the description (which may sit on any
// wrapper level, e.g. `.optional().describe()` vs `.describe().optional()`) and
// the core type we descend into.
type Def = { typeName?: string; description?: string; [k: string]: unknown };
function def(schema: z.ZodTypeAny): Def {
  return (schema as unknown as { _def: Def })._def;
}

/** Peel Optional/Nullable/Default/Readonly/Effects/Branded, recording whether a
 *  description was found anywhere in the chain; return the innermost core type. */
function unwrap(schema: z.ZodTypeAny): { described: boolean; core: z.ZodTypeAny } {
  let s = schema;
  let described = false;
  for (;;) {
    const d = def(s);
    if (d.description) described = true;
    switch (d.typeName) {
      case "ZodOptional":
      case "ZodNullable":
      case "ZodReadonly":
      case "ZodDefault":
        s = d.innerType as z.ZodTypeAny;
        break;
      case "ZodEffects":
        s = d.schema as z.ZodTypeAny;
        break;
      case "ZodBranded":
        s = d.type as z.ZodTypeAny;
        break;
      default:
        return { described, core: s };
    }
  }
}

/** A named field must carry a description; a literal (discriminator) is exempt —
 *  its value IS its meaning. After checking the field, descend into any nested
 *  named fields (object keys, array element fields, union branch fields). */
function checkField(schema: z.ZodTypeAny, path: string, missing: string[]): void {
  const { described, core } = unwrap(schema);
  if (!described && def(core).typeName !== "ZodLiteral") missing.push(path);
  descend(core, path, missing);
}

/** Reach the NEXT level of named fields through anonymous containers (array
 *  elements, union branches) without requiring the container itself described. */
function descend(core: z.ZodTypeAny, path: string, missing: string[]): void {
  const d = def(core);
  switch (d.typeName) {
    case "ZodObject": {
      const shape = (d.shape as () => RawShape)();
      for (const [k, child] of Object.entries(shape)) {
        checkField(child, `${path}.${k}`, missing);
      }
      break;
    }
    case "ZodArray":
      descend(unwrap(d.type as z.ZodTypeAny).core, `${path}[]`, missing);
      break;
    case "ZodDiscriminatedUnion":
    case "ZodUnion": {
      const options = d.options as z.ZodTypeAny[];
      options.forEach((opt) => descend(unwrap(opt).core, path, missing));
      break;
    }
    default:
      break;
  }
}

function undescribedFields(name: string, shape: RawShape): string[] {
  const missing: string[] = [];
  for (const [k, schema] of Object.entries(shape)) {
    // Defensive: a raw shape's values are Zod types; skip anything that isn't.
    if (!schema || typeof (schema as { _def?: unknown })._def === "undefined") continue;
    checkField(schema, `${name}.${k}`, missing);
  }
  return missing;
}

describe("tool input schemas — every parameter is described", () => {
  // A parameter with no .describe() forces the LLM to guess its meaning from the
  // field name. Zooza's model is complex and atypical, so that guess is often
  // wrong (a bare `registrations_cap` was misread as make-up capacity and
  // mis-set on 23 live classes — ZMCP-20260722-001). This test makes an
  // undescribed parameter a build failure, at every nesting level.
  it("discovers the tool schemas (sanity: glob resolved)", () => {
    expect(Object.keys(SCHEMAS).length).toBeGreaterThan(20);
  });

  for (const [name, shape] of Object.entries(SCHEMAS)) {
    it(`${name}: no undescribed fields`, () => {
      expect(undescribedFields(name, shape)).toEqual([]);
    });
  }
});

// ─── Schema size budget ───────────────────────────────────────────────────────
//
// The guard above makes a description MANDATORY. On its own that is a one-way
// ratchet: every new field must be described, nothing ever forces an old one to
// be trimmed. Input schemas are serialised into the system prompt of EVERY
// client conversation, used or not — so unchecked growth is a bill every
// operator pays on every message, including the ones on a EUR 20 plan.
//
// Measured 2026-08-26: describing 127 previously-undescribed parameters
// (ZMCP-20260722-001) grew the serialised schema surface from 49 020 to 63 784
// chars — +30 % in one commit.
//
// So the budget sits in the same file as the requirement: add a description,
// and if the tool is at its ceiling, shorten something else. Raising a ceiling
// is allowed — but it is a deliberate edit with a reason, not a silent drift.

const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

/** Serialised size of one tool's input schema — what actually ships on the wire. */
function schemaChars(shape: RawShape): number {
  return JSON.stringify(zodToJsonSchema(z.object(shape))).length;
}

/** Ceiling for a tool that has no entry in OVER_BUDGET. */
const PER_TOOL_SCHEMA_MAX = 4_500;

/** Ceiling for the whole registered surface. Headroom over today's 70 819 is
 *  deliberately thin: a new tool should have to earn its place. Raised 66 000 → 71 000
 *  on 2026-08-26 for the trial-inquiry tool wave (+5 tools: bookings_add_lead, labels_mark,
 *  comms_find_replies, todos_add, todos_mark — feature-trial-inquiry-tools; ZMCP-20260805
 *  token-audit baseline updated). */
const TOTAL_SCHEMA_MAX = 71_000;

/**
 * Tools already over PER_TOOL_SCHEMA_MAX when the budget landed. Each is held
 * at its measured size, so it can only SHRINK — never grow. Delete the entry
 * once the tool fits the normal ceiling. Trimming these is ZMCP-20260824-003.
 */
const OVER_BUDGET: Record<string, number> = {
  classes_update: 6_842,
  comms_send_message: 5_363,
  classes_commit_class: 5_111,
};

/** tool name → the `*InputSchema` export it registers with. Tools declaring an
 *  inline schema object (get_skill) carry no export to look up and are skipped;
 *  the registered-count assertion below keeps that from hiding a real gap. */
function registeredSchemaExports(): Array<[string, string]> {
  const re = /registerTool\(\s*"([a-z0-9_]+)",[\s\S]{0,600}?inputSchema:\s*([A-Za-z0-9_]+)\s*,/g;
  const found: Array<[string, string]> = [];
  for (let m = re.exec(indexSrc); m; m = re.exec(indexSrc)) found.push([m[1], m[2]]);
  return found;
}

/** Registered tools, resolved to the shape actually serialised for the client. */
const REGISTERED: Array<[string, RawShape]> = registeredSchemaExports().flatMap(
  ([tool, exportName]) => {
    for (const shape of Object.entries(SCHEMAS)) {
      if (shape[0].endsWith(`:${exportName}`)) return [[tool, shape[1]] as [string, RawShape]];
    }
    return [];
  },
);

describe("tool input schemas — size budget", () => {
  it("resolves the registered tools (sanity: index.ts parse still works)", () => {
    expect(REGISTERED.length).toBeGreaterThanOrEqual(25);
  });

  for (const [tool, shape] of REGISTERED) {
    const ceiling = OVER_BUDGET[tool] ?? PER_TOOL_SCHEMA_MAX;
    it(`${tool}: input schema <= ${ceiling} chars`, () => {
      expect(schemaChars(shape)).toBeLessThanOrEqual(ceiling);
    });
  }

  it(`all registered input schemas <= ${TOTAL_SCHEMA_MAX} chars`, () => {
    const total = REGISTERED.reduce((sum, [, shape]) => sum + schemaChars(shape), 0);
    expect(total).toBeLessThanOrEqual(TOTAL_SCHEMA_MAX);
  });
});
