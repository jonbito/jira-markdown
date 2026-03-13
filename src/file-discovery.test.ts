import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "./test-helpers.js";
import { collectMarkdownFiles } from "./file-discovery.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-files-"));
  tempDirectories.push(directory);
  return directory;
}

describe("collectMarkdownFiles", () => {
  test("returns an empty array when the root directory is missing", async () => {
    const directory = await createTempDirectory();

    expect(await collectMarkdownFiles("issues", directory)).toEqual([]);
  });

  test("returns an empty array when the root path is not a directory", async () => {
    const directory = await createTempDirectory();
    await writeFile(join(directory, "issues"), "not a directory", "utf8");

    expect(await collectMarkdownFiles("issues", directory)).toEqual([]);
  });

  test("collects nested markdown files in sorted absolute-path order", async () => {
    const directory = await createTempDirectory();
    const issuesDirectory = join(directory, "issues");

    await mkdir(join(issuesDirectory, "ENG", "nested"), { recursive: true });
    await mkdir(join(issuesDirectory, "OPS"), { recursive: true });
    await writeFile(join(issuesDirectory, "ENG", "b.md"), "", "utf8");
    await writeFile(join(issuesDirectory, "ENG", "nested", "a.md"), "", "utf8");
    await writeFile(join(issuesDirectory, "OPS", "note.txt"), "", "utf8");

    expect(await collectMarkdownFiles("issues", directory)).toEqual([
      join(issuesDirectory, "ENG", "b.md"),
      join(issuesDirectory, "ENG", "nested", "a.md")
    ]);
  });

  test("does not traverse symlinked directories", async () => {
    const directory = await createTempDirectory();
    const issuesDirectory = join(directory, "issues");
    const externalDirectory = join(directory, "external");

    await mkdir(join(issuesDirectory, "ENG"), { recursive: true });
    await mkdir(join(externalDirectory, "nested"), { recursive: true });
    await writeFile(join(issuesDirectory, "ENG", "visible.md"), "", "utf8");
    await writeFile(join(externalDirectory, "nested", "hidden.md"), "", "utf8");
    await symlink(externalDirectory, join(issuesDirectory, "linked"));

    expect(await collectMarkdownFiles("issues", directory)).toEqual([
      join(issuesDirectory, "ENG", "visible.md")
    ]);
  });
});
