import { describe, expect, test } from "./test-helpers.js";
import { collectBlockedUpdateFields } from "./update-field-validation.js";

describe("collectBlockedUpdateFields", () => {
  test("flags fields missing from edit metadata", () => {
    expect(
      collectBlockedUpdateFields({
        editableFields: [
          {
            fieldId: "summary",
            name: "Summary",
            required: true
          }
        ],
        fieldNamesById: new Map([["issuetype", "Issue Type"]]),
        fields: {
          issuetype: {
            name: "Epic"
          },
          summary: "Example"
        }
      })
    ).toEqual([
      {
        fieldId: "issuetype",
        fieldName: "Issue Type",
        reason: "not editable on this issue"
      }
    ]);
  });

  test("flags fields that do not support set operations", () => {
    expect(
      collectBlockedUpdateFields({
        editableFields: [
          {
            fieldId: "labels",
            name: "Labels",
            operations: ["add", "remove"],
            required: false
          }
        ],
        fields: {
          labels: ["docs"]
        }
      })
    ).toEqual([
      {
        fieldId: "labels",
        fieldName: "Labels",
        reason: "does not support set (allowed: add, remove)"
      }
    ]);
  });

  test("allows fields that support set operations", () => {
    expect(
      collectBlockedUpdateFields({
        editableFields: [
          {
            fieldId: "summary",
            name: "Summary",
            operations: ["set"],
            required: true
          }
        ],
        fields: {
          summary: "Example"
        }
      })
    ).toEqual([]);
  });
});
