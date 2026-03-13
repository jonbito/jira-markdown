function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeComparableFieldValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeComparableFieldValue(entry))
      .filter((entry) => entry !== undefined);

    return normalized.every(
      (entry) =>
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        entry === null
    )
      ? [...normalized].sort((left, right) =>
          String(left).localeCompare(String(right))
        )
      : normalized;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, normalizeComparableFieldValue(entry)] as const)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }

  return undefined;
}

function comparableFieldValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparableFieldValue(left)) ===
    JSON.stringify(normalizeComparableFieldValue(right));
}

export function pruneUnchangedUpdateFields(input: {
  comparableFields?: Array<{
    fieldId: string;
    localValue: unknown;
    remoteValue: unknown;
  }> | undefined;
  fields: Record<string, unknown>;
  localDescriptionMarkdown?: string | undefined;
  remoteAssigneeAccountId?: string | undefined;
  remoteDescriptionMarkdown?: string | undefined;
  remoteLabels?: string[] | undefined;
  remoteParentKey?: string | undefined;
  remoteSummary?: string | undefined;
}): string[] {
  const removed: string[] = [];

  if (
    typeof input.fields.summary === "string" &&
    input.fields.summary.trim() === (input.remoteSummary ?? "").trim()
  ) {
    delete input.fields.summary;
    removed.push("summary");
  }

  const assignee = input.fields.assignee;
  const assigneeAccountId =
    assignee && typeof assignee === "object" && !Array.isArray(assignee)
      ? (assignee as { accountId?: unknown }).accountId
      : undefined;
  if (
    typeof assigneeAccountId === "string" &&
    assigneeAccountId.trim() &&
    assigneeAccountId.trim() === (input.remoteAssigneeAccountId ?? "").trim()
  ) {
    delete input.fields.assignee;
    removed.push("assignee");
  }

  const parent = input.fields.parent;
  const parentKey =
    parent && typeof parent === "object" && !Array.isArray(parent)
      ? (parent as { key?: unknown }).key
      : undefined;
  if (
    typeof parentKey === "string" &&
    parentKey.trim() &&
    parentKey.trim() === (input.remoteParentKey ?? "").trim()
  ) {
    delete input.fields.parent;
    removed.push("parent");
  }

  const labels = input.fields.labels;
  if (Array.isArray(labels)) {
    const localLabels = normalizeLabels(
      labels.filter((label): label is string => typeof label === "string")
    );
    const remoteLabels = normalizeLabels(input.remoteLabels);
    if (
      localLabels.length === remoteLabels.length &&
      localLabels.every((label, index) => label === remoteLabels[index])
    ) {
      delete input.fields.labels;
      removed.push("labels");
    }
  }

  for (const comparableField of input.comparableFields ?? []) {
    if (
      comparableField.fieldId in input.fields &&
      comparableFieldValuesEqual(
        comparableField.localValue,
        comparableField.remoteValue
      )
    ) {
      delete input.fields[comparableField.fieldId];
      removed.push(comparableField.fieldId);
    }
  }

  if (
    "description" in input.fields &&
    typeof input.localDescriptionMarkdown === "string" &&
    typeof input.remoteDescriptionMarkdown === "string" &&
    normalizeMarkdown(input.localDescriptionMarkdown) ===
      normalizeMarkdown(input.remoteDescriptionMarkdown)
  ) {
    delete input.fields.description;
    removed.push("description");
  }

  return removed;
}
