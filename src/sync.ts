import { readFile, stat } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import {
  adfToMarkdown,
  collectMediaBlocks,
  extractMarkdownMentions,
  markdownToAdf,
  type AdfNode
} from "./adf";
import {
  buildDraftAttachmentDirectory,
  buildIssueAttachmentDirectory,
  buildIssueAttachmentFilePath,
  buildIssueAttachmentMarkdownPath,
  buildLocalAttachmentSignature,
  buildRemoteAttachmentSignature,
  createUniqueAttachmentFileName,
  isLikelyImageAttachment,
  listLocalAttachmentFiles,
  moveIssueAttachmentDirectory,
  promoteDraftAttachmentDirectory,
  sanitizeAttachmentFileName,
  writeAttachmentFile,
  type LocalAttachmentFile
} from "./attachments";
import { loadStoredAuthConfig } from "./auth-store";
import {
  loadAppConfig,
  saveGeneratedProjectIssueTypeFieldMap,
  saveGeneratedUserMap
} from "./config";
import {
  extractFrontmatterFieldValue,
  inferResolverForField,
  resolvePlainFieldValue
} from "./field-value";
import {
  buildCanonicalIssueFilePath,
  formatPulledIssueMarkdown,
  moveIssueFileToCanonicalPath,
  writeIssueFileToCanonicalPath
} from "./issue-file";
import {
  ISSUE_KEY_FRONTMATTER_FIELD,
  resolveIssueKey
} from "./issue-key";
import { buildCoreIssuePayload } from "./issue-payload";
import { JiraApiError, JiraClient } from "./jira";
import {
  loadMarkdownDocument,
  writeIssueKeyToFrontmatter
} from "./markdown";
import {
  inferProjectKeyFromFilePath
} from "./project-path";
import {
  discoverMissingProjectIssueTypeFieldMaps,
  inferIssueTypeForMappingScope,
  inferProjectKeyForMappingScope,
  resolveFieldMapping
} from "./project-field-map";
import {
  normalizeUserLookupValue,
  resolvePreferredUserLabel,
  resolveUserFromMap,
  upsertDiscoveredUsers
} from "./user-map";
import { pruneUnchangedUpdateFields } from "./update-field-pruning";
import { collectBlockedUpdateFields } from "./update-field-validation";
import {
  findAttachmentHistoryRecordByRemoteId,
  getAttachmentHistoryRecord,
  getIssueHistoryRecord,
  rewriteAttachmentHistoryPathsForIssue,
  createCommandStats,
  deleteFileHistoryRecord,
  loadSyncHistory,
  resolveSyncHistoryPath,
  saveSyncHistory,
  setCommandHistoryStats,
  setAttachmentHistoryRecord,
  setFileHistoryRecord,
  setIssueHistoryRecord,
  shouldSkipPullByHistory,
  shouldSkipPushByHistory,
  toHistoryRelativePath,
  type SyncCommandStats,
  type SyncHistory
} from "./sync-history";
import {
  type AppConfig,
  type ConflictMode,
  type ConflictResolution,
  type FieldMappingConfig,
  type JiraCreateField,
  type JiraIssueAttachment,
  type JiraField,
  type JiraIssueRecord,
  type JiraIssueTypeSummary,
  type JiraUserSummary,
  type MarkdownIssueDocument,
  type SyncFileResult
} from "./types";

interface SyncCommandOptions {
  configPath?: string;
  dryRun?: boolean;
  onConflict?: ConflictMode;
  projects?: string[] | undefined;
  resolveConflict?: ResolveConflict | undefined;
  writeBack?: boolean;
}

interface FieldCatalog {
  byId: Map<string, JiraField>;
  byName: Map<string, JiraField>;
  bySchemaCustom: Map<string, JiraField>;
}

type RememberUsers = (users: JiraUserSummary[]) => void;

interface LocalIssueRecord {
  document: MarkdownIssueDocument;
  filePath: string;
  issueKey: string;
  mtimeMs: number;
  projectKey?: string | undefined;
}

interface PushExecutionContext {
  catalog: FieldCatalog;
  config: AppConfig;
  conflictMode: ConflictMode;
  files: string[];
  history: SyncHistory;
  issueKeyField: string;
  jira: JiraClient;
  localIssueIndex: Map<string, LocalIssueRecord>;
  projectKeys: Set<string>;
  pushStats: SyncCommandStats;
  rememberUsers?: RememberUsers | undefined;
  resolveConflict?: ResolveConflict | undefined;
}

interface PushExecutionResult {
  pushedIssueKeys: Set<string>;
  results: SyncFileResult[];
}

interface LocalAttachmentState {
  attachmentDirectory: string;
  files: LocalAttachmentFile[];
  signature: string;
}

interface PreparedLocalIssue {
  action: "create" | "update";
  core: ReturnType<typeof buildCoreIssuePayload>;
  currentAttachmentState: LocalAttachmentState;
  currentFileMtimeMs: number;
  document: MarkdownIssueDocument;
  fieldInputs: PreparedFieldInput[];
  fields: Record<string, unknown>;
  filePath: string;
  mappingScope: {
    issueTypeName?: string | undefined;
    projectKey?: string | undefined;
  };
}

interface SyncConflict {
  filePath: string;
  issueKey: string;
  summary: string;
}

type ResolveConflict = (input: SyncConflict) => Promise<ConflictResolution>;

interface PlannedAttachmentOperation {
  deleteRemoteAttachmentId?: string | undefined;
  historyRecord?: ReturnType<typeof getAttachmentHistoryRecord>;
  kind: "replace" | "unchanged" | "upload";
  localAttachment: LocalAttachmentFile;
  matchedRemoteAttachment?: JiraIssueAttachment | undefined;
}

interface PlannedAttachmentSync {
  hasMutations: boolean;
  operations: PlannedAttachmentOperation[];
  remoteAttachments: JiraIssueAttachment[];
}

interface PlannedLocalIssueUpdate {
  attachmentPlan: PlannedAttachmentSync;
  editableFields?: JiraCreateField[] | undefined;
  finalProjectKey?: string | undefined;
  hasPendingWrites: boolean;
  plannedFields?: Record<string, unknown>;
  plannedStatus?: string | undefined;
}

interface ResolvedFieldBinding {
  boardId?: number | undefined;
  field: JiraField;
  resolver: NonNullable<FieldMappingConfig["resolver"]>;
  sourceKey: string;
}

interface PreparedFieldInput {
  binding: ResolvedFieldBinding;
  value: unknown;
}

interface CreateIssueContext {
  createFields: JiraCreateField[];
  issueType: JiraIssueTypeSummary;
  projectKey: string;
}

