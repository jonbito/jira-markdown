import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDraftAttachmentDirectory,
  buildIssueAttachmentDirectory,
  buildRemoteAttachmentSignature,
  createUniqueAttachmentFileName,
  listLocalAttachmentFiles,
  promoteDraftAttachmentDirectory
} from "./attachments";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-attachments-"));
  tempDirectories.push(directory);
  return directory;
}

describe("attachments", () => {
  test("builds issue attachment directories under the project folder", () => {
    expect(buildIssueAttachmentDirectory("eng-123", "eng", "/tmp/repo")).toBe(
      "/tmp/repo/issues/ENG/.attachments/ENG-123"
    );
  });

  test("builds a stable draft attachment directory from the markdown path", () => {
    expect(
      buildDraftAttachmentDirectory("/tmp/repo/issues/ENG/features/sample-task.md")
    ).toBe("/tmp/repo/issues/ENG/.attachments/_drafts/features__sample-task");
  });

  test("creates unique local filenames when remote attachment names collide", () => {
    const takenFileNames = new Set(["diagram.png"]);

    expect(createUniqueAttachmentFileName("diagram.png", takenFileNames, "10001")).toBe(
      "diagram (10001).png"
    );
  });

  test("promotes draft attachments into the issue-key directory", async () => {
    const directory = await createTempDirectory();
    const markdownFilePath = join(directory, "issues", "ENG", "sample-task.md");
    const draftDirectory = buildDraftAttachmentDirectory(markdownFilePath);

    await mkdir(draftDirectory, { recursive: true });
    await writeFile(join(draftDirectory, "diagram.png"), "png-data", "utf8");

    const finalDirectory = await promoteDraftAttachmentDirectory({
      filePath: markdownFilePath,
      issueKey: "ENG-123",
      projectKey: "ENG"
    });

    expect(finalDirectory).toBe(join(directory, "issues", "ENG", ".attachments", "ENG-123"));
    expect(await readFile(join(finalDirectory, "diagram.png"), "utf8")).toBe("png-data");
  });

  test("builds remote attachment signatures independent of result order", () => {
    const left = buildRemoteAttachmentSignature([
      { filename: "diagram.png", id: "10001", size: 10 },
      { created: "2026-03-11T00:00:00.000Z", filename: "spec.pdf", id: "10002", size: 20 }
    ]);
    const right = buildRemoteAttachmentSignature([
      { created: "2026-03-11T00:00:00.000Z", filename: "spec.pdf", id: "10002", size: 20 },
      { filename: "diagram.png", id: "10001", size: 10 }
    ]);

    expect(left).toBe(right);
  });

  test("lists local attachment files with stable hashes", async () => {
    const directory = await createTempDirectory();
    const attachmentDirectory = join(directory, "issues", "ENG", ".attachments", "ENG-123");
    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(join(attachmentDirectory, "diagram.png"), "png-data", "utf8");
    await writeFile(join(attachmentDirectory, ".DS_Store"), "noise", "utf8");

    const attachments = await listLocalAttachmentFiles(attachmentDirectory);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("diagram.png");
    expect(attachments[0]?.sha256.length).toBeGreaterThan(10);
  });
});
