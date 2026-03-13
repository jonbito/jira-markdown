import { extractSprintFrontmatterValue } from "./sprint-field";
import {
  type FieldMappingConfig,
  type FieldResolverKind,
  type JiraCreateField,
  type JiraField,
  type JsonValue
} from "./types";

function normalizeLookupKey(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asJsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, JsonValue>;
}

function coerceNumber(value: unknown, sourceKey: string): number {
  const numericValue = asFiniteNumber(value);
  if (numericValue !== undefined) {
    return numericValue;
  }

  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }

  throw new Error(`Frontmatter key "${sourceKey}" must be numeric.`);
}

function coerceIdentifierString(value: unknown, sourceKey: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`Frontmatter key "${sourceKey}" must be a non-empty string or number.`);
}

function coerceString(value: unknown, sourceKey: string): string {
  const stringValue = asString(value);
  if (stringValue) {
    return stringValue;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`Frontmatter key "${sourceKey}" must be a non-empty string.`);
}

function coerceStringArray(value: unknown, sourceKey: string): string[] {
  if (Array.isArray(value)) {
    const strings = value
      .map((entry) => {
        if (typeof entry === "string" && entry.trim()) {
          return entry.trim();
        }

        if (typeof entry === "number" && Number.isFinite(entry)) {
          return String(entry);
        }

        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    if (strings.length > 0) {
      return strings;
    }
  }

  const singleValue = asString(value);
  if (singleValue) {
    return [singleValue];
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }

  throw new Error(`Frontmatter key "${sourceKey}" must be a string or string array.`);
}

function collectAllowedValueLabels(
  allowedValue: Record<string, JsonValue>,
  keys: string[]
): string[] {
  const labels: string[] = [];

  for (const key of keys) {
    const rawValue = allowedValue[key];
    if (typeof rawValue === "string" && rawValue.trim()) {
      labels.push(rawValue.trim());
    }
  }

  return labels;
}

function findAllowedValueByLabel(input: {
  allowedValues: JsonValue[] | undefined;
  label: string;
  labelKeys: string[];
}): Record<string, JsonValue> | undefined {
  const normalizedLabel = normalizeLookupKey(input.label);

  for (const entry of input.allowedValues ?? []) {
    const record = asJsonRecord(entry);
    if (!record) {
      continue;
    }

    const labels = collectAllowedValueLabels(record, input.labelKeys);
    if (labels.some((candidate) => normalizeLookupKey(candidate) === normalizedLabel)) {
      return record;
    }
  }

  return undefined;
}

function describeAllowedValues(
  allowedValues: JsonValue[] | undefined,
  labelKeys: string[]
): string | undefined {
  const labels = [...new Set(
    (allowedValues ?? [])
      .map((entry) => {
        const record = asJsonRecord(entry);
        if (!record) {
          return undefined;
        }

        return collectAllowedValueLabels(record, labelKeys)[0];
      })
      .filter((entry): entry is string => Boolean(entry))
  )];

  if (labels.length === 0) {
    return undefined;
  }

  return labels.slice(0, 10).join(", ");
}

function buildMissingAllowedValueError(input: {
  fieldMetadata?: JiraCreateField | undefined;
  label: string;
  labelKeys: string[];
  sourceKey: string;
}): Error {
  const fieldName = input.fieldMetadata?.name ?? input.sourceKey;
  const availableValues = describeAllowedValues(input.fieldMetadata?.allowedValues, input.labelKeys);

  return new Error(
    `Frontmatter key "${input.sourceKey}" could not resolve "${input.label}" against Jira field "${fieldName}"${availableValues ? `. Available values: ${availableValues}.` : "."}`
  );
}

function buildMissingMetadataError(input: {
  fieldMetadata?: JiraCreateField | undefined;
  sourceKey: string;
}): Error {
  const fieldName = input.fieldMetadata?.name ?? input.sourceKey;
  return new Error(
    `Frontmatter key "${input.sourceKey}" needs Jira field metadata for "${fieldName}" but Jira did not expose allowed values for this operation. Use raw "fields:" for this field.`
  );
}

function buildIdPayload(
  matched: Record<string, JsonValue>,
  fallbackNameKey: "name" | "value"
): Record<string, string> {
  const rawId = matched.id;
  if (typeof rawId === "string" && rawId.trim()) {
    return { id: rawId.trim() };
  }

  if (typeof rawId === "number" && Number.isFinite(rawId)) {
    return { id: String(rawId) };
  }

  const rawLabel = matched[fallbackNameKey];
  if (typeof rawLabel === "string" && rawLabel.trim()) {
    return { [fallbackNameKey]: rawLabel.trim() };
  }

  if (fallbackNameKey !== "name") {
    const rawName = matched.name;
    if (typeof rawName === "string" && rawName.trim()) {
      return { name: rawName.trim() };
    }
  }

  if (fallbackNameKey !== "value") {
    const rawValue = matched.value;
    if (typeof rawValue === "string" && rawValue.trim()) {
      return { value: rawValue.trim() };
    }
  }

  return {};
}

function extractObjectString(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  for (const key of keys) {
    const rawValue = record[key];
    if (typeof rawValue === "string" && rawValue.trim()) {
      return rawValue.trim();
    }
  }

  return undefined;
}

function extractObjectStringArray(value: unknown, keys: string[]): string[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  const strings = values
    .map((entry) => extractObjectString(entry, keys))
    .filter((entry): entry is string => Boolean(entry));

  return strings.length > 0 ? strings : undefined;
}

function extractObjectId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  const rawId = record.id;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId.trim();
  }

  if (typeof rawId === "number" && Number.isFinite(rawId)) {
    return String(rawId);
  }

  return undefined;
}

