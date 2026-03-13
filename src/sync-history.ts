import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const commandStatsSchema = z.object({
  created: z.number().int().nonnegative().default(0),
  downloadedAttachments: z.number().int().nonnegative().default(0),
  pulled: z.number().int().nonnegative().default(0),
  ranAt: z.string().min(1),
  skippedUnchangedAttachments: z.number().int().nonnegative().default(0),
  skippedPolicy: z.number().int().nonnegative().default(0),
  skippedUnchanged: z.number().int().nonnegative().default(0),
  uploadedAttachments: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0)
});

const attachmentRecordSchema = z.object({
  filePath: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  issueKey: z.string().min(1).optional(),
  jiraInlineImageBlock: z.any().optional(),
  jiraInlineImageRemoteAttachmentId: z.string().min(1).optional(),
  lastDownloadedAt: z.string().min(1).optional(),
  lastUploadedAt: z.string().min(1).optional(),
  mtimeMs: z.number().nonnegative().optional(),
  projectKey: z.string().min(1).optional(),
  remoteAttachmentId: z.string().min(1).optional(),
  remoteCreatedAt: z.string().min(1).optional(),
  remoteSize: z.number().nonnegative().optional(),
  sha256: z.string().min(1).optional(),
  size: z.number().nonnegative().optional()
});

const fileRecordSchema = z.object({
  lastAttachmentSignature: z.string().min(1).optional(),
  issueKey: z.string().min(1).optional(),
  lastSyncedAt: z.string().min(1).optional(),
  lastSyncedMtimeMs: z.number().nonnegative().optional()
});

const issueRecordSchema = z.object({
  filePath: z.string().min(1).optional(),
  lastPulledAttachmentSignature: z.string().min(1).optional(),
  lastPulledAt: z.string().min(1).optional(),
  lastPulledFileMtimeMs: z.number().nonnegative().optional(),
  lastPulledLocalAttachmentSignature: z.string().min(1).optional(),
  lastPulledRemoteUpdatedAt: z.string().min(1).optional(),
  lastSyncedRemoteAttachmentSignature: z.string().min(1).optional(),
  lastSyncedRemoteUpdatedAt: z.string().min(1).optional(),
  projectKey: z.string().min(1).optional(),
  summary: z.string().min(1).optional()
});

const syncHistorySchema = z.object({
  attachments: z
    .record(z.string(), z.record(z.string(), attachmentRecordSchema))
    .default({}),
  files: z.record(z.string(), fileRecordSchema).default({}),
  issues: z.record(z.string(), issueRecordSchema).default({}),
  stats: z
    .object({
      pull: commandStatsSchema.optional(),
      push: commandStatsSchema.optional(),
      sync: commandStatsSchema.optional()
    })
    .default({}),
  updatedAt: z.string().min(1).optional(),
  version: z.literal(2)
});

export type SyncCommandName = "pull" | "push" | "sync";
export type SyncAttachmentHistoryRecord = z.infer<typeof attachmentRecordSchema>;
export type SyncCommandStats = z.infer<typeof commandStatsSchema>;
export type SyncFileHistoryRecord = z.infer<typeof fileRecordSchema>;
export type SyncIssueHistoryRecord = z.infer<typeof issueRecordSchema>;
export type SyncHistory = z.infer<typeof syncHistorySchema>;

const DEFAULT_SYNC_HISTORY_PATH = ".sync-history";

