import { describe, expect, test } from "bun:test";
import {
  extractFrontmatterFieldValue,
  inferResolverForField,
  resolvePlainFieldValue
} from "./field-value";
import { type JiraCreateField, type JiraField } from "./types";

describe("inferResolverForField", () => {
  test("detects common Jira system and option-array field shapes", () => {
    const fields: JiraField[] = [
      {
        id: "priority",
        name: "Priority",
        schema: { system: "priority", type: "priority" }
      },
      {
        id: "components",
        name: "Components",
        schema: { items: "component", system: "components", type: "array" }
      },
      {
        id: "fixVersions",
        name: "Fix versions",
        schema: { items: "version", system: "fixVersions", type: "array" }
      },
      {
        id: "customfield_10020",
        name: "Audience",
        schema: { items: "option", type: "array" }
      }
    ];

    expect(inferResolverForField(fields[0] as JiraField, {})).toBe("priorityByName");
    expect(inferResolverForField(fields[1] as JiraField, {})).toBe("componentArrayByName");
    expect(inferResolverForField(fields[2] as JiraField, {})).toBe("versionArrayByName");
    expect(inferResolverForField(fields[3] as JiraField, {})).toBe("optionArrayByName");
  });
});

describe("resolvePlainFieldValue", () => {
  test("resolves metadata-backed options and common Jira arrays by name", () => {
    const priorityField: JiraCreateField = {
      allowedValues: [
        { id: "1", name: "Highest" },
        { id: "2", name: "High" }
      ],
      fieldId: "priority",
      name: "Priority",
      required: false
    };
    const componentField: JiraCreateField = {
      allowedValues: [
        { id: "10", name: "API" },
        { id: "11", name: "UI" }
      ],
      fieldId: "components",
      name: "Components",
      required: false
    };
    const optionField: JiraCreateField = {
      allowedValues: [
        { id: "100", value: "Customer" },
        { id: "101", value: "Internal" }
      ],
      fieldId: "customfield_10010",
      name: "Audience",
      required: false
    };

    expect(
      resolvePlainFieldValue({
        fieldMetadata: priorityField,
        resolver: "priorityByName",
        sourceKey: "priority",
        value: "High"
      })
    ).toEqual({ id: "2" });
    expect(
      resolvePlainFieldValue({
        fieldMetadata: componentField,
        resolver: "componentArrayByName",
        sourceKey: "components",
        value: ["API", "UI"]
      })
    ).toEqual([{ id: "10" }, { id: "11" }]);
    expect(
      resolvePlainFieldValue({
        fieldMetadata: optionField,
        resolver: "optionArrayByName",
        sourceKey: "audience",
        value: ["Customer", "Internal"]
      })
    ).toEqual([{ id: "100" }, { id: "101" }]);
    expect(
      resolvePlainFieldValue({
        fieldMetadata: {
          allowedValues: [{ id: "20", name: "2026.03" }],
          fieldId: "fixVersions",
          name: "Fix versions",
          required: false
        },
        resolver: "versionArrayByName",
        sourceKey: "fixVersions",
        value: [2026.03]
      })
    ).toEqual([{ id: "20" }]);
  });

  test("falls back to legacy value payloads for single options without allowedValues", () => {
    expect(
      resolvePlainFieldValue({
        resolver: "optionByName",
        sourceKey: "audience",
        value: "Customer"
      })
    ).toEqual({ value: "Customer" });
  });

  test("falls back to a name payload for priority when Jira omits allowedValues", () => {
    expect(
      resolvePlainFieldValue({
        resolver: "priorityByName",
        sourceKey: "priority",
        value: "High"
      })
    ).toEqual({ name: "High" });
  });

  test("throws when metadata-backed array resolvers do not expose allowed values", () => {
    expect(() =>
      resolvePlainFieldValue({
        resolver: "componentArrayByName",
        sourceKey: "components",
        value: ["API"]
      })
    ).toThrow(/Use raw "fields:"/);
  });
});

describe("extractFrontmatterFieldValue", () => {
  test("extracts pull-time values for supported resolver kinds", () => {
    expect(
      extractFrontmatterFieldValue({
        resolver: "priorityByName",
        value: { id: "2", name: "High" }
      })
    ).toBe("High");
    expect(
      extractFrontmatterFieldValue({
        resolver: "componentArrayByName",
        value: [
          { id: "10", name: "API" },
          { id: "11", name: "UI" }
        ]
      })
    ).toEqual(["API", "UI"]);
    expect(
      extractFrontmatterFieldValue({
        resolver: "versionArrayByName",
        value: [{ id: "20", name: "2026.03" }]
      })
    ).toEqual(["2026.03"]);
    expect(
      extractFrontmatterFieldValue({
        resolver: "optionByName",
        value: { id: "100", value: "Customer" }
      })
    ).toBe("Customer");
  });
});
