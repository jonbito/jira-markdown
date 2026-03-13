import { type FieldResolverKind } from "./types.js";

type SprintLike = {
  id?: number | undefined;
  name?: string | undefined;
  state?: string | undefined;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseLegacySprintString(value: string): SprintLike | undefined {
  const idMatch = value.match(/(?:^|[,[])id=(\d+)(?:[,\]])/u);
  const nameMatch = value.match(/(?:^|[,[])name=([^,\]]+)(?:[,\]])/u);
  const stateMatch = value.match(/(?:^|[,[])state=([^,\]]+)(?:[,\]])/u);

  if (!idMatch && !nameMatch && !stateMatch) {
    return undefined;
  }

  return {
    ...(idMatch?.[1] ? { id: Number(idMatch[1]) } : {}),
    ...(nameMatch?.[1] ? { name: nameMatch[1].trim() } : {}),
    ...(stateMatch?.[1] ? { state: stateMatch[1].trim() } : {})
  };
}

function coerceSprintLike(value: unknown): SprintLike | undefined {
  if (Array.isArray(value)) {
    return undefined;
  }

  const numericValue = asFiniteNumber(value);
  if (numericValue !== undefined) {
    return { id: numericValue };
  }

  const stringValue = asString(value);
  if (stringValue) {
    return parseLegacySprintString(stringValue) ?? { name: stringValue };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = asFiniteNumber(record.id);
  const name = asString(record.name);
  const state = asString(record.state);

  if (id === undefined && !name && !state) {
    return undefined;
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(name ? { name } : {}),
    ...(state ? { state } : {})
  };
}

function collectSprintEntries(value: unknown): SprintLike[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => coerceSprintLike(entry))
      .filter((entry): entry is SprintLike => Boolean(entry));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const numericKeys = Object.keys(record)
      .filter((key) => /^\d+$/u.test(key))
      .sort((left, right) => Number(right) - Number(left));
    if (numericKeys.length > 0) {
      return collectSprintEntries(record[numericKeys[0] as string]);
    }
  }

  const single = coerceSprintLike(value);
  return single ? [single] : [];
}

function sprintStateRank(value: string | undefined): number {
  switch (value?.trim().toLowerCase()) {
    case "active":
      return 0;
    case "future":
      return 1;
    case "closed":
      return 2;
    default:
      return 3;
  }
}

function selectPreferredSprint(entries: SprintLike[]): SprintLike | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return [...entries].sort((left, right) => {
    const rankDifference = sprintStateRank(left.state) - sprintStateRank(right.state);
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return (right.id ?? 0) - (left.id ?? 0);
  })[0];
}

export function extractSprintFrontmatterValue(
  value: unknown,
  resolver: FieldResolverKind | undefined
): string | number | undefined {
  const sprint = selectPreferredSprint(collectSprintEntries(value));
  if (!sprint) {
    return undefined;
  }

  if (resolver === "sprintByName") {
    return sprint.name ?? sprint.id;
  }

  if (resolver === "sprintById") {
    return sprint.id ?? sprint.name;
  }

  return sprint.name ?? sprint.id;
}
