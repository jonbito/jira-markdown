import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommandStats,
  getFileHistoryRecord,
  loadSyncHistory,
  saveSyncHistory,
  setCommandHistoryStats,
  setFileHistoryRecord,
  setIssueHistoryRecord,
  shouldSkipPullByHistory,
  shouldSkipPushByHistory
} from "./sync-history";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-sync-history-"));
  tempDirectories.push(directory);
  return directory;
}

describe("sync history", () => {
  test("persists history records", async () => {
    const directory = await createTempDirectory();
    const historyPath = join(directory, ".sync-history");
    const filePath = join(directory, "issues", "ENG", "ENG-1 - Example.md");
    const stats = createCommandStats();
    stats.updated = 2;

    const { history } = await loadSyncHistory(historyPath);
    setFileHistoryRecord(history, filePath, {
      issueKey: "ENG-1",
      lastSyncedAt: "2026-03-11T00:00:00.000Z",
      lastSyncedMtimeMs: 123
    });
    setIssueHistoryRecord(history, "ENG-1", {
      filePath: "issues/ENG/ENG-1 - Example.md",
      lastPulledAt: "2026-03-11T00:00:00.000Z",
      lastPulledFileMtimeMs: 123,
      lastSyncedRemoteAttachmentSignature: "remote-attachments",
      lastSyncedRemoteUpdatedAt: "2026-03-11T00:00:00.000Z",
      lastPulledRemoteUpdatedAt: "2026-03-11T00:00:00.000Z",
      projectKey: "ENG",
      summary: "Example"
    });
    setCommandHistoryStats(history, "push", stats);

    await saveSyncHistory(history, historyPath);
    const reloaded = await loadSyncHistory(historyPath);

    expect(getFileHistoryRecord(reloaded.history, filePath)?.issueKey).toBe("ENG-1");
    expect(reloaded.history.stats.push?.updated).toBe(2);
    expect(JSON.parse(await readFile(historyPath, "utf8"))).toHaveProperty("updatedAt");
  });

  test("skips unchanged push entries when mtime matches", () => {
    const history = {
      attachments: {},
      files: {
        "issues/ENG/ENG-1 - Example.md": {
          issueKey: "ENG-1",
          lastAttachmentSignature: "attachment-signature",
          lastSyncedMtimeMs: 123
        }
      },
      issues: {},
      stats: {},
      version: 1 as const
    };

    expect(
      shouldSkipPushByHistory({
        attachmentSignature: "attachment-signature",
        filePath: join(process.cwd(), "issues", "ENG", "ENG-1 - Example.md"),
        history,
        issueKey: "ENG-1",
        mtimeMs: 123
      })
    ).toBe(true);
  });

  test("skips unchanged pull entries when remote updated time and local mtime match", () => {
    const history = {
      attachments: {},
      files: {},
      issues: {
        "ENG-1": {
          filePath: "issues/ENG/ENG-1 - Example.md",
          lastPulledAttachmentSignature: "remote-attachments",
          lastPulledFileMtimeMs: 123,
          lastPulledLocalAttachmentSignature: "local-attachments",
          lastSyncedRemoteAttachmentSignature: "remote-attachments",
          lastSyncedRemoteUpdatedAt: "2026-03-11T00:00:00.000Z",
          lastPulledRemoteUpdatedAt: "2026-03-11T00:00:00.000Z"
        }
      },
      stats: {},
      version: 1 as const
    };

    expect(
      shouldSkipPullByHistory({
        currentLocalAttachmentSignature: "local-attachments",
        fileMtimeMs: 123,
        history,
        issueKey: "ENG-1",
        remoteAttachmentSignature: "remote-attachments",
        remoteUpdatedAt: "2026-03-11T00:00:00.000Z",
        targetPath: join(process.cwd(), "issues", "ENG", "ENG-1 - Example.md")
      })
    ).toBe(true);
  });
});
