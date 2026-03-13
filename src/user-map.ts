import { loadStoredAuthConfig } from "./auth-store.js";
import { initAppConfig, saveGeneratedUserMap } from "./config.js";
import { JiraClient } from "./jira.js";
import { type AppConfig, type JiraUserSummary, type UserMapEntry } from "./types.js";

export interface IndexedUserMapEntry extends UserMapEntry {
  label: string;
}

function asTrimmed(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

export function normalizeUserLookupValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@/u, "").toLowerCase();
}

export function buildUserMapIndex(userMap: AppConfig["userMap"]): {
  byAccountId: Map<string, IndexedUserMapEntry>;
  byLookup: Map<string, IndexedUserMapEntry>;
} {
  const byAccountId = new Map<string, IndexedUserMapEntry>();
  const byLookup = new Map<string, IndexedUserMapEntry>();
  const collisions = new Set<string>();

  function registerLookup(rawValue: string | undefined, entry: IndexedUserMapEntry): void {
    const normalized = normalizeUserLookupValue(rawValue);
    if (!normalized || collisions.has(normalized)) {
      return;
    }

    const existing = byLookup.get(normalized);
    if (existing && existing.accountId !== entry.accountId) {
      byLookup.delete(normalized);
      collisions.add(normalized);
      return;
    }

    byLookup.set(normalized, entry);
  }

  for (const [label, value] of Object.entries(userMap)) {
    const trimmedLabel = asTrimmed(label);
    const accountId = asTrimmed(value.accountId);
    if (!trimmedLabel || !accountId) {
      continue;
    }

    const entry: IndexedUserMapEntry = {
      accountId,
      aliases: value.aliases?.map((alias) => alias.trim()).filter(Boolean),
      email: asTrimmed(value.email),
      label: trimmedLabel
    };

    if (!byAccountId.has(accountId)) {
      byAccountId.set(accountId, entry);
    }

    registerLookup(trimmedLabel, entry);
    registerLookup(accountId, entry);
    registerLookup(entry.email, entry);
    for (const alias of entry.aliases ?? []) {
      registerLookup(alias, entry);
    }
  }

  return {
    byAccountId,
    byLookup
  };
}

export function resolveUserFromMap(
  userMap: AppConfig["userMap"],
  value: string | undefined
): IndexedUserMapEntry | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return buildUserMapIndex(userMap).byLookup.get(normalizeUserLookupValue(value));
}

export function resolvePreferredUserLabel(
  userMap: AppConfig["userMap"],
  accountId: string | undefined,
  fallbackDisplayName?: string | undefined
): string | undefined {
  if (!accountId?.trim()) {
    return asTrimmed(fallbackDisplayName);
  }

  const entry = buildUserMapIndex(userMap).byAccountId.get(accountId.trim());
  return entry?.label ?? asTrimmed(fallbackDisplayName) ?? accountId.trim();
}

function buildPreferredUserLabel(
  user: JiraUserSummary,
  displayNameCounts: Map<string, number>
): string {
  const displayName = asTrimmed(user.displayName) ?? asTrimmed(user.emailAddress) ?? user.accountId;
  const duplicateCount = displayNameCounts.get(displayName) ?? 0;
  if (duplicateCount <= 1) {
    return displayName;
  }

  const email = asTrimmed(user.emailAddress);
  if (email) {
    return `${displayName} <${email}>`;
  }

  return `${displayName} (${user.accountId})`;
}

function buildIncrementalUserLabel(
  user: JiraUserSummary,
  userMap: AppConfig["userMap"]
): string {
  const preferredBaseLabel =
    asTrimmed(user.displayName) ?? asTrimmed(user.emailAddress) ?? user.accountId;
  const email = asTrimmed(user.emailAddress);
  const labelCandidates = [
    preferredBaseLabel,
    ...(email && email !== preferredBaseLabel
      ? [`${preferredBaseLabel} <${email}>`]
      : []),
    `${preferredBaseLabel} (${user.accountId})`
  ];

  for (const candidate of labelCandidates) {
    const existing = userMap[candidate];
    if (!existing || existing.accountId === user.accountId) {
      return candidate;
    }
  }

  return `${preferredBaseLabel} (${user.accountId})`;
}