const SPRINT_SCHEMA_CUSTOM = "com.pyxis.greenhopper.jira:gh-sprint";
const DIRECT_PULL_SOURCE_KEYS = ["priority", "components", "versions", "fixVersions"] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeLookupKey(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

function normalizeProjectKey(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim().toUpperCase() : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRemoteIssueStatusName(issue: JiraIssueRecord): string | undefined {
  return asTrimmedString(issue.fields.status?.name);
}

function planDesiredIssueStatus(
  localIssue: PreparedLocalIssue,
  remoteIssue: JiraIssueRecord
): string | undefined {
  const desiredStatus = asTrimmedString(localIssue.core.status);
  if (!desiredStatus) {
    return undefined;
  }

  const remoteStatus = getRemoteIssueStatusName(remoteIssue);
  if (
    remoteStatus &&
    normalizeLookupKey(remoteStatus) === normalizeLookupKey(desiredStatus)
  ) {
    return undefined;
  }

  return desiredStatus;
}

function toProjectLookupCandidates(projectKey: string): string[] {
  const trimmed = projectKey.trim();
  return [...new Set([trimmed, trimmed.toUpperCase(), trimmed.toLowerCase()])];
}

function findRecordByKey<T>(
  record: Record<string, T>,
  requestedKey: string | undefined
): T | undefined {
  if (!requestedKey?.trim()) {
    return undefined;
  }

  const direct = record[requestedKey];
  if (direct) {
    return direct;
  }

  const normalizedRequested = normalizeLookupKey(requestedKey);
  for (const [key, value] of Object.entries(record)) {
    if (normalizeLookupKey(key) === normalizedRequested) {
      return value;
    }
  }

  return undefined;
}

function addProjectKey(target: Set<string>, value: string | undefined): void {
  const normalized = normalizeProjectKey(value);
  if (normalized) {
    target.add(normalized);
  }
}

function collectConfiguredProjectKeys(
  explicitProjects: string[] = []
): Set<string> {
  const projects = new Set<string>();

  for (const project of explicitProjects) {
    addProjectKey(projects, project);
  }

  return projects;
}

function createFieldCatalog(fields: JiraField[]): FieldCatalog {
  const byId = new Map<string, JiraField>();
  const byName = new Map<string, JiraField>();
  const bySchemaCustom = new Map<string, JiraField>();

  for (const field of fields) {
    byId.set(field.id, field);
    byName.set(normalizeLookupKey(field.name), field);
    if (field.schema?.custom) {
      bySchemaCustom.set(field.schema.custom, field);
    }
  }

  return { byId, byName, bySchemaCustom };
}

function createGeneratedUserMapTracker(config: AppConfig): {
  hasChanges: () => boolean;
  rememberUsers: RememberUsers;
} {
  let changed = false;

  return {
    hasChanges() {
      return changed;
    },
    rememberUsers(users) {
      const result = upsertDiscoveredUsers(config.userMap, users);
      if (!result.changed) {
        return;
      }

      config.userMap = result.userMap;
      changed = true;
    }
  };
}

async function ensureGeneratedProjectFieldMappings(input: {
  config: AppConfig;
  configPath: string;
  dryRun?: boolean | undefined;
  jira: JiraClient;
  projectKeys: Iterable<string>;
  globalFields: JiraField[];
}): Promise<AppConfig> {
  const discovery = await discoverMissingProjectIssueTypeFieldMaps({
    config: input.config,
    globalFields: input.globalFields,
    jira: input.jira,
    projectKeys: input.projectKeys
  });

  if (!discovery.changed) {
    return input.config;
  }

  if (!input.dryRun) {
    await saveGeneratedProjectIssueTypeFieldMap(
      discovery.config.projectIssueTypeFieldMap,
      discovery.config.dir,
      input.configPath
    );
  }

  return discovery.config;
}

async function collectFiles(dir: string, cwd = process.cwd()): Promise<string[]> {
  const matches = new Set<string>();

  const rootDirectory = resolve(cwd, dir);
  try {
    const rootStats = await stat(rootDirectory);
    if (!rootStats.isDirectory()) {
      return [];
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const glob = new Bun.Glob("**/*.md");
  for await (const match of glob.scan({ cwd: rootDirectory, absolute: true })) {
    const filePath = resolve(match);
    const fileStats = await stat(filePath);
    if (fileStats.isFile()) {
      matches.add(filePath);
    }
  }

  return [...matches].sort();
}

async function loadLocalIssueState(
  config: AppConfig,
  issueKeyField: string,
  explicitProjects: string[] = [],
  includeConfiguredProjects = true
): Promise<{
  files: string[];
  localIssueIndex: Map<string, LocalIssueRecord>;
  projectKeys: Set<string>;
}> {
  const files = await collectFiles(config.dir);
  const localIssueIndex = new Map<string, LocalIssueRecord>();
  const projectKeys = includeConfiguredProjects
    ? collectConfiguredProjectKeys(explicitProjects)
    : new Set<string>();

  if (!includeConfiguredProjects) {
    for (const project of explicitProjects) {
      addProjectKey(projectKeys, project);
    }
  }

  for (const filePath of files) {
    const document = await loadMarkdownDocument(filePath);
    const fileStats = await stat(filePath);
    const issueKey = resolveIssueKey({
      filePath: document.filePath,
      frontmatter: document.frontmatter,
      issueKeyField
    });
    const projectKey = inferProjectKeyForMappingScope({
      dir: config.dir,
      filePath: document.filePath,
      frontmatter: document.frontmatter,
      issueKey
    });

    addProjectKey(projectKeys, projectKey);

    if (!issueKey) {
      continue;
    }

    localIssueIndex.set(issueKey, {
      document,
      filePath: document.filePath,
      issueKey,
      mtimeMs: fileStats.mtimeMs,
      projectKey
    });
  }

  return {
    files,
    localIssueIndex,
    projectKeys
  };
}

function resolveEffectiveConflictMode(mode: ConflictMode | undefined): ConflictMode {
  if (mode) {
    return mode;
  }

  return process.stdin.isTTY && process.stdout.isTTY ? "prompt" : "fail";
}

function buildConflictMessage(input: SyncConflict): string {
  return `Conflict detected for ${input.issueKey} (${input.filePath}): both local markdown and Jira changed since the last successful sync. Re-run with --on-conflict keep-local, --on-conflict keep-jira, or --on-conflict fail.`;
}

async function resolveConflictChoice(input: {
  conflict: SyncConflict;
  mode: ConflictMode;
  resolveConflict?: ResolveConflict | undefined;
}): Promise<Exclude<ConflictResolution, "abort">> {
  switch (input.mode) {
    case "keep-local":
      return "keep-local";
    case "keep-jira":
      return "keep-jira";
    case "fail":
      throw new Error(buildConflictMessage(input.conflict));
    case "prompt": {
      if (!input.resolveConflict) {
        throw new Error(buildConflictMessage(input.conflict));
      }

      const resolution = await input.resolveConflict(input.conflict);
      if (resolution === "abort") {
        throw new Error(`Aborted due to conflict on ${input.conflict.issueKey}.`);
      }

      return resolution;
    }
  }
}

function hasLocalIssueChanges(input: {
  attachmentSignature: string;
  filePath: string;
  history: SyncHistory;
  issueKey?: string | undefined;
  mtimeMs: number;
}): boolean {
  return !shouldSkipPushByHistory(input);
}

function hasRemoteIssueChanges(input: {
  history: SyncHistory;
  issueKey: string;
  remoteAttachmentSignature: string;
  remoteUpdatedAt?: string | undefined;
}): boolean {
  const record = getIssueHistoryRecord(input.history, input.issueKey);
  if (!record?.lastSyncedRemoteUpdatedAt && !record?.lastSyncedRemoteAttachmentSignature) {
    return false;
  }

  return Boolean(
    (input.remoteUpdatedAt &&
      record?.lastSyncedRemoteUpdatedAt &&
      record.lastSyncedRemoteUpdatedAt !== input.remoteUpdatedAt) ||
      (record?.lastSyncedRemoteAttachmentSignature !== undefined &&
        record.lastSyncedRemoteAttachmentSignature !== input.remoteAttachmentSignature)
  );
}

function recordSyncedIssueState(input: {
  fileMtimeMs: number;
  filePath: string;
  history: SyncHistory;
  issueKey: string;
  localAttachmentSignature: string;
  projectKey?: string | undefined;
  remoteAttachmentSignature: string;
  remoteUpdatedAt?: string | undefined;
  summary: string;
  syncedAt: string;
}): void {
  setFileHistoryRecord(input.history, input.filePath, {
    lastAttachmentSignature: input.localAttachmentSignature,
    issueKey: input.issueKey,
    lastSyncedAt: input.syncedAt,
    lastSyncedMtimeMs: input.fileMtimeMs
  });

  const existing = getIssueHistoryRecord(input.history, input.issueKey) ?? {};
  setIssueHistoryRecord(input.history, input.issueKey, {
    ...existing,
    filePath: toHistoryRelativePath(input.filePath),
    lastPulledAttachmentSignature: input.remoteAttachmentSignature,
    lastPulledAt: input.syncedAt,
    lastPulledFileMtimeMs: input.fileMtimeMs,
    lastPulledLocalAttachmentSignature: input.localAttachmentSignature,
    ...(input.remoteUpdatedAt
      ? {
          lastPulledRemoteUpdatedAt: input.remoteUpdatedAt,
          lastSyncedRemoteUpdatedAt: input.remoteUpdatedAt
        }
      : {}),
    lastSyncedRemoteAttachmentSignature: input.remoteAttachmentSignature,
    projectKey: input.projectKey,
    summary: input.summary
  });
}

async function prepareLocalIssueForPush(input: {
  catalog: FieldCatalog;
  config: AppConfig;
  dryRun?: boolean | undefined;
  filePath: string;
  issueKeyField: string;
  jira: JiraClient;
  rememberUsers?: RememberUsers | undefined;
}): Promise<PreparedLocalIssue> {
  const document = await loadMarkdownDocument(input.filePath);
  const currentFileStats = await stat(input.filePath);
  const issueKey = resolveIssueKey({
    filePath: document.filePath,
    frontmatter: document.frontmatter,
    issueKeyField: input.issueKeyField
  });
  const core = buildCoreIssuePayload({
    body: document.body,
    dir: input.config.dir,
    filePath: document.filePath,
    frontmatter: document.frontmatter,
    issueKeyField: input.issueKeyField,
    omitDescription: !issueKey && !input.dryRun
  });
  const mappingScope = {
    issueTypeName: inferIssueTypeForMappingScope({
      frontmatter: document.frontmatter,
      issueTypeName: core.issueTypeName
    }),
    projectKey: inferProjectKeyForMappingScope({
      dir: input.config.dir,
      filePath: input.filePath,
      frontmatter: document.frontmatter,
      issueKey: core.issueKey
    })
  };
  const currentAttachmentState = await loadLocalAttachmentState({
    filePath: input.filePath,
    issueKey: core.issueKey,
    rootDir: input.config.dir,
    projectKey:
      inferProjectKeyFromFilePath(input.filePath, input.config.dir) ??
      mappingScope.projectKey ??
      core.projectKey
  });
  const fields = { ...core.fields };
  const fieldInputs: PreparedFieldInput[] = [];

  for (const [key, value] of Object.entries(core.extraFrontmatter)) {
    fieldInputs.push({
      binding: resolveFieldBinding(key, value, input.config, input.catalog, mappingScope),
      value
    });
  }

  return {
    action: core.issueKey ? "update" : "create",
    core,
    currentAttachmentState,
    currentFileMtimeMs: currentFileStats.mtimeMs,
    document,
    fieldInputs,
    fields,
    filePath: input.filePath,
    mappingScope
  };
}

function inferResolver(
  field: JiraField,
  mapping: FieldMappingConfig | undefined,
  value: unknown
): NonNullable<FieldMappingConfig["resolver"]> {
  if (mapping?.resolver) {
    return mapping.resolver;
  }

  if (field.schema?.custom === SPRINT_SCHEMA_CUSTOM) {
    if (typeof value === "string" && value.trim() && !/^\d+$/.test(value.trim())) {
      return mapping?.boardId ? "sprintByName" : "sprintById";
    }

    return "sprintById";
  }

  return inferResolverForField(field, {
    ...(mapping?.boardId ? { boardId: mapping.boardId } : {})
  });
}

function resolveFieldBinding(
  sourceKey: string,
  value: unknown,
  config: AppConfig,
  catalog: FieldCatalog,
  scope: {
    issueTypeName?: string | undefined;
    projectKey?: string | undefined;
  } = {}
): ResolvedFieldBinding {
  const binding = tryResolveFieldBinding(sourceKey, value, config, catalog, scope);
  if (binding) {
    return binding;
  }

  throw new Error(
    `No Jira field mapping found for frontmatter key "${sourceKey}" in scope ${scope.projectKey ?? "global"}${scope.issueTypeName ? ` / ${scope.issueTypeName}` : ""}. Use a direct frontmatter key like customfield_12345, an exact Jira field name, or add the mapping to <dir>/.jira-markdown.field-map.json under ${scope.projectKey ?? "PROJECT"}.${scope.issueTypeName ?? "Issue Type"}.${sourceKey}.`
  );
}

function tryResolveFieldBinding(
  sourceKey: string,
  value: unknown,
  config: AppConfig,
  catalog: FieldCatalog,
  scope: {
    issueTypeName?: string | undefined;
    projectKey?: string | undefined;
  } = {}
): ResolvedFieldBinding | undefined {
  const mapping = resolveFieldMapping(config, sourceKey, scope);

  const field =
    (mapping?.fieldId ? catalog.byId.get(mapping.fieldId) : undefined) ??
    (mapping?.fieldName
      ? catalog.byName.get(normalizeLookupKey(mapping.fieldName))
      : undefined) ??
    (mapping?.schemaCustom ? catalog.bySchemaCustom.get(mapping.schemaCustom) : undefined) ??
    catalog.byId.get(sourceKey) ??
    catalog.byName.get(normalizeLookupKey(sourceKey));

  if (!field) {
    return undefined;
  }

  return {
    boardId: mapping?.boardId,
    field,
    resolver: inferResolver(field, mapping, value),
    sourceKey
  };
}

async function resolveUserAccountId(
  rawValue: string,
  sourceKey: string,
  jira: JiraClient,
  config: AppConfig,
  rememberUsers?: RememberUsers | undefined
): Promise<string> {
  const mappedUser = resolveUserFromMap(config.userMap, rawValue);
  if (mappedUser) {
    return mappedUser.accountId;
  }

  if (looksLikeMentionAccountId(rawValue)) {
    return rawValue.trim();
  }

  const candidates = await jira.searchUsers(rawValue);
  const matchedUser = selectMentionUser(candidates, {
    identifier: rawValue,
    label: rawValue
  });

  if (!matchedUser) {
    if (candidates.length === 0) {
      throw new Error(
        `Could not resolve user "${rawValue}" for "${sourceKey}". Use a more specific name or an accountId. Successful resolutions are cached automatically in <dir>/.jira-markdown.user-map.json.`
      );
    }

    throw new Error(
      `User "${rawValue}" for "${sourceKey}" is ambiguous. Use a more specific name or an accountId. Successful resolutions are cached automatically in <dir>/.jira-markdown.user-map.json.`
    );
  }

  rememberUsers?.([matchedUser]);
  return matchedUser.accountId;
}

async function resolveFieldValue(
  binding: ResolvedFieldBinding,
  value: unknown,
  fieldMetadata: JiraCreateField | undefined,
  jira: JiraClient,
  config: AppConfig,
  rememberUsers?: RememberUsers | undefined
): Promise<unknown> {
  switch (binding.resolver) {
    case "userByAccountId":
      return {
        accountId: await resolveUserAccountId(
          String(resolvePlainFieldValue({
            resolver: "string",
            sourceKey: binding.sourceKey,
            value
          })),
          binding.sourceKey,
          jira,
          config,
          rememberUsers
        )
      };
    case "sprintById":
      return resolvePlainFieldValue({
        resolver: "number",
        sourceKey: binding.sourceKey,
        value
      });
    case "sprintByName": {
      const boardId = binding.boardId;
      if (!boardId) {
        throw new Error(
          `Frontmatter key "${binding.sourceKey}" needs boardId in its field mapping when using resolver "sprintByName".`
        );
      }

      if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        return Number(value.trim());
      }

      const sprintId = await jira.resolveSprintId(
        boardId,
        String(
          resolvePlainFieldValue({
            resolver: "string",
            sourceKey: binding.sourceKey,
            value
          })
        )
      );

      if (!sprintId) {
        throw new Error(
          `Could not resolve sprint "${String(value)}" on board ${boardId}.`
        );
      }

      return sprintId;
    }
    case "passthrough":
    default:
      return resolvePlainFieldValue({
        fieldMetadata,
        resolver: binding.resolver,
        sourceKey: binding.sourceKey,
        value
      });
  }
}

function createFieldMetadataIndex(fields: JiraCreateField[]): Map<string, JiraCreateField> {
  return new Map(fields.map((field) => [field.fieldId, field]));
}

async function resolvePreparedLocalIssueFields(input: {
  config: AppConfig;
  jira: JiraClient;
  localIssue: PreparedLocalIssue;
  operationFields?: JiraCreateField[] | undefined;
  rememberUsers?: RememberUsers | undefined;
}): Promise<Record<string, unknown>> {
  const fields = { ...input.localIssue.fields };
  const operationFieldsById = createFieldMetadataIndex(input.operationFields ?? []);

  for (const fieldInput of input.localIssue.fieldInputs) {
    fields[fieldInput.binding.field.id] = await resolveFieldValue(
      fieldInput.binding,
      fieldInput.value,
      operationFieldsById.get(fieldInput.binding.field.id),
      input.jira,
      input.config,
      input.rememberUsers
    );
  }

  await resolveSystemFields(fields, input.jira, input.config, input.rememberUsers);
  return fields;
}

async function resolveSystemFields(
  fields: Record<string, unknown>,
  jira: JiraClient,
  config: AppConfig,
  rememberUsers?: RememberUsers | undefined
): Promise<void> {
  const assignee = fields.assignee;
  if (!assignee || typeof assignee !== "object" || Array.isArray(assignee)) {
    return;
  }

  const rawAccountId = (assignee as { accountId?: unknown }).accountId;
  if (typeof rawAccountId !== "string" || !rawAccountId.trim()) {
    return;
  }

  fields.assignee = {
    accountId: await resolveUserAccountId(rawAccountId, "assignee", jira, config, rememberUsers)
  };
}

async function ensureAssigneeIsAssignable(
  issueKey: string,
  fields: Record<string, unknown>,
  jira: JiraClient
): Promise<void> {
  const assignee = fields.assignee;
  if (!assignee || typeof assignee !== "object" || Array.isArray(assignee)) {
    return;
  }

  const accountId = (assignee as { accountId?: unknown }).accountId;
  if (typeof accountId !== "string" || !accountId.trim()) {
    return;
  }

  const assignableUsers = await jira.searchAssignableUsers({
    accountId,
    issueKey
  });
  const exactMatch = assignableUsers.find((user) => user.accountId === accountId);

  if (!exactMatch) {
    throw new Error(
      `Cannot assign ${issueKey} to ${accountId}. Jira does not list that user as assignable for this issue.`
    );
  }
}

async function ensureIssueFieldsEditable(
  issueKey: string,
  fields: Record<string, unknown>,
  jira: JiraClient,
  catalog: FieldCatalog,
  editableFields?: JiraCreateField[] | undefined
): Promise<JiraCreateField[]> {
  const resolvedEditableFields = editableFields ?? (await jira.getEditFields(issueKey));
  const blockedFields = collectBlockedUpdateFields({
    editableFields: resolvedEditableFields,
    fieldNamesById: new Map(
      [...catalog.byId.entries()].map(([fieldId, field]) => [fieldId, field.name])
    ),
    fields
  });

  if (blockedFields.length === 0) {
    return resolvedEditableFields;
  }

  throw new Error(
    `Cannot update ${issueKey}. Jira does not allow these fields on the edit screen: ${blockedFields
      .map((field) => `${field.fieldName} (${field.fieldId}: ${field.reason})`)
      .join("; ")}. Re-run the push with --dry-run to inspect the final payload.`
  );
}

async function loadCreateContextForLocalIssue(
  localIssue: PreparedLocalIssue,
  jira: JiraClient
): Promise<CreateIssueContext> {
  const projectKey = localIssue.mappingScope.projectKey ?? localIssue.core.projectKey;
  const issueTypeName = localIssue.mappingScope.issueTypeName ?? localIssue.core.issueTypeName;

  if (!projectKey?.trim()) {
    throw new Error(
      `Cannot resolve Jira create metadata for ${localIssue.filePath} without a project key.`
    );
  }

  if (!issueTypeName?.trim()) {
    throw new Error(
      `Cannot resolve Jira create metadata for ${localIssue.filePath} without an issue type.`
    );
  }

  const issueTypes = await jira.listCreateIssueTypes(projectKey);
  const issueType = issueTypes.find(
    (candidate) =>
      normalizeLookupKey(candidate.name) === normalizeLookupKey(issueTypeName)
  );

  if (!issueType) {
    throw new Error(
      `Issue type "${issueTypeName}" is not available for project ${projectKey}.`
    );
  }

  return {
    createFields: await jira.listCreateFields(projectKey, issueType.id),
    issueType,
    projectKey
  };
}

function describeSyncTarget(input: {
  action: "create" | "update";
  filePath: string;
  issueKey?: string | undefined;
}): string {
  return input.issueKey ? `${input.issueKey} (${input.filePath})` : input.filePath;
}

function trimLookupValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractParentReference(
  value: unknown
): { id?: string | undefined; key?: string | undefined } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const parent = value as { id?: unknown; key?: unknown };
  const id = trimLookupValue(parent.id);
  const key = trimLookupValue(parent.key);

  if (!id && !key) {
    return {};
  }

  return {
    ...(id ? { id } : {}),
    ...(key ? { key } : {})
  };
}

async function ensureHierarchyParentValid(input: {
  action: "create" | "update";
  fields: Record<string, unknown>;
  filePath: string;
  isSubtask: boolean;
  issueKey?: string | undefined;
  issueTypeName?: string | undefined;
  jira: JiraClient;
  operationFields: JiraCreateField[];
  projectKey?: string | undefined;
}): Promise<void> {
  const target = describeSyncTarget({
    action: input.action,
    filePath: input.filePath,
    issueKey: input.issueKey
  });
  const rawParent = input.fields.parent;
  const parentReference = extractParentReference(rawParent);

  if (!parentReference) {
    if (input.action === "create" && input.isSubtask) {
      throw new Error(
        `Cannot create ${target}. Jira sub-task issue type "${input.issueTypeName ?? "Unknown"}" requires a parent. Set frontmatter.parent or fields.parent.`
      );
    }
    return;
  }

  if (!parentReference.id && !parentReference.key) {
    throw new Error(
      `Cannot ${input.action} ${target}. Parent must be an object with Jira issue "key" or "id".`
    );
  }

  if (!input.operationFields.some((field) => field.fieldId === "parent")) {
    const details =
      input.action === "create"
        ? `Jira create metadata for issue type "${input.issueTypeName ?? "Unknown"}" in project ${input.projectKey ?? "unknown"} does not expose the parent field.`
        : "Jira does not allow the parent field on the edit screen.";
    throw new Error(
      `Cannot ${input.action} ${target} with parent ${parentReference.key ?? parentReference.id}. ${details}`
    );
  }

  const parentIdentifier = parentReference.key ?? (parentReference.id as string);
  let parentIssue: Awaited<ReturnType<JiraClient["getIssueHierarchy"]>>;
  try {
    parentIssue = await input.jira.getIssueHierarchy(parentIdentifier);
  } catch (error) {
    if (
      error instanceof JiraApiError &&
      [400, 403, 404].includes(error.status)
    ) {
      throw new Error(
        `Cannot ${input.action} ${target}. Jira could not resolve parent issue "${parentIdentifier}". ${error.message}`
      );
    }

    throw error;
  }

  if (!input.isSubtask) {
    return;
  }

  const expectedProjectKey = normalizeProjectKey(input.projectKey);
  const parentProjectKey = normalizeProjectKey(parentIssue.fields.project?.key);
  if (
    expectedProjectKey &&
    parentProjectKey &&
    expectedProjectKey !== parentProjectKey
  ) {
    throw new Error(
      `Cannot ${input.action} ${target} as sub-task "${input.issueTypeName ?? "Unknown"}" under parent ${parentIssue.key}. Jira sub-tasks must use a parent in the same project (${expectedProjectKey}).`
    );
  }
}

function wrapJiraWriteError(input: {
  action: "create" | "update";
  error: unknown;
  fields: Record<string, unknown>;
  filePath: string;
  issueKey?: string | undefined;
}): never {
  if (!(input.error instanceof JiraApiError) || input.error.status !== 400) {
    throw input.error;
  }

  const target = input.issueKey ? `${input.issueKey} (${input.filePath})` : input.filePath;
  const fieldList = Object.keys(input.fields).sort((left, right) => left.localeCompare(right));
  const exactFieldErrors =
    typeof input.error.payload === "string"
      ? []
      : Object.entries(input.error.payload?.errors ?? {}).map(
          ([fieldId, message]) => `${fieldId}: ${message}`
        );
  throw new Error(
    `Failed to ${input.action} ${target}. Request fields [${fieldList.join(", ")}]. ${input.error.message}${exactFieldErrors.length > 0 ? ` Field errors: ${exactFieldErrors.join("; ")}.` : ""} Re-run the push with --dry-run to inspect the final payload.`
  );
}

function wrapJiraTransitionError(input: {
  action: "create" | "update";
  error: unknown;
  filePath: string;
  issueKey: string;
  status: string;
}): never {
  if (!(input.error instanceof JiraApiError) || input.error.status !== 400) {
    throw input.error;
  }

  throw new Error(
    `Failed to ${input.action} ${input.issueKey} (${input.filePath}) to status "${input.status}". ${input.error.message} Re-run the push with --dry-run to inspect the planned change.`
  );
}

async function transitionIssueToStatus(input: {
  action: "create" | "update";
  currentStatusName?: string | undefined;
  filePath: string;
  issueKey: string;
  jira: JiraClient;
  status: string;
}): Promise<void> {
  const transitions = await input.jira.getTransitions(input.issueKey);
  const matchingTransition = transitions.find(
    (transition) =>
      transition.to?.name &&
      normalizeLookupKey(transition.to.name) === normalizeLookupKey(input.status)
  );

  if (!matchingTransition) {
    const availableStatuses = [...new Set(
      transitions
        .map((transition) => asTrimmedString(transition.to?.name))
        .filter((status): status is string => Boolean(status))
    )].sort((left, right) => left.localeCompare(right));

    throw new Error(
      `Cannot ${input.action} ${input.issueKey} (${input.filePath}) to status "${input.status}"${input.currentStatusName ? ` from "${input.currentStatusName}"` : ""}. Available target statuses: ${availableStatuses.length > 0 ? availableStatuses.join(", ") : "none"}.`
    );
  }

  try {
    await input.jira.transitionIssue(input.issueKey, matchingTransition.id);
  } catch (error) {
    wrapJiraTransitionError({
      action: input.action,
      error,
      filePath: input.filePath,
      issueKey: input.issueKey,
      status: input.status
    });
  }
}

async function moveLocalIssueToCanonicalPath(input: {
  currentPath: string;
  issueKey: string;
  issueKeyField: string;
  projectKey: string;
  rootDir: string;
  summary: string;
}): Promise<string> {
  const targetPath = buildCanonicalIssueFilePath(
    input.issueKey,
    input.summary,
    input.projectKey,
    process.cwd(),
    input.rootDir
  );

  return moveIssueFileToCanonicalPath({
    currentPath: input.currentPath,
    issueKey: input.issueKey,
    issueKeyField: input.issueKeyField,
    targetPath
  });
}

function inferProjectKeyFromIssueKey(issueKey: string | undefined): string | undefined {
  const match = issueKey?.match(/^([A-Za-z][A-Za-z0-9_]*)-/u);
  return normalizeProjectKey(match?.[1]);
}

function buildRemoteAttachmentIndex(attachments: JiraIssueAttachment[]): {
  byFileName: Map<string, JiraIssueAttachment[]>;
  byId: Map<string, JiraIssueAttachment>;
} {
  const byFileName = new Map<string, JiraIssueAttachment[]>();
  const byId = new Map<string, JiraIssueAttachment>();

  for (const attachment of attachments) {
    const localFileName = sanitizeAttachmentFileName(attachment.filename);
    byId.set(attachment.id, attachment);
    const entries = byFileName.get(localFileName) ?? [];
    entries.push(attachment);
    byFileName.set(localFileName, entries);
  }

  return { byFileName, byId };
}

function extractAttachmentIdFromHref(href: string): string | undefined {
  const contentMatch = href.match(/\/attachment\/content\/(\d+)(?:[/?#]|$)/u);
  if (contentMatch?.[1]) {
    return contentMatch[1];
  }

  const secureMatch = href.match(/\/secure\/attachment\/(\d+)(?:[/?#]|$)/u);
  if (secureMatch?.[1]) {
    return secureMatch[1];
  }

  return undefined;
}

function resolvePulledAttachmentFileNames(input: {
  attachments: JiraIssueAttachment[];
  existingLocalAttachments: LocalAttachmentFile[];
  history: SyncHistory;
  issueKey: string;
}): Map<string, string> {
  const takenFileNames = new Set(
    input.existingLocalAttachments.map((attachment) => attachment.fileName)
  );
  const resolvedFileNames = new Map<string, string>();

  for (const attachment of input.attachments) {
    const existingHistoryRecord = findAttachmentHistoryRecordByRemoteId(
      input.history,
      input.issueKey,
      attachment.id
    );
    const localFileName =
      existingHistoryRecord?.fileName ??
      createUniqueAttachmentFileName(attachment.filename, takenFileNames, attachment.id);

    takenFileNames.add(localFileName);
    resolvedFileNames.set(attachment.id, localFileName);
  }

  return resolvedFileNames;
}

function createAttachmentMarkdownResolvers(input: {
  attachments: JiraIssueAttachment[];
  issueKey: string;
  markdownFilePath: string;
  projectKey: string;
  rootDir: string;
  resolvedFileNamesByAttachmentId: Map<string, string>;
}): {
  resolveLinkHref: (href: string) => {
    href: string;
    isImage?: boolean;
    label?: string;
  } | undefined;
  resolveMediaNode: (node: {
    attrs?: Record<string, unknown>;
    marks?: Array<{ attrs?: Record<string, unknown>; type: string }> | undefined;
    type: string;
  }) => {
    href: string;
    isImage?: boolean;
    label?: string;
  } | undefined;
} {
  const remoteIndex = buildRemoteAttachmentIndex(input.attachments);

  function toMarkdownTarget(attachment: JiraIssueAttachment): {
    href: string;
    isImage?: boolean;
    label?: string;
  } | undefined {
    const localFileName = input.resolvedFileNamesByAttachmentId.get(attachment.id);
    if (!localFileName) {
      return undefined;
    }

    const isImage = isLikelyImageAttachment(localFileName, attachment.mimeType);
    return {
      href: buildIssueAttachmentMarkdownPath({
        fileName: localFileName,
        issueKey: input.issueKey,
        markdownFilePath: input.markdownFilePath,
        projectKey: input.projectKey,
        rootDir: input.rootDir
      }),
      ...(isImage ? { isImage: true } : {}),
      ...(attachment.filename ? { label: attachment.filename } : {})
    };
  }

  function resolveAttachmentByHref(href: string): JiraIssueAttachment | undefined {
    const attachmentId = extractAttachmentIdFromHref(href);
    if (attachmentId) {
      return remoteIndex.byId.get(attachmentId);
    }

    const hrefFileName = sanitizeAttachmentFileName(
      href.split("?")[0]?.split("#")[0]?.split("/").pop() ?? ""
    );
    const matches = remoteIndex.byFileName.get(hrefFileName) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  function resolveLinkHref(href: string): {
    href: string;
    isImage?: boolean;
    label?: string;
  } | undefined {
    const attachment = resolveAttachmentByHref(href);
    return attachment ? toMarkdownTarget(attachment) : undefined;
  }

  return {
    resolveLinkHref,
    resolveMediaNode(node) {
      const directUrl =
        typeof node.attrs?.url === "string" ? resolveLinkHref(node.attrs.url) : undefined;
      if (directUrl) {
        return directUrl;
      }

      const linkHref = node.marks
        ?.find((mark) => mark.type === "link")
        ?.attrs?.href;
      if (typeof linkHref === "string") {
        const linkedTarget = resolveLinkHref(linkHref);
        if (linkedTarget) {
          return linkedTarget;
        }
      }

      const alt = sanitizeAttachmentFileName(String(node.attrs?.alt ?? ""));
      const altMatches = alt ? remoteIndex.byFileName.get(alt) ?? [] : [];
      const mediaId = typeof node.attrs?.id === "string" ? remoteIndex.byId.get(node.attrs.id) : undefined;
      const attachment =
        mediaId ?? (altMatches.length === 1 ? altMatches[0] : undefined);

      return attachment ? toMarkdownTarget(attachment) : undefined;
    }
  };
}

function extractFileNameFromMarkdownHref(href: string): string | undefined {
  const fileName = href.split("?")[0]?.split("#")[0]?.split("/").pop();
  const sanitized = sanitizeAttachmentFileName(fileName ?? "");
  return sanitized || undefined;
}

function collectPulledInlineImageBlocks(input: {
  description: unknown;
  history: SyncHistory;
  issueKey: string;
  resolvers: ReturnType<typeof createAttachmentMarkdownResolvers>;
}): void {
  const mediaBlocks = collectMediaBlocks(input.description, input.resolvers).filter(
    (entry) => entry.isImage
  );

  for (const mediaBlock of mediaBlocks) {
    const fileName = extractFileNameFromMarkdownHref(mediaBlock.href);
    if (!fileName) {
      continue;
    }

    const historyRecord =
      getAttachmentHistoryRecord(input.history, input.issueKey, fileName) ?? {};
    setAttachmentHistoryRecord(input.history, input.issueKey, fileName, {
      ...historyRecord,
      fileName,
      issueKey: input.issueKey,
      jiraInlineImageBlock: mediaBlock.block,
      jiraInlineImageRemoteAttachmentId: historyRecord.remoteAttachmentId
    });
  }
}

function createMentionMarkdownResolver(input: {
  config: AppConfig;
  rememberUsers?: RememberUsers | undefined;
}): (node: { attrs?: Record<string, unknown>; type: string }) => string | undefined {
  return (node) => {
    const accountId = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
    const displayName =
      typeof node.attrs?.text === "string"
        ? node.attrs.text.replace(/^@/u, "").trim()
        : undefined;
    if (accountId && displayName) {
      input.rememberUsers?.([
        {
          accountId,
          displayName
        }
      ]);
    }
    const preferredLabel = resolvePreferredUserLabel(
      input.config.userMap,
      accountId,
      displayName
    );

    return preferredLabel ? `@[${preferredLabel}]` : undefined;
  };
}

function renderRemoteIssueDescriptionMarkdown(input: {
  config: AppConfig;
  existingLocalAttachments: LocalAttachmentFile[];
  history: SyncHistory;
  issue: JiraIssueRecord;
  markdownFilePath: string;
  projectKey: string;
  rememberUsers?: RememberUsers | undefined;
  rootDir: string;
}): string {
  const attachments = input.issue.fields.attachment ?? [];
  const resolvedFileNamesByAttachmentId = resolvePulledAttachmentFileNames({
    attachments,
    existingLocalAttachments: input.existingLocalAttachments,
    history: input.history,
    issueKey: input.issue.key
  });
  const attachmentMarkdownResolvers = createAttachmentMarkdownResolvers({
    attachments,
    issueKey: input.issue.key,
    markdownFilePath: input.markdownFilePath,
    projectKey: input.projectKey,
    rootDir: input.rootDir,
    resolvedFileNamesByAttachmentId
  });

  return adfToMarkdown(input.issue.fields.description, {
    ...attachmentMarkdownResolvers,
    resolveMention: createMentionMarkdownResolver({
      config: input.config,
      ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
    })
  });
}

function resolveDescriptionSource(document: MarkdownIssueDocument): string {
  const frontmatterDescription = document.frontmatter.description;
  return typeof frontmatterDescription === "string" && frontmatterDescription.trim()
    ? frontmatterDescription.trim()
    : document.body;
}

function buildComparableResolvedFieldValues(input: {
  fieldInputs: PreparedFieldInput[];
  remoteIssue: JiraIssueRecord;
}): Array<{
  fieldId: string;
  localValue: unknown;
  remoteValue: unknown;
}> {
  const comparableFields: Array<{
    fieldId: string;
    localValue: unknown;
    remoteValue: unknown;
  }> = [];

  for (const fieldInput of input.fieldInputs) {
    const fieldId = fieldInput.binding.field.id;
    if (!(fieldId in input.remoteIssue.fields)) {
      continue;
    }

    const remoteValue = extractFrontmatterFieldValue({
      resolver: fieldInput.binding.resolver,
      value: input.remoteIssue.fields[fieldId]
    });
    if (remoteValue === undefined) {
      continue;
    }

    comparableFields.push({
      fieldId,
      localValue: fieldInput.value,
      remoteValue
    });
  }

  return comparableFields;
}

function collectRemoteIssueFieldIdsForPush(localIssue: PreparedLocalIssue): string[] {
  return [...new Set(localIssue.fieldInputs.map((fieldInput) => fieldInput.binding.field.id))];
}

type ResolvedMention = {
  accountId: string;
  displayName: string;
  userType?: string | undefined;
};

function buildMentionResolutionKey(input: {
  explicitIdentifier: boolean;
  identifier: string;
  label: string;
}): string {
  return `${input.explicitIdentifier ? "1" : "0"}\u0000${input.identifier}\u0000${input.label}`;
}

function looksLikeMentionAccountId(value: string): boolean {
  return value.includes(":") || /^[a-f0-9-]{20,}$/iu.test(value.trim());
}

function mapJiraAccountTypeToMentionUserType(accountType: string | undefined): string | undefined {
  return accountType?.toLowerCase() === "app" ? "APP" : undefined;
}

function toResolvedMention(user: JiraUserSummary): ResolvedMention {
  return {
    accountId: user.accountId,
    displayName: user.displayName,
    userType: mapJiraAccountTypeToMentionUserType(user.accountType)
  };
}

function selectMentionUser(
  users: JiraUserSummary[],
  input: {
    identifier: string;
    label: string;
  }
): JiraUserSummary | undefined {
  if (users.length === 0) {
    return undefined;
  }

  if (users.length === 1) {
    return users[0];
  }

  const normalizedIdentifier = normalizeUserLookupValue(input.identifier);
  const normalizedLabel = normalizeUserLookupValue(input.label);
  const exactMatches = users.filter((user) => {
    return (
      normalizeUserLookupValue(user.accountId) === normalizedIdentifier ||
      normalizeUserLookupValue(user.displayName) === normalizedIdentifier ||
      normalizeUserLookupValue(user.emailAddress) === normalizedIdentifier ||
      (normalizedLabel.length > 0 &&
        normalizeUserLookupValue(user.displayName) === normalizedLabel)
    );
  });

  return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

async function resolveMarkdownMentions(input: {
  config: AppConfig;
  jira: JiraClient;
  markdown: string;
  rememberUsers?: RememberUsers | undefined;
}): Promise<Map<string, ResolvedMention>> {
  const references = extractMarkdownMentions(input.markdown);
  const resolved = new Map<string, ResolvedMention>();

  if (references.length === 0) {
    return resolved;
  }

  const userByAccountId = new Map<string, JiraUserSummary | undefined>();
  const usersByQuery = new Map<string, JiraUserSummary[]>();

  async function getUserByAccountId(accountId: string): Promise<JiraUserSummary | undefined> {
    if (userByAccountId.has(accountId)) {
      return userByAccountId.get(accountId);
    }

    try {
      const user = await input.jira.getUser(accountId);
      userByAccountId.set(accountId, user);
      return user;
    } catch (error) {
      if (error instanceof JiraApiError && (error.status === 400 || error.status === 404)) {
        userByAccountId.set(accountId, undefined);
        return undefined;
      }
      throw error;
    }
  }

  async function searchUsers(query: string): Promise<JiraUserSummary[]> {
    if (usersByQuery.has(query)) {
      return usersByQuery.get(query) ?? [];
    }

    const users = await input.jira.searchUsers(query);
    usersByQuery.set(query, users);
    for (const user of users) {
      if (!userByAccountId.has(user.accountId)) {
        userByAccountId.set(user.accountId, user);
      }
    }
    return users;
  }

  for (const reference of references) {
    const resolutionKey = buildMentionResolutionKey(reference);
    if (resolved.has(resolutionKey)) {
      continue;
    }

    const mappedUser =
      resolveUserFromMap(input.config.userMap, reference.identifier) ??
      resolveUserFromMap(input.config.userMap, reference.label);
    if (mappedUser) {
      resolved.set(resolutionKey, {
        accountId: mappedUser.accountId,
        displayName: mappedUser.label
      });
      continue;
    }

    if (reference.explicitIdentifier && looksLikeMentionAccountId(reference.identifier)) {
      const exactUser = await getUserByAccountId(reference.identifier);
      resolved.set(
        resolutionKey,
        exactUser
          ? toResolvedMention(exactUser)
          : {
              accountId: reference.identifier,
              displayName: reference.label
            }
      );
      if (exactUser) {
        input.rememberUsers?.([exactUser]);
      }
      continue;
    }

    const candidates = await searchUsers(reference.identifier);
    const matchedUser = selectMentionUser(candidates, reference);

    if (!matchedUser) {
      if (candidates.length === 0) {
        throw new Error(
          `Could not resolve Jira mention ${reference.raw}. Use @[Display Name](accountId) for a stable mention or verify the user is searchable in Jira.`
        );
      }

      throw new Error(
        `Mention ${reference.raw} is ambiguous in Jira. Use @[Display Name](accountId) for a stable mention.`
      );
    }

    input.rememberUsers?.([matchedUser]);
    resolved.set(resolutionKey, toResolvedMention(matchedUser));
  }

  return resolved;
}

function createAttachmentPushResolvers(input: {
  attachmentState: LocalAttachmentState;
  filePath: string;
  history: SyncHistory;
  issueKey: string;
  jira: JiraClient;
  remoteAttachments: JiraIssueAttachment[];
}): {
  resolveImageBlock: (args: { href: string; label: string }) => AdfNode | undefined;
  resolveLinkHref: (args: { href: string; kind: "image" | "link"; label: string }) => string | undefined;
} {
  const attachmentByLocalPath = new Map(
    input.attachmentState.files.map((attachment) => [normalize(attachment.filePath), attachment])
  );
  const remoteIndex = buildRemoteAttachmentIndex(input.remoteAttachments);

  function resolveRemoteAttachmentForLocalFile(
    localAttachment: LocalAttachmentFile
  ): JiraIssueAttachment | undefined {
    const historyRecord = getAttachmentHistoryRecord(
      input.history,
      input.issueKey,
      localAttachment.fileName
    );
    if (historyRecord?.remoteAttachmentId) {
      const byId = remoteIndex.byId.get(historyRecord.remoteAttachmentId);
      if (byId) {
        return byId;
      }
    }

    const byName = remoteIndex.byFileName.get(localAttachment.fileName) ?? [];
    if (byName.length === 1) {
      return byName[0];
    }

    return undefined;
  }

  function resolveLocalAttachmentByHref(href: string): LocalAttachmentFile | undefined {
    if (/^[a-z]+:\/\//iu.test(href)) {
      return undefined;
    }

    const absolutePath = normalize(resolve(dirname(input.filePath), href));
    const localAttachment = attachmentByLocalPath.get(absolutePath);
    if (!localAttachment) {
      if (href.includes(".attachments/") || href.includes(".attachments\\")) {
        throw new Error(
          `Local attachment link "${href}" in ${input.filePath} does not match a file under the issue attachment directory.`
        );
      }
      return undefined;
    }

    return localAttachment;
  }

  function resolveLinkHref({ href }: { href: string; kind: "image" | "link"; label: string }): string | undefined {
    const localAttachment = resolveLocalAttachmentByHref(href);
    if (!localAttachment) {
      return undefined;
    }

    const remoteAttachment = resolveRemoteAttachmentForLocalFile(localAttachment);
    if (!remoteAttachment) {
      throw new Error(
        `Local attachment link "${href}" in ${input.filePath} could not be resolved to a Jira attachment on ${input.issueKey}.`
      );
    }

    return input.jira.getAttachmentContentUrl(remoteAttachment);
  }

  function resolveImageBlock({
    href,
    label
  }: {
    href: string;
    label: string;
  }): AdfNode | undefined {
    const localAttachment = resolveLocalAttachmentByHref(href);
    if (!localAttachment) {
      return undefined;
    }

    const historyRecord = getAttachmentHistoryRecord(
      input.history,
      input.issueKey,
      localAttachment.fileName
    );
    const remoteAttachment = resolveRemoteAttachmentForLocalFile(localAttachment);
    if (
      historyRecord?.jiraInlineImageBlock &&
      remoteAttachment?.id &&
      historyRecord.jiraInlineImageRemoteAttachmentId === remoteAttachment.id
    ) {
      const block = JSON.parse(
        JSON.stringify(historyRecord.jiraInlineImageBlock)
      ) as AdfNode;
      const mediaNode = block.content?.find((child) => child.type === "media");
      if (mediaNode) {
        mediaNode.attrs = {
          ...(mediaNode.attrs ?? {}),
          alt: label
        };
      }
      return block;
    }

    return undefined;
  }

  return {
    resolveImageBlock,
    resolveLinkHref
  };
}

async function applyResolvedDescriptionField(input: {
  attachmentState: LocalAttachmentState;
  config: AppConfig;
  document: MarkdownIssueDocument;
  fields: Record<string, unknown>;
  filePath: string;
  history: SyncHistory;
  issueKey: string;
  jira: JiraClient;
  rememberUsers?: RememberUsers | undefined;
  remoteAttachments: JiraIssueAttachment[];
}): Promise<void> {
  const descriptionSource = resolveDescriptionSource(input.document);
  if (!descriptionSource.trim()) {
    return;
  }

  const resolvedMentions = await resolveMarkdownMentions({
    config: input.config,
    jira: input.jira,
    markdown: descriptionSource,
    ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
  });
  const attachmentResolvers = createAttachmentPushResolvers({
    attachmentState: input.attachmentState,
    filePath: input.filePath,
    history: input.history,
    issueKey: input.issueKey,
    jira: input.jira,
    remoteAttachments: input.remoteAttachments
  });

  input.fields.description = markdownToAdf(descriptionSource, {
    resolveImageBlock: attachmentResolvers.resolveImageBlock,
    resolveLinkHref: attachmentResolvers.resolveLinkHref,
    resolveMention(reference) {
      return resolvedMentions.get(buildMentionResolutionKey(reference));
    }
  });
}

function getIssueTypeScopedFieldMap(
  config: AppConfig,
  projectKey: string | undefined,
  issueTypeName: string | undefined
): Record<string, FieldMappingConfig> {
  const issueTypeMaps = findRecordByKey(config.projectIssueTypeFieldMap, projectKey);
  if (!issueTypeMaps) {
    return {};
  }

  return findRecordByKey(issueTypeMaps, issueTypeName) ?? {};
}

function collectPullFieldIdsForProject(
  config: AppConfig,
  catalog: FieldCatalog,
  projectKey: string
): string[] {
  const fieldIds = new Set<string>();

  const projectIssueTypeMaps = findRecordByKey(config.projectIssueTypeFieldMap, projectKey);
  for (const [issueTypeName, sourceKeyMap] of Object.entries(projectIssueTypeMaps ?? {})) {
    for (const sourceKey of Object.keys(sourceKeyMap)) {
      const binding = tryResolveFieldBinding(sourceKey, undefined, config, catalog, {
        issueTypeName,
        projectKey
      });
      if (binding?.field.id) {
        fieldIds.add(binding.field.id);
      }
    }
  }

  for (const sourceKey of DIRECT_PULL_SOURCE_KEYS) {
    const binding = tryResolveFieldBinding(sourceKey, undefined, config, catalog, {
      projectKey
    });
    if (binding?.field.id) {
      fieldIds.add(binding.field.id);
    }
  }

  return [...fieldIds];
}

async function loadLocalAttachmentState(input: {
  filePath: string;
  issueKey?: string | undefined;
  projectKey?: string | undefined;
  rootDir: string;
}): Promise<LocalAttachmentState> {
  const projectKey =
    normalizeProjectKey(input.projectKey) ?? inferProjectKeyFromIssueKey(input.issueKey);
  const attachmentDirectory =
    input.issueKey && projectKey
      ? buildIssueAttachmentDirectory(
          input.issueKey,
          projectKey,
          process.cwd(),
          input.rootDir
        )
      : buildDraftAttachmentDirectory(input.filePath, input.rootDir);
  const files = await listLocalAttachmentFiles(attachmentDirectory);

  return {
    attachmentDirectory,
    files,
    signature: buildLocalAttachmentSignature(files)
  };
}

function planLocalAttachmentSyncToJira(input: {
  attachmentState: LocalAttachmentState;
  history: SyncHistory;
  issueKey: string;
  remoteAttachments?: JiraIssueAttachment[] | undefined;
}): PlannedAttachmentSync {
  if (input.attachmentState.files.length === 0) {
    return {
      hasMutations: false,
      operations: [],
      remoteAttachments: input.remoteAttachments ?? []
    };
  }

  const remoteAttachments = input.remoteAttachments ?? [];
  const remoteIndex = buildRemoteAttachmentIndex(remoteAttachments);
  const operations: PlannedAttachmentOperation[] = [];

  for (const localAttachment of input.attachmentState.files) {
    const historyRecord = getAttachmentHistoryRecord(
      input.history,
      input.issueKey,
      localAttachment.fileName
    );
    const matchingRemoteById = historyRecord?.remoteAttachmentId
      ? remoteIndex.byId.get(historyRecord.remoteAttachmentId)
      : undefined;
    const sameNameRemoteAttachments =
      remoteIndex.byFileName.get(localAttachment.fileName) ?? [];
    const exactSizeMatch =
      sameNameRemoteAttachments.length === 1 &&
      sameNameRemoteAttachments[0]?.size === localAttachment.size
        ? sameNameRemoteAttachments[0]
        : undefined;
    const matchedRemoteAttachment = matchingRemoteById ?? exactSizeMatch;
    const isUnchangedLocalAttachment =
      historyRecord?.sha256 === localAttachment.sha256 &&
      historyRecord.size === localAttachment.size &&
      Boolean(matchedRemoteAttachment);

    if (isUnchangedLocalAttachment) {
      operations.push({
        historyRecord,
        kind: "unchanged",
        localAttachment,
        matchedRemoteAttachment
      });
      continue;
    }

    if (!historyRecord && sameNameRemoteAttachments.length > 0) {
      throw new Error(
        `Remote attachment "${localAttachment.fileName}" already exists on ${input.issueKey} but is not tracked by jira-markdown. Pull first or rename the local attachment before pushing.`
      );
    }

    operations.push({
      deleteRemoteAttachmentId:
        historyRecord?.remoteAttachmentId && matchingRemoteById
          ? historyRecord.remoteAttachmentId
          : undefined,
      historyRecord,
      kind:
        historyRecord?.remoteAttachmentId && matchingRemoteById ? "replace" : "upload",
      localAttachment
    });
  }

  return {
    hasMutations: operations.some((operation) => operation.kind !== "unchanged"),
    operations,
    remoteAttachments
  };
}

async function applyPlannedLocalAttachmentSyncToJira(input: {
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issueKey: string;
  jira: JiraClient;
  plan: PlannedAttachmentSync;
  projectKey: string;
  pushStats: SyncCommandStats;
}): Promise<JiraIssueAttachment[]> {
  let remoteAttachments = [...input.plan.remoteAttachments];

  for (const operation of input.plan.operations) {
    const { localAttachment } = operation;

    if (operation.kind === "unchanged") {
      setAttachmentHistoryRecord(input.history, input.issueKey, localAttachment.fileName, {
        ...operation.historyRecord,
        fileName: localAttachment.fileName,
        filePath: toHistoryRelativePath(localAttachment.filePath),
        issueKey: input.issueKey,
        mtimeMs: localAttachment.mtimeMs,
        projectKey: input.projectKey,
        remoteAttachmentId: operation.matchedRemoteAttachment?.id,
        remoteCreatedAt: operation.matchedRemoteAttachment?.created,
        remoteSize: operation.matchedRemoteAttachment?.size,
        sha256: localAttachment.sha256,
        size: localAttachment.size
      });
      input.pushStats.skippedUnchangedAttachments += 1;
      continue;
    }

    if (operation.kind === "replace" && operation.deleteRemoteAttachmentId && !input.dryRun) {
      await input.jira.deleteAttachment(operation.deleteRemoteAttachmentId);
      remoteAttachments = remoteAttachments.filter(
        (attachment) => attachment.id !== operation.deleteRemoteAttachmentId
      );
    }

    if (input.dryRun) {
      console.log(
        `[DRY RUN] ATTACHMENT UPLOAD ${input.issueKey} <- ${localAttachment.filePath}`
      );
      continue;
    }

    const uploadedAttachments = await input.jira.uploadIssueAttachment(
      input.issueKey,
      localAttachment.fileName,
      await readFile(localAttachment.filePath)
    );
    const uploadedAttachment =
      uploadedAttachments.find(
        (attachment) =>
          sanitizeAttachmentFileName(attachment.filename) === localAttachment.fileName
      ) ?? uploadedAttachments[0];

    if (!uploadedAttachment) {
      throw new Error(
        `Jira did not return attachment metadata after uploading ${localAttachment.fileName} to ${input.issueKey}.`
      );
    }

    setAttachmentHistoryRecord(input.history, input.issueKey, localAttachment.fileName, {
      fileName: localAttachment.fileName,
      filePath: toHistoryRelativePath(localAttachment.filePath),
      issueKey: input.issueKey,
      lastUploadedAt: input.pushStats.ranAt,
      mtimeMs: localAttachment.mtimeMs,
      projectKey: input.projectKey,
      remoteAttachmentId: uploadedAttachment.id,
      remoteCreatedAt: uploadedAttachment.created,
      remoteSize: uploadedAttachment.size,
      sha256: localAttachment.sha256,
      size: localAttachment.size
    });
    input.pushStats.uploadedAttachments += 1;

    remoteAttachments = [
      ...remoteAttachments.filter((attachment) => attachment.id !== uploadedAttachment.id),
      uploadedAttachment
    ];

    console.log(`[ATTACHMENT UPLOAD] ${input.issueKey} <- ${localAttachment.filePath}`);
  }

  return remoteAttachments;
}

async function syncLocalAttachmentsToJira(input: {
  attachmentState: LocalAttachmentState;
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issueKey: string;
  jira: JiraClient;
  projectKey: string;
  pushStats: SyncCommandStats;
  remoteAttachments?: JiraIssueAttachment[] | undefined;
}): Promise<JiraIssueAttachment[]> {
  const remoteAttachments =
    input.remoteAttachments ?? (await input.jira.getIssueAttachments(input.issueKey));

  return applyPlannedLocalAttachmentSyncToJira({
    dryRun: input.dryRun,
    history: input.history,
    issueKey: input.issueKey,
    jira: input.jira,
    plan: planLocalAttachmentSyncToJira({
      attachmentState: input.attachmentState,
      history: input.history,
      issueKey: input.issueKey,
      remoteAttachments
    }),
    projectKey: input.projectKey,
    pushStats: input.pushStats
  });
}

async function syncRemoteAttachmentsToLocal(input: {
  attachments: JiraIssueAttachment[];
  dryRun?: boolean | undefined;
  existingLocalAttachments: LocalAttachmentFile[];
  history: SyncHistory;
  issueKey: string;
  jira: JiraClient;
  projectKey: string;
  pullStats: SyncCommandStats;
  rootDir: string;
  resolvedFileNamesByAttachmentId: Map<string, string>;
}): Promise<string> {
  const attachmentDirectory = buildIssueAttachmentDirectory(
    input.issueKey,
    input.projectKey,
    process.cwd(),
    input.rootDir
  );
  const currentLocalAttachments = input.existingLocalAttachments;
  const currentLocalByFileName = new Map(
    currentLocalAttachments.map((attachment) => [attachment.fileName, attachment])
  );

  for (const attachment of input.attachments) {
    const localFileName = input.resolvedFileNamesByAttachmentId.get(attachment.id);
    if (!localFileName) {
      continue;
    }

    const targetPath = buildIssueAttachmentFilePath(
      input.issueKey,
      input.projectKey,
      localFileName,
      process.cwd(),
      input.rootDir
    );
    const localAttachment = currentLocalByFileName.get(localFileName);
    const localHistoryRecord = getAttachmentHistoryRecord(
      input.history,
      input.issueKey,
      localFileName
    );

    if (
      localAttachment &&
      localHistoryRecord?.remoteAttachmentId === attachment.id &&
      localHistoryRecord.remoteSize === attachment.size &&
      localHistoryRecord.remoteCreatedAt === attachment.created &&
      localHistoryRecord.sha256 === localAttachment.sha256 &&
      localHistoryRecord.filePath === toHistoryRelativePath(targetPath)
    ) {
      input.pullStats.skippedUnchangedAttachments += 1;
      continue;
    }

    if (input.dryRun) {
      console.log(`[DRY RUN] ATTACHMENT PULL ${input.issueKey} -> ${targetPath}`);
      continue;
    }

    await writeAttachmentFile(
      targetPath,
      await input.jira.downloadAttachmentContent(attachment.id)
    );
    input.pullStats.downloadedAttachments += 1;
    console.log(`[ATTACHMENT PULL] ${input.issueKey} -> ${targetPath}`);
  }

  const finalLocalAttachments = await listLocalAttachmentFiles(attachmentDirectory);
  const finalLocalByFileName = new Map(
    finalLocalAttachments.map((attachment) => [attachment.fileName, attachment])
  );

  for (const attachment of input.attachments) {
    const localFileName = input.resolvedFileNamesByAttachmentId.get(attachment.id);
    if (!localFileName) {
      continue;
    }

    const localAttachment = finalLocalByFileName.get(localFileName);
    if (!localAttachment) {
      continue;
    }

    setAttachmentHistoryRecord(input.history, input.issueKey, localFileName, {
      fileName: localFileName,
      filePath: toHistoryRelativePath(localAttachment.filePath),
      issueKey: input.issueKey,
      lastDownloadedAt: input.pullStats.ranAt,
      mtimeMs: localAttachment.mtimeMs,
      projectKey: input.projectKey,
      remoteAttachmentId: attachment.id,
      remoteCreatedAt: attachment.created,
      remoteSize: attachment.size,
      sha256: localAttachment.sha256,
      size: localAttachment.size
    });
  }

  return buildLocalAttachmentSignature(finalLocalAttachments);
}

async function planLocalIssueUpdate(input: {
  config: AppConfig;
  history: SyncHistory;
  jira: JiraClient;
  localIssue: PreparedLocalIssue;
  rememberUsers?: RememberUsers | undefined;
  remoteIssue: JiraIssueRecord;
}): Promise<PlannedLocalIssueUpdate> {
  const issueKey = input.localIssue.core.issueKey;
  if (!issueKey) {
    throw new Error(`Cannot plan an update for ${input.localIssue.filePath} without an issue key.`);
  }

  const finalProjectKey =
    input.localIssue.mappingScope.projectKey ??
    input.localIssue.core.projectKey ??
    normalizeProjectKey(input.remoteIssue.fields.project?.key) ??
    inferProjectKeyFromIssueKey(issueKey);
  const attachmentPlan = planLocalAttachmentSyncToJira({
    attachmentState: input.localIssue.currentAttachmentState,
    history: input.history,
    issueKey,
    remoteAttachments: input.remoteIssue.fields.attachment ?? []
  });
  const plannedStatus = planDesiredIssueStatus(input.localIssue, input.remoteIssue);

  if (attachmentPlan.hasMutations) {
    return {
      attachmentPlan,
      finalProjectKey,
      hasPendingWrites: true,
      plannedStatus
    };
  }

  const editableFields = await input.jira.getEditFields(issueKey);
  const plannedFields = await resolvePreparedLocalIssueFields({
    config: input.config,
    jira: input.jira,
    localIssue: input.localIssue,
    operationFields: editableFields,
    ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
  });
  await applyResolvedDescriptionField({
    attachmentState: input.localIssue.currentAttachmentState,
    config: input.config,
    document: input.localIssue.document,
    fields: plannedFields,
    filePath: input.localIssue.filePath,
    history: input.history,
    issueKey,
    jira: input.jira,
    remoteAttachments: input.remoteIssue.fields.attachment ?? [],
    ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
  });

  const descriptionProjectKey =
    inferProjectKeyFromFilePath(input.localIssue.filePath, input.config.dir) ?? finalProjectKey;
  pruneUnchangedUpdateFields({
    comparableFields: buildComparableResolvedFieldValues({
      fieldInputs: input.localIssue.fieldInputs,
      remoteIssue: input.remoteIssue
    }),
    fields: plannedFields,
    localDescriptionMarkdown: resolveDescriptionSource(input.localIssue.document),
    remoteAssigneeAccountId: input.remoteIssue.fields.assignee?.accountId ?? undefined,
    remoteDescriptionMarkdown: descriptionProjectKey
      ? renderRemoteIssueDescriptionMarkdown({
          config: input.config,
          existingLocalAttachments: input.localIssue.currentAttachmentState.files,
          history: input.history,
          issue: input.remoteIssue,
          markdownFilePath: input.localIssue.filePath,
          projectKey: descriptionProjectKey,
          rootDir: input.config.dir,
          ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
        })
      : undefined,
    remoteLabels: input.remoteIssue.fields.labels ?? undefined,
    remoteParentKey: input.remoteIssue.fields.parent?.key ?? undefined,
    remoteSummary: input.remoteIssue.fields.summary ?? undefined
  });
  await ensureHierarchyParentValid({
    action: "update",
    fields: plannedFields,
    filePath: input.localIssue.filePath,
    isSubtask: Boolean(input.remoteIssue.fields.issuetype?.subtask),
    issueKey,
    issueTypeName: input.remoteIssue.fields.issuetype?.name ?? undefined,
    jira: input.jira,
    operationFields: editableFields,
    projectKey:
      normalizeProjectKey(input.remoteIssue.fields.project?.key) ??
      finalProjectKey ??
      inferProjectKeyFromIssueKey(issueKey)
  });

  return {
    attachmentPlan,
    editableFields,
    finalProjectKey,
    hasPendingWrites: Object.keys(plannedFields).length > 0 || Boolean(plannedStatus),
    plannedFields,
    plannedStatus
  };
}

async function applyLocalIssueUpdateToJira(input: {
  catalog: FieldCatalog;
  config: AppConfig;
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issueKeyField: string;
  jira: JiraClient;
  localIssue: PreparedLocalIssue;
  localIssueIndex: Map<string, LocalIssueRecord>;
  plannedUpdate: PlannedLocalIssueUpdate;
  rememberUsers?: RememberUsers | undefined;
  remoteIssue: JiraIssueRecord;
  resultAction: "keep-local" | "update";
  stats: SyncCommandStats;
}): Promise<SyncFileResult> {
  const issueKey = input.localIssue.core.issueKey;
  if (!issueKey) {
    throw new Error(`Cannot update ${input.localIssue.filePath} without an issue key.`);
  }

  let remoteAttachments =
    input.remoteIssue.fields.attachment ?? (await input.jira.getIssueAttachments(issueKey));
  let editableFields = input.plannedUpdate.editableFields;
  let plannedStatus = input.plannedUpdate.plannedStatus;
  let fields =
    input.plannedUpdate.plannedFields !== undefined
      ? { ...input.plannedUpdate.plannedFields }
      : { ...input.localIssue.fields };

  remoteAttachments = await applyPlannedLocalAttachmentSyncToJira({
    dryRun: input.dryRun,
    history: input.history,
    issueKey,
    jira: input.jira,
    plan: input.plannedUpdate.attachmentPlan,
    projectKey:
      input.plannedUpdate.finalProjectKey ?? inferProjectKeyFromIssueKey(issueKey) ?? "",
    pushStats: input.stats
  });

  if (input.plannedUpdate.plannedFields === undefined) {
    editableFields = await input.jira.getEditFields(issueKey);
    fields = await resolvePreparedLocalIssueFields({
      config: input.config,
      jira: input.jira,
      localIssue: input.localIssue,
      operationFields: editableFields,
      ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
    });
    await applyResolvedDescriptionField({
      attachmentState: input.localIssue.currentAttachmentState,
      config: input.config,
      document: input.localIssue.document,
      fields,
      filePath: input.localIssue.filePath,
      history: input.history,
      issueKey,
      jira: input.jira,
      remoteAttachments,
      ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
    });

    const descriptionProjectKey =
      inferProjectKeyFromFilePath(input.localIssue.filePath, input.config.dir) ??
      input.plannedUpdate.finalProjectKey;
    pruneUnchangedUpdateFields({
      comparableFields: buildComparableResolvedFieldValues({
        fieldInputs: input.localIssue.fieldInputs,
        remoteIssue: input.remoteIssue
      }),
      fields,
      localDescriptionMarkdown: resolveDescriptionSource(input.localIssue.document),
      remoteAssigneeAccountId: input.remoteIssue.fields.assignee?.accountId ?? undefined,
      remoteDescriptionMarkdown: descriptionProjectKey
        ? renderRemoteIssueDescriptionMarkdown({
            config: input.config,
            existingLocalAttachments: input.localIssue.currentAttachmentState.files,
            history: input.history,
            issue: {
              ...input.remoteIssue,
              fields: {
                ...input.remoteIssue.fields,
                attachment: remoteAttachments
              }
            },
            markdownFilePath: input.localIssue.filePath,
            projectKey: descriptionProjectKey,
            rootDir: input.config.dir,
            ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
          })
        : undefined,
      remoteLabels: input.remoteIssue.fields.labels ?? undefined,
      remoteParentKey: input.remoteIssue.fields.parent?.key ?? undefined,
      remoteSummary: input.remoteIssue.fields.summary ?? undefined
    });
    await ensureHierarchyParentValid({
      action: "update",
      fields,
      filePath: input.localIssue.filePath,
      isSubtask: Boolean(input.remoteIssue.fields.issuetype?.subtask),
      issueKey,
      issueTypeName: input.remoteIssue.fields.issuetype?.name ?? undefined,
      jira: input.jira,
      operationFields: editableFields,
      projectKey:
        normalizeProjectKey(input.remoteIssue.fields.project?.key) ??
        input.plannedUpdate.finalProjectKey ??
        inferProjectKeyFromIssueKey(issueKey)
    });
    plannedStatus ??= planDesiredIssueStatus(input.localIssue, input.remoteIssue);
  }

  const targetFilePath =
    input.plannedUpdate.finalProjectKey
      ? buildCanonicalIssueFilePath(
          issueKey,
          input.localIssue.core.summary,
          input.plannedUpdate.finalProjectKey,
          process.cwd(),
          input.config.dir
        )
      : input.localIssue.filePath;
  const actionLabel = input.resultAction === "keep-local" ? "KEEP-LOCAL" : "UPDATE";

  if (input.dryRun) {
    console.log(`[DRY RUN] ${actionLabel} ${targetFilePath}`);
    console.log(
      JSON.stringify(
        {
          issueKey,
          fields,
          ...(plannedStatus ? { status: plannedStatus } : {})
        },
        null,
        2
      )
    );
    return {
      action: input.resultAction,
      filePath: targetFilePath,
      issueKey,
      summary: input.localIssue.core.summary
    };
  }

  let remoteWritesPerformed = input.plannedUpdate.attachmentPlan.hasMutations;
  if (Object.keys(fields).length > 0) {
    await ensureAssigneeIsAssignable(issueKey, fields, input.jira);
    editableFields = await ensureIssueFieldsEditable(
      issueKey,
      fields,
      input.jira,
      input.catalog,
      editableFields
    );
    try {
      await input.jira.updateIssue(issueKey, fields);
    } catch (error) {
      wrapJiraWriteError({
        action: "update",
        error,
        fields,
        filePath: targetFilePath,
        issueKey
      });
    }
    remoteWritesPerformed = true;
  }
  if (plannedStatus) {
    await transitionIssueToStatus({
      action: "update",
      currentStatusName: getRemoteIssueStatusName(input.remoteIssue),
      filePath: targetFilePath,
      issueKey,
      jira: input.jira,
      status: plannedStatus
    });
    remoteWritesPerformed = true;
  }

  let finalFilePath = input.localIssue.filePath;
  const finalProjectKey =
    input.plannedUpdate.finalProjectKey ??
    inferProjectKeyFromFilePath(finalFilePath, input.config.dir) ??
    inferProjectKeyFromIssueKey(issueKey);
  if (finalProjectKey) {
    finalFilePath = await moveLocalIssueToCanonicalPath({
      currentPath: input.localIssue.filePath,
      issueKey,
      issueKeyField: input.issueKeyField,
      projectKey: finalProjectKey,
      rootDir: input.config.dir,
      summary: input.localIssue.core.summary
    });
    if (finalFilePath !== input.localIssue.filePath) {
      deleteFileHistoryRecord(input.history, input.localIssue.filePath);
    }

    const currentAttachmentProjectKey =
      inferProjectKeyFromFilePath(input.localIssue.filePath, input.config.dir) ??
      inferProjectKeyFromIssueKey(issueKey);
    if (currentAttachmentProjectKey && currentAttachmentProjectKey !== finalProjectKey) {
      const currentAttachmentDirectory = buildIssueAttachmentDirectory(
        issueKey,
        currentAttachmentProjectKey,
        process.cwd(),
        input.config.dir
      );
      const nextAttachmentDirectory = await moveIssueAttachmentDirectory({
        fromProjectKey: currentAttachmentProjectKey,
        issueKey,
        rootDir: input.config.dir,
        toProjectKey: finalProjectKey
      });
      if (currentAttachmentDirectory !== nextAttachmentDirectory) {
        rewriteAttachmentHistoryPathsForIssue(
          input.history,
          issueKey,
          currentAttachmentDirectory,
          nextAttachmentDirectory
        );
      }
    }
  }

  const finalRemoteIssue = remoteWritesPerformed
    ? await input.jira.getIssue(issueKey)
    : input.remoteIssue;
  const finalAttachmentState = await loadLocalAttachmentState({
    filePath: finalFilePath,
    issueKey,
    projectKey: finalProjectKey,
    rootDir: input.config.dir
  });
  const finalFileStats = await stat(finalFilePath);
  recordSyncedIssueState({
    fileMtimeMs: finalFileStats.mtimeMs,
    filePath: finalFilePath,
    history: input.history,
    issueKey,
    localAttachmentSignature: finalAttachmentState.signature,
    projectKey: finalProjectKey,
    remoteAttachmentSignature: buildRemoteAttachmentSignature(
      finalRemoteIssue.fields.attachment ?? remoteAttachments
    ),
    remoteUpdatedAt: finalRemoteIssue.fields.updated ?? undefined,
    summary: input.localIssue.core.summary,
    syncedAt: input.stats.ranAt
  });

  input.localIssueIndex.set(issueKey, {
    document: {
      ...input.localIssue.document,
      filePath: finalFilePath
    },
    filePath: finalFilePath,
    issueKey,
    mtimeMs: finalFileStats.mtimeMs,
    projectKey: finalProjectKey
  });
  input.stats.updated += 1;

  console.log(`[${actionLabel}] ${issueKey} <- ${finalFilePath}`);
  return {
    action: input.resultAction,
    filePath: finalFilePath,
    issueKey,
    summary: input.localIssue.core.summary
  };
}

async function applyLocalIssueCreateToJira(input: {
  config: AppConfig;
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issueKeyField: string;
  jira: JiraClient;
  localIssue: PreparedLocalIssue;
  localIssueIndex: Map<string, LocalIssueRecord>;
  rememberUsers?: RememberUsers | undefined;
  stats: SyncCommandStats;
  writeBack?: boolean | undefined;
}): Promise<SyncFileResult> {
  const createContext = await loadCreateContextForLocalIssue(input.localIssue, input.jira);
  const resolvedCreateFields = await resolvePreparedLocalIssueFields({
    config: input.config,
    jira: input.jira,
    localIssue: input.localIssue,
    operationFields: createContext.createFields,
    ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
  });
  await ensureHierarchyParentValid({
    action: "create",
    fields: resolvedCreateFields,
    filePath: input.localIssue.filePath,
    isSubtask: createContext.issueType.subtask,
    issueTypeName: createContext.issueType.name,
    jira: input.jira,
    operationFields: createContext.createFields,
    projectKey: createContext.projectKey
  });

  if (input.dryRun) {
    console.log(`[DRY RUN] CREATE ${input.localIssue.filePath}`);
    console.log(JSON.stringify({ issueKey: undefined, fields: resolvedCreateFields }, null, 2));
    return {
      action: "create",
      filePath: input.localIssue.filePath,
      summary: input.localIssue.core.summary
    };
  }

  let created: { id: string; key: string };
  try {
    created = await input.jira.createIssue(resolvedCreateFields);
  } catch (error) {
    wrapJiraWriteError({
      action: "create",
      error,
      fields: resolvedCreateFields,
      filePath: input.localIssue.filePath
    });
  }

  let updatedDocument = input.localIssue.document;
  let finalFilePath = input.localIssue.filePath;
  const shouldWriteBack = input.writeBack ?? true;

  if (shouldWriteBack) {
    await writeIssueKeyToFrontmatter(updatedDocument, input.issueKeyField, created.key);
    updatedDocument = await loadMarkdownDocument(input.localIssue.filePath);
  }

  const finalProjectKey =
    input.localIssue.mappingScope.projectKey ??
    input.localIssue.core.projectKey ??
    inferProjectKeyFromIssueKey(created.key);
  if (finalProjectKey) {
    finalFilePath = await moveLocalIssueToCanonicalPath({
      currentPath: input.localIssue.filePath,
      issueKey: created.key,
      issueKeyField: input.issueKeyField,
      projectKey: finalProjectKey,
      rootDir: input.config.dir,
      summary: input.localIssue.core.summary
    });
    updatedDocument = {
      ...updatedDocument,
      filePath: finalFilePath
    };
    if (finalFilePath !== input.localIssue.filePath) {
      deleteFileHistoryRecord(input.history, input.localIssue.filePath);
    }

    await promoteDraftAttachmentDirectory({
      filePath: input.localIssue.filePath,
      issueKey: created.key,
      projectKey: finalProjectKey,
      rootDir: input.config.dir
    });
    const finalAttachmentState = await loadLocalAttachmentState({
      filePath: finalFilePath,
      issueKey: created.key,
      projectKey: finalProjectKey,
      rootDir: input.config.dir
    });
    const remoteAttachments = await syncLocalAttachmentsToJira({
      attachmentState: finalAttachmentState,
      history: input.history,
      issueKey: created.key,
      jira: input.jira,
      projectKey: finalProjectKey,
      pushStats: input.stats,
      remoteAttachments: []
    });
    const descriptionFields: Record<string, unknown> = {};
    await applyResolvedDescriptionField({
      attachmentState: finalAttachmentState,
      config: input.config,
      document: updatedDocument,
      fields: descriptionFields,
      filePath: finalFilePath,
      history: input.history,
      issueKey: created.key,
      jira: input.jira,
      remoteAttachments,
      ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
    });
    if (descriptionFields.description) {
      await input.jira.updateIssue(created.key, descriptionFields);
    }
  }

  let finalRemoteIssue = await input.jira.getIssue(created.key);
  const desiredStatus = asTrimmedString(input.localIssue.core.status);
  if (
    desiredStatus &&
    normalizeLookupKey(desiredStatus) !==
      normalizeLookupKey(getRemoteIssueStatusName(finalRemoteIssue) ?? "")
  ) {
    await transitionIssueToStatus({
      action: "create",
      currentStatusName: getRemoteIssueStatusName(finalRemoteIssue),
      filePath: finalFilePath,
      issueKey: created.key,
      jira: input.jira,
      status: desiredStatus
    });
    finalRemoteIssue = await input.jira.getIssue(created.key);
  }
  const finalAttachmentState = await loadLocalAttachmentState({
    filePath: finalFilePath,
    issueKey: created.key,
    projectKey: finalProjectKey,
    rootDir: input.config.dir
  });
  const finalFileStats = await stat(finalFilePath);
  recordSyncedIssueState({
    fileMtimeMs: finalFileStats.mtimeMs,
    filePath: finalFilePath,
    history: input.history,
    issueKey: created.key,
    localAttachmentSignature: finalAttachmentState.signature,
    projectKey: finalProjectKey,
    remoteAttachmentSignature: buildRemoteAttachmentSignature(
      finalRemoteIssue.fields.attachment ?? []
    ),
    remoteUpdatedAt: finalRemoteIssue.fields.updated ?? undefined,
    summary: input.localIssue.core.summary,
    syncedAt: input.stats.ranAt
  });

  input.localIssueIndex.set(created.key, {
    document: updatedDocument,
    filePath: finalFilePath,
    issueKey: created.key,
    mtimeMs: finalFileStats.mtimeMs,
    projectKey: finalProjectKey
  });
  input.stats.created += 1;

  console.log(`[CREATE] ${created.key} <- ${finalFilePath}`);
  return {
    action: "create",
    filePath: finalFilePath,
    issueKey: created.key,
    summary: input.localIssue.core.summary
  };
}

function buildPulledMappedFrontmatter(input: {
  catalog: FieldCatalog;
  config: AppConfig;
  issue: JiraIssueRecord;
  issueTypeName?: string | undefined;
  projectKey?: string | undefined;
}): Record<string, unknown> {
  const scopedFieldMap = getIssueTypeScopedFieldMap(
    input.config,
    input.projectKey,
    input.issueTypeName
  );
  const extraFrontmatter: Record<string, unknown> = {};
  const handledFieldIds = new Set<string>();

  for (const sourceKey of Object.keys(scopedFieldMap).sort((left, right) => left.localeCompare(right))) {
    if (sourceKey === "sprint") {
      continue;
    }

    const binding = tryResolveFieldBinding(sourceKey, undefined, input.config, input.catalog, {
      issueTypeName: input.issueTypeName,
      projectKey: input.projectKey
    });
    if (!binding || !(binding.field.id in input.issue.fields)) {
      continue;
    }

    const extractedValue = extractFrontmatterFieldValue({
      resolver: binding.resolver,
      value: input.issue.fields[binding.field.id]
    });
    if (extractedValue === undefined) {
      continue;
    }

    if (Array.isArray(extractedValue) && extractedValue.length === 0) {
      continue;
    }

    extraFrontmatter[sourceKey] = extractedValue;
    handledFieldIds.add(binding.field.id);
  }

  for (const sourceKey of DIRECT_PULL_SOURCE_KEYS) {
    const binding = tryResolveFieldBinding(sourceKey, undefined, input.config, input.catalog, {
      issueTypeName: input.issueTypeName,
      projectKey: input.projectKey
    });
    if (!binding || handledFieldIds.has(binding.field.id) || !(binding.field.id in input.issue.fields)) {
      continue;
    }

    const extractedValue = extractFrontmatterFieldValue({
      resolver: binding.resolver,
      value: input.issue.fields[binding.field.id]
    });
    if (extractedValue === undefined) {
      continue;
    }

    if (Array.isArray(extractedValue) && extractedValue.length === 0) {
      continue;
    }

    extraFrontmatter[sourceKey] = extractedValue;
  }

  return extraFrontmatter;
}

async function applyRemoteIssueToLocal(input: {
  catalog: FieldCatalog;
  config: AppConfig;
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issue: JiraIssueRecord;
  issueKeyField: string;
  jira: JiraClient;
  localIssueIndex: Map<string, LocalIssueRecord>;
  rememberUsers?: RememberUsers | undefined;
  resultAction: "keep-jira" | "pull";
  stats: SyncCommandStats;
}): Promise<SyncFileResult> {
  const summary = input.issue.fields.summary?.trim() || input.issue.key;
  const projectKey =
    normalizeProjectKey(input.issue.fields.project?.key) ??
    inferProjectKeyFromIssueKey(input.issue.key);
  const issueTypeName = input.issue.fields.issuetype?.name ?? undefined;
  const targetPath =
    projectKey
      ? buildCanonicalIssueFilePath(
          input.issue.key,
          summary,
          projectKey,
          process.cwd(),
          input.config.dir
        )
      : input.localIssueIndex.get(input.issue.key)?.filePath ?? resolve(process.cwd(), input.config.dir, `${input.issue.key}.md`);
  const existingRecord = input.localIssueIndex.get(input.issue.key);
  const remoteAttachments = input.issue.fields.attachment ?? [];
  const currentAttachmentState = await loadLocalAttachmentState({
    filePath: targetPath,
    issueKey: input.issue.key,
    projectKey,
    rootDir: input.config.dir
  });
  const resolvedFileNamesByAttachmentId = resolvePulledAttachmentFileNames({
    attachments: remoteAttachments,
    existingLocalAttachments: currentAttachmentState.files,
    history: input.history,
    issueKey: input.issue.key
  });
  const attachmentMarkdownResolvers = createAttachmentMarkdownResolvers({
    attachments: remoteAttachments,
    issueKey: input.issue.key,
    markdownFilePath: targetPath,
    projectKey: projectKey ?? inferProjectKeyFromIssueKey(input.issue.key) ?? "",
    rootDir: input.config.dir,
    resolvedFileNamesByAttachmentId
  });
  const actionLabel = input.resultAction === "keep-jira" ? "KEEP-JIRA" : "PULL";

  if (input.dryRun) {
    console.log(`[DRY RUN] ${actionLabel} ${input.issue.key} -> ${targetPath}`);
    return {
      action: input.resultAction,
      filePath: targetPath,
      issueKey: input.issue.key,
      summary
    };
  }

  const body = adfToMarkdown(input.issue.fields.description, {
    ...attachmentMarkdownResolvers,
    resolveMention: createMentionMarkdownResolver({
      config: input.config,
      ...(input.rememberUsers ? { rememberUsers: input.rememberUsers } : {})
    })
  });
  const sprintBinding =
    projectKey
      ? tryResolveFieldBinding("sprint", undefined, input.config, input.catalog, {
          issueTypeName,
          projectKey
        })
      : undefined;
  const sprint =
    sprintBinding && sprintBinding.field.id in input.issue.fields
      ? (() => {
          const extractedSprint = extractFrontmatterFieldValue({
            resolver: sprintBinding.resolver,
            value: input.issue.fields[sprintBinding.field.id]
          });
          return typeof extractedSprint === "string" || typeof extractedSprint === "number"
            ? extractedSprint
            : undefined;
        })()
      : undefined;
  const extraFrontmatter = buildPulledMappedFrontmatter({
    catalog: input.catalog,
    config: input.config,
    issue: input.issue,
    issueTypeName,
    projectKey
  });
  if (input.issue.fields.assignee?.accountId && input.issue.fields.assignee.displayName) {
    input.rememberUsers?.([
      {
        accountId: input.issue.fields.assignee.accountId,
        displayName: input.issue.fields.assignee.displayName
      }
    ]);
  }
  const content = formatPulledIssueMarkdown({
    assignee: resolvePreferredUserLabel(
      input.config.userMap,
      input.issue.fields.assignee?.accountId ?? undefined,
      input.issue.fields.assignee?.displayName ?? undefined
    ),
    body,
    extraFrontmatter,
    issueKey: input.issue.key,
    issueKeyField: input.issueKeyField,
    issueTypeName,
    labels: input.issue.fields.labels ?? [],
    parent: input.issue.fields.parent?.key ?? undefined,
    sprint,
    status: getRemoteIssueStatusName(input.issue),
    summary
  });

  const finalPath = await writeIssueFileToCanonicalPath({
    content,
    currentPath: existingRecord?.filePath,
    issueKey: input.issue.key,
    issueKeyField: input.issueKeyField,
    targetPath
  });
  if (existingRecord?.filePath && existingRecord.filePath !== finalPath) {
    deleteFileHistoryRecord(input.history, existingRecord.filePath);
  }

  if (existingRecord?.projectKey && projectKey && existingRecord.projectKey !== projectKey) {
    const previousAttachmentDirectory = buildIssueAttachmentDirectory(
      input.issue.key,
      existingRecord.projectKey,
      process.cwd(),
      input.config.dir
    );
    const nextAttachmentDirectory = await moveIssueAttachmentDirectory({
      fromProjectKey: existingRecord.projectKey,
      issueKey: input.issue.key,
      rootDir: input.config.dir,
      toProjectKey: projectKey
    });
    if (previousAttachmentDirectory !== nextAttachmentDirectory) {
      rewriteAttachmentHistoryPathsForIssue(
        input.history,
        input.issue.key,
        previousAttachmentDirectory,
        nextAttachmentDirectory
      );
    }
  }

  const finalLocalAttachmentSignature = await syncRemoteAttachmentsToLocal({
    attachments: remoteAttachments,
    existingLocalAttachments: currentAttachmentState.files,
    history: input.history,
    issueKey: input.issue.key,
    jira: input.jira,
    projectKey: projectKey ?? inferProjectKeyFromIssueKey(input.issue.key) ?? "",
    pullStats: input.stats,
    rootDir: input.config.dir,
    resolvedFileNamesByAttachmentId
  });
  collectPulledInlineImageBlocks({
    description: input.issue.fields.description,
    history: input.history,
    issueKey: input.issue.key,
    resolvers: attachmentMarkdownResolvers
  });
  const finalFileStats = await stat(finalPath);
  recordSyncedIssueState({
    fileMtimeMs: finalFileStats.mtimeMs,
    filePath: finalPath,
    history: input.history,
    issueKey: input.issue.key,
    localAttachmentSignature: finalLocalAttachmentSignature,
    projectKey,
    remoteAttachmentSignature: buildRemoteAttachmentSignature(remoteAttachments),
    remoteUpdatedAt: input.issue.fields.updated ?? undefined,
    summary,
    syncedAt: input.stats.ranAt
  });

  input.localIssueIndex.set(input.issue.key, {
    document: {
      body,
      filePath: finalPath,
      frontmatter: {
        [input.issueKeyField]: input.issue.key,
        ...(input.issue.fields.issuetype?.name
          ? { issueType: input.issue.fields.issuetype.name }
          : {}),
        ...(getRemoteIssueStatusName(input.issue)
          ? { status: getRemoteIssueStatusName(input.issue) }
          : {}),
        ...(sprint !== undefined ? { sprint } : {}),
        ...extraFrontmatter,
        ...(input.issue.fields.labels?.length ? { labels: input.issue.fields.labels } : {}),
        summary
      },
      raw: content
    },
    filePath: finalPath,
    issueKey: input.issue.key,
    mtimeMs: finalFileStats.mtimeMs,
    projectKey
  });
  input.stats.pulled += 1;

  console.log(`[${actionLabel}] ${input.issue.key} -> ${finalPath}`);
  return {
    action: input.resultAction,
    filePath: finalPath,
    issueKey: input.issue.key,
    summary
  };
}

async function executePush(input: PushExecutionContext & {
  dryRun?: boolean | undefined;
  writeBack?: boolean | undefined;
}): Promise<PushExecutionResult> {
  const pushedIssueKeys = new Set<string>();
  const results: SyncFileResult[] = [];

  for (const filePath of input.files) {
    const localIssue = await prepareLocalIssueForPush({
      catalog: input.catalog,
      config: input.config,
      dryRun: input.dryRun,
      filePath,
      issueKeyField: input.issueKeyField,
      jira: input.jira,
      rememberUsers: input.rememberUsers
    });
    addProjectKey(
      input.projectKeys,
      localIssue.mappingScope.projectKey ?? localIssue.core.projectKey
    );

    if (
      shouldSkipPushByHistory({
        attachmentSignature: localIssue.currentAttachmentState.signature,
        filePath,
        history: input.history,
        issueKey: localIssue.core.issueKey,
        mtimeMs: localIssue.currentFileMtimeMs
      })
    ) {
      input.pushStats.skippedUnchanged += 1;
      results.push({
        action: "skip",
        filePath,
        issueKey: localIssue.core.issueKey,
        summary: localIssue.core.summary
      });
      continue;
    }

    if (localIssue.action === "create" && !input.config.sync.createMissing) {
      input.pushStats.skippedPolicy += 1;
      results.push({
        action: "skip",
        filePath,
        summary: localIssue.core.summary
      });
      continue;
    }

    if (localIssue.action === "update" && !input.config.sync.updateExisting) {
      input.pushStats.skippedPolicy += 1;
      results.push({
        action: "skip",
        filePath,
        issueKey: localIssue.core.issueKey,
        summary: localIssue.core.summary
      });
      continue;
    }

    if (localIssue.action === "create") {
      const result = await applyLocalIssueCreateToJira({
        config: input.config,
        dryRun: input.dryRun,
        history: input.history,
        issueKeyField: input.issueKeyField,
        jira: input.jira,
        localIssue,
        localIssueIndex: input.localIssueIndex,
        rememberUsers: input.rememberUsers,
        stats: input.pushStats,
        writeBack: input.writeBack
      });
      if (result.issueKey) {
        pushedIssueKeys.add(result.issueKey);
      }
      results.push(result);
      continue;
    }

    const issueKey = localIssue.core.issueKey as string;
    const remoteIssue = await input.jira.getIssue(
      issueKey,
      collectRemoteIssueFieldIdsForPush(localIssue)
    );
    const plannedUpdate = await planLocalIssueUpdate({
      config: input.config,
      history: input.history,
      jira: input.jira,
      localIssue,
      rememberUsers: input.rememberUsers,
      remoteIssue
    });
    const remoteAttachmentSignature = buildRemoteAttachmentSignature(
      remoteIssue.fields.attachment ?? []
    );
    const remoteChanged = hasRemoteIssueChanges({
      history: input.history,
      issueKey,
      remoteAttachmentSignature,
      remoteUpdatedAt: remoteIssue.fields.updated ?? undefined
    });

    let result: SyncFileResult;
    if (remoteChanged && plannedUpdate.hasPendingWrites) {
      const resolution = await resolveConflictChoice({
        conflict: {
          filePath,
          issueKey,
          summary: localIssue.core.summary
        },
        mode: input.conflictMode,
        resolveConflict: input.resolveConflict
      });

      result =
        resolution === "keep-jira"
          ? await applyRemoteIssueToLocal({
              catalog: input.catalog,
              config: input.config,
              dryRun: input.dryRun,
              history: input.history,
              issue: remoteIssue,
              issueKeyField: input.issueKeyField,
              jira: input.jira,
              localIssueIndex: input.localIssueIndex,
              rememberUsers: input.rememberUsers,
              resultAction: "keep-jira",
              stats: input.pushStats
            })
          : await applyLocalIssueUpdateToJira({
              catalog: input.catalog,
              config: input.config,
              dryRun: input.dryRun,
              history: input.history,
              issueKeyField: input.issueKeyField,
              jira: input.jira,
              localIssue,
              localIssueIndex: input.localIssueIndex,
              plannedUpdate,
              rememberUsers: input.rememberUsers,
              remoteIssue,
              resultAction: "keep-local",
              stats: input.pushStats
            });
    } else {
      result = await applyLocalIssueUpdateToJira({
        catalog: input.catalog,
        config: input.config,
        dryRun: input.dryRun,
        history: input.history,
        issueKeyField: input.issueKeyField,
        jira: input.jira,
        localIssue,
        localIssueIndex: input.localIssueIndex,
        plannedUpdate,
        rememberUsers: input.rememberUsers,
        remoteIssue,
        resultAction: "update",
        stats: input.pushStats
      });
    }

    if (result.issueKey) {
      pushedIssueKeys.add(result.issueKey);
    }
    results.push(result);
  }

  return {
    pushedIssueKeys,
    results
  };
}

async function pullRemoteIssues(input: {
  catalog: FieldCatalog;
  config: AppConfig;
  conflictMode: ConflictMode;
  dryRun?: boolean | undefined;
  history: SyncHistory;
  issueKeyField: string;
  jira: JiraClient;
  localIssueIndex: Map<string, LocalIssueRecord>;
  projectKeys: Set<string>;
  pushedIssueKeys: Set<string>;
  pullStats: SyncCommandStats;
  rememberUsers?: RememberUsers | undefined;
  resolveConflict?: ResolveConflict | undefined;
}): Promise<SyncFileResult[]> {
  const results: SyncFileResult[] = [];

  for (const configuredProjectKey of [...input.projectKeys].sort()) {
    const extraFieldIds = collectPullFieldIdsForProject(
      input.config,
      input.catalog,
      configuredProjectKey
    );
    const issues = await input.jira.searchIssuesByProject(
      configuredProjectKey,
      extraFieldIds
    );

    for (const issue of issues) {
      if (input.pushedIssueKeys.has(issue.key)) {
        continue;
      }

      const summary = issue.fields.summary?.trim() || issue.key;
      const projectKey =
        normalizeProjectKey(issue.fields.project?.key) ?? configuredProjectKey;
      const issueTypeName = issue.fields.issuetype?.name ?? undefined;
      const targetPath = buildCanonicalIssueFilePath(
        issue.key,
        summary,
        projectKey,
        process.cwd(),
        input.config.dir
      );
      const existingRecord = input.localIssueIndex.get(issue.key);
      const remoteAttachments = issue.fields.attachment ?? [];
      const remoteAttachmentSignature = buildRemoteAttachmentSignature(remoteAttachments);
      const currentAttachmentState = await loadLocalAttachmentState({
        filePath: targetPath,
        issueKey: issue.key,
        projectKey,
        rootDir: input.config.dir
      });
      const localChanged =
        existingRecord !== undefined &&
        hasLocalIssueChanges({
          attachmentSignature: currentAttachmentState.signature,
          filePath: existingRecord.filePath,
          history: input.history,
          issueKey: issue.key,
          mtimeMs: existingRecord.mtimeMs
        });
      const remoteChanged = hasRemoteIssueChanges({
        history: input.history,
        issueKey: issue.key,
        remoteAttachmentSignature,
        remoteUpdatedAt: issue.fields.updated ?? undefined
      });

      if (localChanged && remoteChanged) {
        const resolution = await resolveConflictChoice({
          conflict: {
            filePath: existingRecord?.filePath ?? targetPath,
            issueKey: issue.key,
            summary
          },
          mode: input.conflictMode,
          resolveConflict: input.resolveConflict
        });

        const result =
          resolution === "keep-local"
            ? await (async () => {
                const localFilePath = existingRecord?.filePath;
                if (!localFilePath) {
                  throw new Error(
                    `Cannot keep local for ${issue.key} because no local file was found.`
                  );
                }

                const localIssue = await prepareLocalIssueForPush({
                  catalog: input.catalog,
                  config: input.config,
                  dryRun: input.dryRun,
                  filePath: localFilePath,
                  issueKeyField: input.issueKeyField,
                  jira: input.jira,
                  rememberUsers: input.rememberUsers
                });
                const plannedUpdate = await planLocalIssueUpdate({
                  config: input.config,
                  history: input.history,
                  jira: input.jira,
                  localIssue,
                  rememberUsers: input.rememberUsers,
                  remoteIssue: issue
                });

                return applyLocalIssueUpdateToJira({
                  catalog: input.catalog,
                  config: input.config,
                  dryRun: input.dryRun,
                  history: input.history,
                  issueKeyField: input.issueKeyField,
                  jira: input.jira,
                  localIssue,
                  localIssueIndex: input.localIssueIndex,
                  plannedUpdate,
                  rememberUsers: input.rememberUsers,
                  remoteIssue: issue,
                  resultAction: "keep-local",
                  stats: input.pullStats
                });
              })()
            : await applyRemoteIssueToLocal({
                catalog: input.catalog,
                config: input.config,
                dryRun: input.dryRun,
                history: input.history,
                issue,
                issueKeyField: input.issueKeyField,
                jira: input.jira,
                localIssueIndex: input.localIssueIndex,
                rememberUsers: input.rememberUsers,
                resultAction: "keep-jira",
                stats: input.pullStats
              });

        input.pushedIssueKeys.add(issue.key);
        results.push(result);
        continue;
      }

      if (
        shouldSkipPullByHistory({
          currentLocalAttachmentSignature: currentAttachmentState.signature,
          fileMtimeMs: existingRecord?.mtimeMs,
          history: input.history,
          issueKey: issue.key,
          remoteAttachmentSignature,
          remoteUpdatedAt: issue.fields.updated ?? undefined,
          targetPath
        })
      ) {
        input.pullStats.skippedUnchanged += 1;
        continue;
      }
      results.push(
        await applyRemoteIssueToLocal({
          catalog: input.catalog,
          config: input.config,
          dryRun: input.dryRun,
          history: input.history,
          issue,
          issueKeyField: input.issueKeyField,
          jira: input.jira,
          localIssueIndex: input.localIssueIndex,
          rememberUsers: input.rememberUsers,
          resultAction: "pull",
          stats: input.pullStats
        })
      );
    }
  }

  return results;
}

export async function listFields(configPath?: string, filter?: string): Promise<void> {
  if (configPath) {
    await loadAppConfig(configPath);
  }

  const jira = new JiraClient(await loadStoredAuthConfig());
  const fields = await jira.getFields();
  const normalizedFilter = filter ? normalizeLookupKey(filter) : undefined;

  for (const field of fields) {
    const haystack = normalizeLookupKey(`${field.name}${field.id}`);
    if (normalizedFilter && !haystack.includes(normalizedFilter)) {
      continue;
    }

    console.log(
      [
        field.id.padEnd(22),
        field.name.padEnd(28),
        `type=${field.schema?.type ?? "-"}`,
        `custom=${field.schema?.custom ?? "-"}`
      ].join("  ")
    );
  }
}

export async function listSprints(boardId: number, state?: string): Promise<void> {
  const jira = new JiraClient(await loadStoredAuthConfig());
  const sprints = await jira.listSprints(boardId, state);

  for (const sprint of sprints) {
    console.log(`${String(sprint.id).padEnd(8)} ${sprint.state.padEnd(10)} ${sprint.name}`);
  }
}

export async function pushMarkdownToJira(
  options: SyncCommandOptions = {}
): Promise<SyncFileResult[]> {
  const loaded = await loadAppConfig(options.configPath);
  let { config } = loaded;
  const { configPath } = loaded;
  const jira = new JiraClient(await loadStoredAuthConfig());
  const issueKeyField = ISSUE_KEY_FRONTMATTER_FIELD;
  const { history, historyPath } = await loadSyncHistory(
    resolveSyncHistoryPath(config.dir)
  );
  const { files, localIssueIndex, projectKeys } = await loadLocalIssueState(config, issueKeyField);

  if (files.length === 0) {
    throw new Error(
      `No markdown files found under ${config.dir}. Create a local issue file under ${config.dir}/<PROJECT>/ or start with pull --project <KEY>.`
    );
  }

  const globalFields = await jira.getFields();
  config = await ensureGeneratedProjectFieldMappings({
    config,
    configPath,
    dryRun: options.dryRun,
    globalFields,
    jira,
    projectKeys
  });
  const catalog = createFieldCatalog(globalFields);
  const userMapTracker = createGeneratedUserMapTracker(config);
  const pushStats = createCommandStats();
  const conflictMode = resolveEffectiveConflictMode(options.onConflict);
  const { results } = await executePush({
    catalog,
    config,
    conflictMode,
    dryRun: options.dryRun,
    files,
    history,
    issueKeyField,
    jira,
    localIssueIndex,
    projectKeys,
    pushStats,
    rememberUsers: userMapTracker.rememberUsers,
    resolveConflict: options.resolveConflict,
    writeBack: options.writeBack
  });

  if (!options.dryRun) {
    if (userMapTracker.hasChanges()) {
      await saveGeneratedUserMap(config.userMap, config.dir, configPath);
    }
    setCommandHistoryStats(history, "push", pushStats);
    await saveSyncHistory(history, historyPath);
  }

  return results;
}

export async function pullJiraToMarkdown(
  options: SyncCommandOptions = {}
): Promise<SyncFileResult[]> {
  const loaded = await loadAppConfig(options.configPath);
  let { config } = loaded;
  const { configPath } = loaded;
  const jira = new JiraClient(await loadStoredAuthConfig());
  const issueKeyField = ISSUE_KEY_FRONTMATTER_FIELD;
  const { history, historyPath } = await loadSyncHistory(
    resolveSyncHistoryPath(config.dir)
  );
  const { localIssueIndex, projectKeys } = await loadLocalIssueState(
    config,
    issueKeyField,
    options.projects ?? []
  );

  if (projectKeys.size === 0) {
    throw new Error(
      `No Jira projects configured for pull. Pass --project or add local files under ${config.dir}/<PROJECT>/.`
    );
  }

  const globalFields = await jira.getFields();
  config = await ensureGeneratedProjectFieldMappings({
    config,
    configPath,
    dryRun: options.dryRun,
    globalFields,
    jira,
    projectKeys
  });
  const catalog = createFieldCatalog(globalFields);
  const userMapTracker = createGeneratedUserMapTracker(config);
  const pullStats = createCommandStats();
  const conflictMode = resolveEffectiveConflictMode(options.onConflict);
  const results = await pullRemoteIssues({
    catalog,
    config,
    conflictMode,
    dryRun: options.dryRun,
    history,
    issueKeyField,
    jira,
    localIssueIndex,
    projectKeys,
    pushedIssueKeys: new Set(),
    pullStats,
    rememberUsers: userMapTracker.rememberUsers,
    resolveConflict: options.resolveConflict
  });
  if (!options.dryRun) {
    if (userMapTracker.hasChanges()) {
      await saveGeneratedUserMap(config.userMap, config.dir, configPath);
    }
    setCommandHistoryStats(history, "pull", pullStats);
    await saveSyncHistory(history, historyPath);
  }

  return results;
}

export async function syncMarkdownToJira(
  options: SyncCommandOptions = {}
): Promise<SyncFileResult[]> {
  const loaded = await loadAppConfig(options.configPath);
  let { config } = loaded;
  const { configPath } = loaded;
  const jira = new JiraClient(await loadStoredAuthConfig());
  const issueKeyField = ISSUE_KEY_FRONTMATTER_FIELD;
  const { history, historyPath } = await loadSyncHistory(
    resolveSyncHistoryPath(config.dir)
  );
  const { files, localIssueIndex, projectKeys } = await loadLocalIssueState(
    config,
    issueKeyField,
    options.projects ?? []
  );

  if (files.length === 0 && projectKeys.size === 0) {
    throw new Error(
      `No markdown files found under ${config.dir}. Add local files or pass --project so sync knows which Jira projects to pull.`
    );
  }

  const globalFields = files.length > 0 || projectKeys.size > 0 ? await jira.getFields() : undefined;
  if (globalFields) {
    config = await ensureGeneratedProjectFieldMappings({
      config,
      configPath,
      dryRun: options.dryRun,
      globalFields,
      jira,
      projectKeys
    });
  }
  const catalog = globalFields ? createFieldCatalog(globalFields) : undefined;
  const userMapTracker = createGeneratedUserMapTracker(config);

  const results: SyncFileResult[] = [];
  const pushedIssueKeys = new Set<string>();
  const syncStats = createCommandStats();
  const conflictMode = resolveEffectiveConflictMode(options.onConflict);

  if (files.length > 0) {
    const pushCatalog = catalog ?? createFieldCatalog(await jira.getFields());
    const pushResult = await executePush({
      catalog: pushCatalog,
      config,
      conflictMode,
      dryRun: options.dryRun,
      files,
      history,
      issueKeyField,
      jira,
      localIssueIndex,
      projectKeys,
      pushStats: syncStats,
      rememberUsers: userMapTracker.rememberUsers,
      resolveConflict: options.resolveConflict,
      writeBack: options.writeBack
    });
    results.push(...pushResult.results);
    pushResult.pushedIssueKeys.forEach((issueKey) => pushedIssueKeys.add(issueKey));
  }

  if (projectKeys.size > 0) {
    const pullCatalog = catalog ?? createFieldCatalog(await jira.getFields());
    results.push(
      ...(await pullRemoteIssues({
        catalog: pullCatalog,
        config,
        conflictMode,
        dryRun: options.dryRun,
        history,
        issueKeyField,
        jira,
        localIssueIndex,
        projectKeys,
        pushedIssueKeys,
        pullStats: syncStats,
        rememberUsers: userMapTracker.rememberUsers,
        resolveConflict: options.resolveConflict
      }))
    );
  }

  if (!options.dryRun) {
    if (userMapTracker.hasChanges()) {
      await saveGeneratedUserMap(config.userMap, config.dir, configPath);
    }
    setCommandHistoryStats(history, "sync", syncStats);
    await saveSyncHistory(history, historyPath);
  }

  return results;
}
