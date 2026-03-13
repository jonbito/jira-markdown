import { type JiraCreateField } from "./types.js";

export interface BlockedUpdateField {
  fieldId: string;
  fieldName: string;
  reason: string;
}

export function collectBlockedUpdateFields(input: {
  editableFields: JiraCreateField[];
  fieldNamesById?: Map<string, string> | undefined;
  fields: Record<string, unknown>;
}): BlockedUpdateField[] {
  const editableFieldsById = new Map(
    input.editableFields.map((field) => [field.fieldId, field])
  );

  return Object.keys(input.fields)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((fieldId) => {
      const editableField = editableFieldsById.get(fieldId);
      const fieldName =
        editableField?.name ?? input.fieldNamesById?.get(fieldId) ?? fieldId;

      if (!editableField) {
        return [
          {
            fieldId,
            fieldName,
            reason: "not editable on this issue"
          }
        ];
      }

      if (
        Array.isArray(editableField.operations) &&
        editableField.operations.length > 0 &&
        !editableField.operations.includes("set")
      ) {
        return [
          {
            fieldId,
            fieldName,
            reason: `does not support set (allowed: ${editableField.operations.join(", ")})`
          }
        ];
      }

      return [];
    });
}
