import { describe, expect, it } from "vitest";
import type { z } from "zod";

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