function createEmptySyncHistory(): SyncHistory {
  return {
    attachments: {},
    files: {},
    issues: {},
    stats: {},
    version: 2
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

function normalizeIssueKey(issueKey: string): string {
  return issueKey.trim().toUpperCase();
}

export function toHistoryPath(filePath: string): string {
  const absolutePath = resolve(filePath);

  try {
    return realpathSync.native(absolutePath);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const parentPath = dirname(absolutePath);
  if (parentPath === absolutePath) {
    return absolutePath;
  }

  return resolve(toHistoryPath(parentPath), relative(parentPath, absolutePath));
}

function normalizeLoadedHistory(history: SyncHistory): SyncHistory {
  const normalizedFiles: SyncHistory["files"] = {};
  for (const [filePath, record] of Object.entries(history.files)) {
    normalizedFiles[toHistoryPath(filePath)] = record;
  }

  const normalizedIssues: SyncHistory["issues"] = {};
  for (const [issueKey, record] of Object.entries(history.issues)) {
    normalizedIssues[issueKey] = record.filePath
      ? {
          ...record,
          filePath: toHistoryPath(record.filePath)
        }
      : record;
  }

  const normalizedAttachments: SyncHistory["attachments"] = {};
  for (const [issueKey, attachmentRecords] of Object.entries(history.attachments)) {
    normalizedAttachments[issueKey] = {};

    for (const [fileName, record] of Object.entries(attachmentRecords)) {
      normalizedAttachments[issueKey][fileName] = record.filePath
        ? {
            ...record,
            filePath: toHistoryPath(record.filePath)
          }
        : record;
    }
  }

  return {
    ...history,
    attachments: normalizedAttachments,
    files: normalizedFiles,
    issues: normalizedIssues
  };
}

export function resolveSyncHistoryPath(
  dir: string,
  historyPath = DEFAULT_SYNC_HISTORY_PATH,
  cwd = process.cwd()
): string {
  if (isAbsolute(historyPath)) {
    return historyPath;
  }

  if (historyPath === DEFAULT_SYNC_HISTORY_PATH) {
    return isAbsolute(dir) ? resolve(dir, historyPath) : resolve(cwd, dir, historyPath);
  }

  return resolve(cwd, historyPath);
}

export async function loadSyncHistory(
  historyPath = DEFAULT_SYNC_HISTORY_PATH,
  cwd = process.cwd()
): Promise<{
  history: SyncHistory;
  historyPath: string;
}> {
  const absolutePath = resolve(cwd, historyPath);

  try {
    const raw = JSON.parse(await readFile(absolutePath, "utf8")) as {
      version?: unknown;
    };

    if (raw.version === 1) {
      throw new Error(
        `Unsupported sync history format at ${absolutePath}: version 1 stored cwd-relative paths. Delete ${absolutePath} and rerun push, pull, or sync to regenerate it.`
      );
    }

    return {
      history: normalizeLoadedHistory(syncHistorySchema.parse(raw)),
      historyPath: absolutePath
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        history: createEmptySyncHistory(),
        historyPath: absolutePath
      };
    }

    throw error;
  }
}

export async function saveSyncHistory(
  history: SyncHistory,
  historyPath = DEFAULT_SYNC_HISTORY_PATH,
  cwd = process.cwd()
): Promise<string> {
  const absolutePath = resolve(cwd, historyPath);
  const normalizedHistory = normalizeLoadedHistory(history);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(
      { ...normalizedHistory, updatedAt: new Date().toISOString() },
      null,
      2
    )}\n`,
    "utf8"
  );
  return absolutePath;
}

export function createCommandStats(): SyncCommandStats {
  return {
    created: 0,
    downloadedAttachments: 0,
    pulled: 0,
    ranAt: new Date().toISOString(),
    skippedUnchangedAttachments: 0,
    skippedPolicy: 0,
    skippedUnchanged: 0,
    uploadedAttachments: 0,
    updated: 0
  };
}

export function getAttachmentHistoryRecord(
  history: SyncHistory,
  issueKey: string,
  fileName: string
): SyncAttachmentHistoryRecord | undefined {
  return history.attachments[normalizeIssueKey(issueKey)]?.[fileName];
}

export function findAttachmentHistoryRecordByRemoteId(
  history: SyncHistory,
  issueKey: string,
  remoteAttachmentId: string
): {
  fileName: string;
  record: SyncAttachmentHistoryRecord;
} | undefined {
  const issueAttachments = history.attachments[normalizeIssueKey(issueKey)];
  if (!issueAttachments) {
    return undefined;
  }

  for (const [fileName, record] of Object.entries(issueAttachments)) {
    if (record.remoteAttachmentId === remoteAttachmentId) {
      return { fileName, record };
    }
  }

  return undefined;
}

export function setAttachmentHistoryRecord(
  history: SyncHistory,
  issueKey: string,
  fileName: string,
  record: SyncAttachmentHistoryRecord
): void {
  const normalizedIssueKey = normalizeIssueKey(issueKey);
  history.attachments[normalizedIssueKey] ??= {};
  history.attachments[normalizedIssueKey][fileName] = record;
}

export function deleteAttachmentHistoryRecord(
  history: SyncHistory,
  issueKey: string,
  fileName: string
): void {
  const normalizedIssueKey = normalizeIssueKey(issueKey);
  const issueAttachments = history.attachments[normalizedIssueKey];
  if (!issueAttachments) {
    return;
  }

  delete issueAttachments[fileName];

  if (Object.keys(issueAttachments).length === 0) {
    delete history.attachments[normalizedIssueKey];
  }
}

export function rewriteAttachmentHistoryPathsForIssue(
  history: SyncHistory,
  issueKey: string,
  currentDirectoryPath: string,
  nextDirectoryPath: string
): void {
  const normalizedIssueKey = normalizeIssueKey(issueKey);
  const issueAttachments = history.attachments[normalizedIssueKey];
  if (!issueAttachments) {
    return;
  }

  const currentPrefix = toHistoryPath(currentDirectoryPath);
  const nextPrefix = toHistoryPath(nextDirectoryPath);

  for (const record of Object.values(issueAttachments)) {
    if (!record.filePath) {
      continue;
    }

    const suffix = relative(currentPrefix, record.filePath);
    if (suffix.startsWith("..") || isAbsolute(suffix)) {
      continue;
    }

    record.filePath = resolve(nextPrefix, suffix);
  }
}

export function getFileHistoryRecord(
  history: SyncHistory,
  filePath: string
): SyncFileHistoryRecord | undefined {
  return history.files[toHistoryPath(filePath)];
}

export function setFileHistoryRecord(
  history: SyncHistory,
  filePath: string,
  record: SyncFileHistoryRecord
): void {
  history.files[toHistoryPath(filePath)] = record;
}

export function deleteFileHistoryRecord(history: SyncHistory, filePath: string): void {
  delete history.files[toHistoryPath(filePath)];
}

export function getIssueHistoryRecord(
  history: SyncHistory,
  issueKey: string
): SyncIssueHistoryRecord | undefined {
  return history.issues[normalizeIssueKey(issueKey)];
}

export function setIssueHistoryRecord(
  history: SyncHistory,
  issueKey: string,
  record: SyncIssueHistoryRecord
): void {
  history.issues[normalizeIssueKey(issueKey)] = record;
}

export function setCommandHistoryStats(
  history: SyncHistory,
  command: SyncCommandName,
  stats: SyncCommandStats
): void {
  history.stats[command] = stats;
}

export function shouldSkipPushByHistory(input: {
  attachmentSignature: string;
  filePath: string;
  history: SyncHistory;
  issueKey?: string | undefined;
  mtimeMs: number;
}): boolean {
  if (!input.issueKey) {
    return false;
  }

  const record = getFileHistoryRecord(input.history, input.filePath);
  return Boolean(
    record?.lastAttachmentSignature === input.attachmentSignature &&
    record?.issueKey &&
      normalizeIssueKey(record.issueKey) === normalizeIssueKey(input.issueKey) &&
      record.lastSyncedMtimeMs === input.mtimeMs
  );
}

export function shouldSkipPullByHistory(input: {
  currentLocalAttachmentSignature?: string | undefined;
  fileMtimeMs?: number | undefined;
  history: SyncHistory;
  issueKey: string;
  remoteAttachmentSignature?: string | undefined;
  remoteUpdatedAt?: string | undefined;
  targetPath: string;
}): boolean {
  if (
    input.fileMtimeMs === undefined ||
    (!input.remoteUpdatedAt && !input.remoteAttachmentSignature)
  ) {
    return false;
  }

  const record = getIssueHistoryRecord(input.history, input.issueKey);
  return Boolean(
    (!input.remoteUpdatedAt ||
      record?.lastSyncedRemoteUpdatedAt === input.remoteUpdatedAt ||
      record?.lastPulledRemoteUpdatedAt === input.remoteUpdatedAt) &&
      (!input.remoteAttachmentSignature ||
        record?.lastSyncedRemoteAttachmentSignature === input.remoteAttachmentSignature ||
        record?.lastPulledAttachmentSignature === input.remoteAttachmentSignature) &&
      (!input.currentLocalAttachmentSignature ||
        record?.lastPulledLocalAttachmentSignature === input.currentLocalAttachmentSignature) &&
      record?.filePath === toHistoryPath(input.targetPath) &&
      record?.lastPulledFileMtimeMs === input.fileMtimeMs
  );
}
