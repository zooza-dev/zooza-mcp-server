import { describe, expect, it } from "vitest";
import { projectTemplates, type RawEmailTemplate } from "./list-message-templates.js";
import {
  buildAudienceParams,
  extractMergeTags,
  findUnknownTags,
  hasTargeting,
} from "./prepare-message.js";

describe("hasTargeting", () => {
  it("accepts any single targeting field", () => {
    expect(hasTargeting({ course_id: 1 })).toBe(true);
    expect(hasTargeting({ labels: [3] })).toBe(true);
  });

  it("rejects empty audiences and modifier-only audiences", () => {
    expect(hasTargeting({})).toBe(false);
    expect(hasTargeting({ guests: true, inactive_customers: true })).toBe(false);
    expect(hasTargeting({ labels: [] })).toBe(false);
    expect(hasTargeting({ exclude: [5] })).toBe(false);
  });
});

describe("buildAudienceParams", () => {
  it("maps ids straight through and pipe-joins arrays", () => {
    expect(
      buildAudienceParams({
        course_id: 211,
        labels: [1, 2],
        exclude: [9, 10],
        inactive_customers: true,
        guests: true, // not a query param — handled via message_jobs params at commit
      }),
    ).toEqual({
      course_id: 211,
      labels: "1|2",
      exclude: "9|10",
      inactive_customers: 1,
    });
  });

  it("omits absent fields entirely", () => {
    expect(buildAudienceParams({ schedule_id: 482 })).toEqual({ schedule_id: 482 });
  });
});

describe("merge tag validation", () => {
  it("extracts unique tag names from subject+body text", () => {
    expect(
      extractMergeTags("Hi *|FIRST_NAME|*, course *|COURSE_NAME|* — bye *|FIRST_NAME|*"),
    ).toEqual(["FIRST_NAME", "COURSE_NAME"]);
  });

  it("flags unknown tags and suggests the contained valid name", () => {
    const unknown = findUnknownTags(["CLIENT_FIRST_NAME", "FIRST_NAME"]);
    expect(unknown).toEqual([
      { tag: "*|CLIENT_FIRST_NAME|*", suggestion: "*|FIRST_NAME|*" },
    ]);
  });

  it("flags unknown tags without suggestion when nothing matches", () => {
    const unknown = findUnknownTags(["TOTALLY_BOGUS_XYZ"]);
    expect(unknown).toEqual([{ tag: "*|TOTALLY_BOGUS_XYZ|*" }]);
  });
});

describe("projectTemplates", () => {
  const RECORDS: RawEmailTemplate[] = [
    {
      id: 1,
      company_id: 7,
      type: "registration_cancellation",
      name: null,
      hour: null,
      subject: "Cancelled",
      body: "<p>cancelled</p>",
      is_default: true,
    },
    {
      id: 55,
      company_id: 7,
      type: "retention_notification",
      name: "Our retention mail",
      hour: null,
      subject: "Stay with us",
      body: "<p>custom</p>",
      is_default: false,
    },
  ];

  it("strips body unless asked and never leaks id/company_id", () => {
    const { templates } = projectTemplates(RECORDS, {});
    expect(templates[0]).toEqual({
      type: "registration_cancellation",
      name: null,
      subject: "Cancelled",
      is_default: true,
      hour: null,
    });
    expect(templates[0]).not.toHaveProperty("id");
    expect(templates[0]).not.toHaveProperty("body");
  });

  it("filters by source and includes body on request", () => {
    const { templates } = projectTemplates(RECORDS, { source: "customized", includeBody: true });
    expect(templates).toHaveLength(1);
    expect(templates[0].type).toBe("retention_notification");
    expect(templates[0].body).toBe("<p>custom</p>");
  });

  it("derives valid types from the live records (never hardcoded)", () => {
    const { validTypes } = projectTemplates(RECORDS, { type: "nope" });
    expect(validTypes).toEqual(["registration_cancellation", "retention_notification"]);
  });
});