export function inferResolverForField(
  field: JiraField | JiraCreateField,
  options: { boardId?: number }
): NonNullable<FieldMappingConfig["resolver"]> {
  const fieldId = "id" in field ? field.id : field.fieldId;

  if (field.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint") {
    return options.boardId ? "sprintByName" : "sprintById";
  }

  if (field.schema?.type === "number") {
    return "number";
  }

  if (field.schema?.type === "user") {
    return "userByAccountId";
  }

  if (fieldId === "priority" || field.schema?.system === "priority") {
    return "priorityByName";
  }

  if (
    fieldId === "components" ||
    field.schema?.system === "components" ||
    field.schema?.items === "component"
  ) {
    return "componentArrayByName";
  }

  if (
    fieldId === "versions" ||
    fieldId === "fixVersions" ||
    field.schema?.system === "versions" ||
    field.schema?.system === "fixVersions" ||
    field.schema?.items === "version"
  ) {
    return "versionArrayByName";
  }

  if (field.schema?.type === "array" && field.schema?.items === "string") {
    return "stringArray";
  }

  if (field.schema?.type === "array" && field.schema?.items === "option") {
    return "optionArrayByName";
  }

  if (field.schema?.type === "option") {
    return "optionByName";
  }

  return "passthrough";
}

export function resolvePlainFieldValue(input: {
  fieldMetadata?: JiraCreateField | undefined;
  resolver: FieldResolverKind;
  sourceKey: string;
  value: unknown;
}): unknown {
  switch (input.resolver) {
    case "string":
      return coerceString(input.value, input.sourceKey);
    case "number":
      return coerceNumber(input.value, input.sourceKey);
    case "stringArray":
      return coerceStringArray(input.value, input.sourceKey);
    case "optionById":
      return { id: coerceIdentifierString(input.value, input.sourceKey) };
    case "optionByName": {
      const optionValue = coerceString(input.value, input.sourceKey);
      if (!input.fieldMetadata?.allowedValues?.length) {
        return { value: optionValue };
      }

      const matched = findAllowedValueByLabel({
        allowedValues: input.fieldMetadata.allowedValues,
        label: optionValue,
        labelKeys: ["value", "name"]
      });
      if (!matched) {
        throw buildMissingAllowedValueError({
          fieldMetadata: input.fieldMetadata,
          label: optionValue,
          labelKeys: ["value", "name"],
          sourceKey: input.sourceKey
        });
      }

      return buildIdPayload(matched, "value");
    }
    case "optionArrayByName": {
      if (!input.fieldMetadata?.allowedValues?.length) {
        throw buildMissingMetadataError(input);
      }

      return coerceStringArray(input.value, input.sourceKey).map((entry) => {
        const matched = findAllowedValueByLabel({
          allowedValues: input.fieldMetadata?.allowedValues,
          label: entry,
          labelKeys: ["value", "name"]
        });
        if (!matched) {
          throw buildMissingAllowedValueError({
            fieldMetadata: input.fieldMetadata,
            label: entry,
            labelKeys: ["value", "name"],
            sourceKey: input.sourceKey
          });
        }

        return buildIdPayload(matched, "value");
      });
    }
    case "componentArrayByName": {
      if (!input.fieldMetadata?.allowedValues?.length) {
        throw buildMissingMetadataError(input);
      }

      return coerceStringArray(input.value, input.sourceKey).map((entry) => {
        const matched = findAllowedValueByLabel({
          allowedValues: input.fieldMetadata?.allowedValues,
          label: entry,
          labelKeys: ["name"]
        });
        if (!matched) {
          throw buildMissingAllowedValueError({
            fieldMetadata: input.fieldMetadata,
            label: entry,
            labelKeys: ["name"],
            sourceKey: input.sourceKey
          });
        }

        return buildIdPayload(matched, "name");
      });
    }
    case "versionArrayByName": {
      if (!input.fieldMetadata?.allowedValues?.length) {
        throw buildMissingMetadataError(input);
      }

      return coerceStringArray(input.value, input.sourceKey).map((entry) => {
        const matched = findAllowedValueByLabel({
          allowedValues: input.fieldMetadata?.allowedValues,
          label: entry,
          labelKeys: ["name"]
        });
        if (!matched) {
          throw buildMissingAllowedValueError({
            fieldMetadata: input.fieldMetadata,
            label: entry,
            labelKeys: ["name"],
            sourceKey: input.sourceKey
          });
        }

        return buildIdPayload(matched, "name");
      });
    }
    case "priorityByName": {
      const priorityName = coerceString(input.value, input.sourceKey);
      if (!input.fieldMetadata?.allowedValues?.length) {
        return { name: priorityName };
      }

      const matched = findAllowedValueByLabel({
        allowedValues: input.fieldMetadata.allowedValues,
        label: priorityName,
        labelKeys: ["name"]
      });
      if (!matched) {
        throw buildMissingAllowedValueError({
          fieldMetadata: input.fieldMetadata,
          label: priorityName,
          labelKeys: ["name"],
          sourceKey: input.sourceKey
        });
      }

      return buildIdPayload(matched, "name");
    }
    case "userByAccountId":
    case "sprintById":
    case "sprintByName":
    case "passthrough":
    default:
      return input.value;
  }
}

