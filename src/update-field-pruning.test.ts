import { describe, expect, test } from "./test-helpers.js";
import { pruneUnchangedUpdateFields } from "./update-field-pruning.js";

describe("pruneUnchangedUpdateFields", () => {
  test("removes unchanged summary, assignee, labels, parent, and description", () => {
    const fields: Record<string, unknown> = {
      assignee: { accountId: "557058:alice" },
      description: { type: "doc", version: 1 },
      labels: ["backend", "ops"],
      parent: { key: "ENG-42" },
      summary: "Keep existing value"
    };

    const removed = pruneUnchangedUpdateFields({
      fields,
      localDescriptionMarkdown: "Line one\n\nLine two",
      remoteAssigneeAccountId: "557058:alice",
      remoteDescriptionMarkdown: "Line one\r\n\r\nLine two",
      remoteLabels: ["ops", "backend"],
      remoteParentKey: "ENG-42",
      remoteSummary: "Keep existing value"
    });

    expect(removed).toEqual([
      "summary",
      "assignee",
      "parent",
      "labels",
      "description"
    ]);
    expect(fields).toEqual({});
  });

  test("keeps changed fields", () => {
    const fields: Record<string, unknown> = {
      assignee: { accountId: "557058:bob" },
      description: { type: "doc", version: 1 },
      summary: "Updated value"
    };

    const removed = pruneUnchangedUpdateFields({
      fields,
      localDescriptionMarkdown: "Updated body",
      remoteAssigneeAccountId: "557058:alice",
      remoteDescriptionMarkdown: "Original body",
      remoteSummary: "Original value"
    });

    expect(removed).toEqual([]);
    expect(fields).toEqual({
      assignee: { accountId: "557058:bob" },
      description: { type: "doc", version: 1 },
      summary: "Updated value"
    });
  });

  test("removes unchanged resolver-backed fields using normalized frontmatter values", () => {
    const fields: Record<string, unknown> = {
      components: [{ id: "10" }, { id: "11" }],
      priority: { name: "High" }
    };

    const removed = pruneUnchangedUpdateFields({
      comparableFields: [
        {
          fieldId: "priority",
          localValue: "High",
          remoteValue: "High"
        },
        {
          fieldId: "components",
          localValue: ["UI", "API"],
          remoteValue: ["API", "UI"]
        }
      ],
      fields
    });

    expect(removed).toEqual(["priority", "components"]);
    expect(fields).toEqual({});
  });
});
