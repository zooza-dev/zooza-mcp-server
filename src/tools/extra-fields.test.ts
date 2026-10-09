import { describe, expect, it } from "vitest";
import { buildExtraFieldDefs, projectExtraFields } from "./extra-fields.js";

// Shapes copied from api-test GET /courses (2026-10-09) plus the prod variants of
// field_options (null, "null", []) the research found.
const defs = buildExtraFieldDefs([
  {
    id: 1002,
    extra_fields: [
      {
        column_name: "extra_field_1",
        custom_label: "How did you hear about us?",
        name: "How did you hear about us?",
        field_options: {
          type: "choice",
          items: [
            { key: "A", value: "Instagram" },
            { key: "B", value: "A friend" },
            { key: "B", value: "Duplicate key — ignored" },
          ],
        },
      },
      { column_name: "extra_field_2", custom_label: "Allergies", field_options: { type: "text", items: [] } },
      { column_name: "extra_field_3", custom_label: "", name: "Extra Field 3", field_options: "null" },
      { column_name: "extra_field_4", custom_label: null, name: "Diet", field_options: [] },
      { column_name: "full_name", custom_label: "Child's name", field_options: null },
    ],
  },
]);

describe("projectExtraFields", () => {
  it("returns only filled slots, labelled per course, with choice keys mapped to their text", () => {
    const row = {
      ef_extra_field_1: "B",
      ef_extra_field_2: "  peanuts ",
      ef_extra_field_3: "",
      ef_extra_field_4: null,
      ef_full_name: "Ema",
    };
    expect(projectExtraFields(row, 1002, defs)).toEqual([
      { field: "extra_field_1", label: "How did you hear about us?", value: "A friend" },
      { field: "extra_field_2", label: "Allergies", value: "peanuts" },
    ]);
  });

  it("falls back to name when custom_label is empty and keeps an unknown choice key as-is", () => {
    const row = { ef_extra_field_1: "Z", ef_extra_field_3: "x", ef_extra_field_4: 5 };
    expect(projectExtraFields(row, 1002, defs)).toEqual([
      { field: "extra_field_1", label: "How did you hear about us?", value: "Z" },
      { field: "extra_field_3", label: "Extra Field 3", value: "x" },
      { field: "extra_field_4", label: "Diet", value: "5" },
    ]);
  });

  it("labels by column when the course has no definitions", () => {
    expect(projectExtraFields({ ef_extra_field_7: "yes" }, 999, defs)).toEqual([
      { field: "extra_field_7", label: "extra_field_7", value: "yes" },
    ]);
  });

  it("ignores non-extra_field columns in definitions", () => {
    expect(defs.get(1002)?.has("full_name")).toBe(false);
  });
});