export function extractFrontmatterFieldValue(input: {
  resolver: FieldResolverKind | undefined;
  value: unknown;
}): unknown {
  switch (input.resolver) {
    case "string":
      return extractObjectString(input.value, ["value", "name"]) ?? asString(input.value);
    case "number": {
      const numericValue = asFiniteNumber(input.value);
      if (numericValue !== undefined) {
        return numericValue;
      }

      if (typeof input.value === "string" && input.value.trim() && !Number.isNaN(Number(input.value))) {
        return Number(input.value);
      }

      return undefined;
    }
    case "stringArray": {
      if (Array.isArray(input.value)) {
        const strings = input.value
          .map((entry) => asString(entry))
          .filter((entry): entry is string => Boolean(entry));
        return strings.length > 0 ? strings : undefined;
      }

      const singleValue = asString(input.value);
      return singleValue ? [singleValue] : undefined;
    }
    case "optionByName":
      return extractObjectString(input.value, ["value", "name"]);
    case "optionById":
      return extractObjectId(input.value);
    case "optionArrayByName":
      return extractObjectStringArray(input.value, ["value", "name"]);
    case "componentArrayByName":
      return extractObjectStringArray(input.value, ["name"]);
    case "versionArrayByName":
      return extractObjectStringArray(input.value, ["name"]);
    case "priorityByName":
      return extractObjectString(input.value, ["name"]);
    case "userByAccountId":
      return extractObjectId(input.value);
    case "sprintById":
    case "sprintByName":
      return extractSprintFrontmatterValue(input.value, input.resolver);
    case "passthrough":
    default:
      return undefined;
  }
}