export function upsertDiscoveredUsers(
  userMap: AppConfig["userMap"],
  users: JiraUserSummary[]
): {
  changed: boolean;
  userMap: AppConfig["userMap"];
} {
  const nextUserMap: AppConfig["userMap"] = { ...userMap };
  const existingIndex = buildUserMapIndex(userMap);
  let changed = false;

  const sortedUsers = [...users].sort((left, right) => {
    const leftKey = `${left.displayName}\u0000${left.emailAddress ?? ""}\u0000${left.accountId}`;
    const rightKey = `${right.displayName}\u0000${right.emailAddress ?? ""}\u0000${right.accountId}`;
    return leftKey.localeCompare(rightKey);
  });

  for (const user of sortedUsers) {
    const accountId = asTrimmed(user.accountId);
    const displayName = asTrimmed(user.displayName);
    if (!accountId || !displayName) {
      continue;
    }

    const email = asTrimmed(user.emailAddress);
    const existingEntry = existingIndex.byAccountId.get(accountId);
    const label = existingEntry?.label ?? buildIncrementalUserLabel(user, nextUserMap);
    const nextAliases = new Set<string>(existingEntry?.aliases ?? []);

    if (displayName !== label) {
      nextAliases.add(displayName);
    }
    if (email && email !== label) {
      nextAliases.add(email);
    }

    const nextEntry: UserMapEntry = {
      accountId,
      ...(nextAliases.size > 0
        ? {
            aliases: [...nextAliases].sort((left, right) => left.localeCompare(right))
          }
        : {}),
      ...(email ?? existingEntry?.email ? { email: email ?? existingEntry?.email } : {})
    };

    const previousEntry = label in nextUserMap ? nextUserMap[label] : undefined;
    if (JSON.stringify(previousEntry) !== JSON.stringify(nextEntry)) {
      nextUserMap[label] = nextEntry;
      changed = true;
    }
  }

  return {
    changed,
    userMap: changed ? nextUserMap : userMap
  };
}

export function buildDiscoveredUserMap(users: JiraUserSummary[]): AppConfig["userMap"] {
  const sortedUsers = [...users].sort((left, right) => {
    const leftKey = `${left.displayName}\u0000${left.emailAddress ?? ""}\u0000${left.accountId}`;
    const rightKey = `${right.displayName}\u0000${right.emailAddress ?? ""}\u0000${right.accountId}`;
    return leftKey.localeCompare(rightKey);
  });

  const displayNameCounts = new Map<string, number>();
  for (const user of sortedUsers) {
    const displayName = asTrimmed(user.displayName) ?? asTrimmed(user.emailAddress) ?? user.accountId;
    displayNameCounts.set(displayName, (displayNameCounts.get(displayName) ?? 0) + 1);
  }

  const result: AppConfig["userMap"] = {};
  for (const user of sortedUsers) {
    const label = buildPreferredUserLabel(user, displayNameCounts);
    const aliases = new Set<string>();
    const displayName = asTrimmed(user.displayName);
    const email = asTrimmed(user.emailAddress);

    if (displayName && displayName !== label) {
      aliases.add(displayName);
    }
    if (email && email !== label) {
      aliases.add(email);
    }

    result[label] = {
      accountId: user.accountId,
      ...(aliases.size > 0 ? { aliases: [...aliases].sort((left, right) => left.localeCompare(right)) } : {}),
      ...(email ? { email } : {})
    };
  }

  return result;
}

interface DiscoverUserMapOptions {
  configPath?: string | undefined;
  includeInactive?: boolean | undefined;
  write?: boolean | undefined;
}

export async function discoverUserMap(options: DiscoverUserMapOptions = {}): Promise<void> {
  const { config, configPath, created } = await initAppConfig({
    configPath: options.configPath
  });

  if (created) {
    process.stdout.write(`Initialized starter config at ${configPath}.\n`);
  }

  const jira = new JiraClient(await loadStoredAuthConfig());
  const discoveredUsers = await jira.listUsers();
  const filteredUsers = options.includeInactive
    ? discoveredUsers
    : discoveredUsers.filter((user) => user.active !== false);
  const discoveredMap = buildDiscoveredUserMap(filteredUsers);

  if (Object.keys(discoveredMap).length === 0) {
    process.stdout.write("No Jira users were returned for user-map discovery.\n");
    return;
  }

  if (options.write) {
    const savedPath = await saveGeneratedUserMap(discoveredMap, config.dir, configPath);
    process.stdout.write(
      `Wrote ${Object.keys(discoveredMap).length} user-map entries to ${savedPath}.\n`
    );
    return;
  }

  process.stdout.write(`User map:\n${JSON.stringify(discoveredMap, null, 2)}\n`);
  process.stdout.write(
    "Copy this into <dir>/.jira-markdown.user-map.json or re-run with --write.\n"
  );
}
