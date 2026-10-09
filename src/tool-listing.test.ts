import { describe, expect, it } from "vitest";
import {
  bucketOf,
  DEFAULT_LISTING,
  dispatchOnlyToolNames,
  isListed,
  listedToolNames,
  parseToolsetsParam,
} from "./tool-listing.js";
import { CORE_TOOL_NAMES, TOOL_NAMES } from "./tool-manifest.js";

describe("tool listing", () => {
  it("lists exactly the core tools by default; the rest are dispatch-only", () => {
    expect(listedToolNames(DEFAULT_LISTING).sort()).toEqual([...CORE_TOOL_NAMES].sort());
    const both = [...listedToolNames(DEFAULT_LISTING), ...dispatchOnlyToolNames(DEFAULT_LISTING)].sort();
    expect(both).toEqual([...TOOL_NAMES].sort());
  });

  it("?toolsets=all lists every tool and leaves nothing dispatch-only", () => {
    const all = parseToolsetsParam("all");
    expect(listedToolNames(all).length).toBe(TOOL_NAMES.length);
    expect(dispatchOnlyToolNames(all)).toEqual([]);
  });

  it("?toolsets=todos,labels adds those buckets on top of core", () => {
    const l = parseToolsetsParam("todos, labels");
    expect(isListed("todos_add", l)).toBe(true);
    expect(isListed("labels_mark", l)).toBe(true);
    expect(isListed("whoami", l)).toBe(true);
    expect(isListed("setup_add_payment_template", l)).toBe(false);
  });

  it("ignores unknown or empty values", () => {
    expect(parseToolsetsParam("nonsense")).toEqual({ all: false, extraBuckets: new Set() });
    expect(parseToolsetsParam("")).toBe(DEFAULT_LISTING);
    expect(parseToolsetsParam(undefined)).toBe(DEFAULT_LISTING);
  });

  it("maps unprefixed tools to meta", () => {
    expect(bucketOf("whoami")).toBe("meta");
    expect(bucketOf("call_tool")).toBe("meta");
    expect(bucketOf("classes_update")).toBe("classes");
  });
});
