import { afterEach, describe, expect, test } from "./test-helpers.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanonicalIssueFilePath,
  formatPulledIssueMarkdown,
  writeIssueFileToCanonicalPath
} from "./issue-file.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-issue-file-"));
  tempDirectories.push(directory);
  return directory;
}

describe("buildCanonicalIssueFilePath", () => {
  test("uses the project folder and a sanitized summary", () => {
    const filePath = buildCanonicalIssueFilePath(
      "ENG-123",
      "Tighten sync: error/logging?",
      "eng",
      "/tmp/repo"
    );

    expect(filePath).toBe("/tmp/repo/issues/ENG/ENG-123 - Tighten sync error logging.md");
  });

  test("places child issues inside their full ancestor chain", () => {
    const filePath = buildCanonicalIssueFilePath(
      "ENG-3",
      "Nested child",
      "eng",
      "/tmp/repo",
      "issues",
      [
        { issueKey: "ENG-1", summary: "Parent epic" },
        { issueKey: "ENG-2", summary: "Story / planning" }
      ]
    );

    expect(filePath).toBe(
      "/tmp/repo/issues/ENG/ENG-1 - Parent epic/ENG-2 - Story planning/ENG-3 - Nested child.md"
    );
  });
});

describe("formatPulledIssueMarkdown", () => {
  test("formats a pulled issue into frontmatter plus body", () => {
    const markdown = formatPulledIssueMarkdown({
      assignee: "557058:abcd-1234",
      body: "Pulled body",
      extraFrontmatter: {
        components: ["API", "UI"],
        priority: "High"
      },
      issueKey: "ENG-123",
      issueKeyField: "issue",
      issueTypeName: "Task",
      labels: ["docs", "automation"],
      parent: "ENG-42",
      sprint: "Sprint 42",
      status: "In Progress",
      summary: "Pulled summary"
    });

    expect(markdown).toContain("issue: ENG-123");
    expect(markdown).toContain("summary: Pulled summary");
    expect(markdown).toContain("issueType: Task");
    expect(markdown).toContain("status: In Progress");
    expect(markdown).toContain("assignee: '557058:abcd-1234'");
    expect(markdown).toContain("parent: ENG-42");
    expect(markdown).toContain("sprint: Sprint 42");
    expect(markdown).toContain("priority: High");
    expect(markdown).toContain("components:");
    expect(markdown).toContain("- API");
    expect(markdown).toContain("- automation");
    expect(markdown).toContain("Pulled body");
  });
});

describe("writeIssueFileToCanonicalPath", () => {
  test("moves an existing issue file to the canonical path and rewrites its content", async () => {
    const directory = await createTempDirectory();
    const currentPath = join(directory, "issues", "ENG", "custom-name.md");
    const targetPath = join(directory, "issues", "ENG", "ENG-123 - Pulled summary.md");

    await mkdir(join(directory, "issues", "ENG"), { recursive: true });
    await writeFile(
      currentPath,
      "---\nissue: ENG-123\nsummary: Old summary\n---\n\nOld body\n",
      "utf8"
    );

    const finalPath = await writeIssueFileToCanonicalPath({
      content: "---\nissue: ENG-123\nsummary: Pulled summary\n---\n\nPulled body\n",
      currentPath,
      issueKey: "ENG-123",
      issueKeyField: "issue",
      targetPath
    });

    expect(finalPath).toBe(targetPath);
    expect(await readFile(targetPath, "utf8")).toContain("Pulled body");
  });
});
