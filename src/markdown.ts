import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import { type MarkdownIssueDocument } from "./types.js";

function toFrontmatterRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export async function loadMarkdownDocument(
  filePath: string
): Promise<MarkdownIssueDocument> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);

  return {
    body: parsed.content.trim(),
    filePath,
    frontmatter: toFrontmatterRecord(parsed.data),
    raw
  };
}

export async function writeIssueKeyToFrontmatter(
  document: MarkdownIssueDocument,
  issueKeyField: string,
  issueKey: string
): Promise<void> {
  const nextRaw = matter.stringify(document.body, {
    ...document.frontmatter,
    [issueKeyField]: issueKey
  });

  await writeFile(document.filePath, nextRaw, "utf8");
}
