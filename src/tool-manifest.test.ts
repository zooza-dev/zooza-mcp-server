import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, SERVER_VERSION, TOOL_COUNT, TOOL_NAMES } from "./tool-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "index.ts"), "utf8");

/** The tool names actually registered in index.ts. Every tool is registered via
 *  `server.registerTool("<name>", …)`, so the name is the first string literal
 *  after the call (the arg may sit on the next line — \s* spans the newline). */
function registeredToolNames(): string[] {
  const names = new Set<string>();
  const re = /server\.registerTool\(\s*"([a-z0-9_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexSrc)) !== null) names.add(m[1]);
  return [...names].sort();
}

describe("tool-manifest", () => {
  it("lists exactly the tools registered in index.ts (no drift)", () => {
    // If this fails: you added/removed/renamed a tool in index.ts but didn't
    // update TOOL_NAMES in tool-manifest.ts. Keep them in lockstep — the whoami
    // staleness canary depends on this list being the real surface.
    expect([...TOOL_NAMES].sort()).toEqual(registeredToolNames());
  });

  it("every CORE tool is a registered tool, and the dispatcher is core", () => {
    // A core name that isn't registered would be promised in tools/list and never
    // appear; the dispatcher must be listed or dispatcher-only tools are unreachable.
    for (const name of CORE_TOOL_NAMES) expect(TOOL_NAMES).toContain(name);
    expect(CORE_TOOL_NAMES).toContain("call_tool");
    expect(CORE_TOOL_NAMES).toContain("get_tool_schema");
  });

  it("TOOL_COUNT equals the list length", () => {
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
  });

  it("SERVER_VERSION is sourced from package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
