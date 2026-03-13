import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import matter from "gray-matter";
import { resolveIssueKey } from "./issue-key.js";
import { inferProjectRootPath } from "./project-path.js";

export interface CanonicalIssuePathSegment {
  issueKey: string;
  summary?: string | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeIssueSummary(summary: string): string {
  const sanitized = summary
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized) {
    return "Untitled";
  }

  return sanitized.slice(0, 120).trimEnd();
}

function buildIssuePathSegmentLabel(segment: CanonicalIssuePathSegment): string {
  const issueKey = segment.issueKey.trim().toUpperCase();
  const summary = asString(segment.summary);
  return summary ? `${issueKey} - ${sanitizeIssueSummary(summary)}` : issueKey;
}

function extractIssueKeyFromRaw(
  raw: string,
  filePath: string,
  issueKeyField: string
): string | undefined {
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  return resolveIssueKey({
    filePath,
    frontmatter,
    issueKeyField
  });
}

async function readIssueKeyAtPath(
  filePath: string,
  issueKeyField: string
): Promise<string | undefined> {
  try {
    return extractIssueKeyFromRaw(await readFile(filePath, "utf8"), filePath, issueKeyField);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function clearTargetPathIfSameIssue(options: {
  issueKey: string;
  issueKeyField: string;
  targetPath: string;
}): Promise<void> {
  const existingIssueKey = await readIssueKeyAtPath(options.targetPath, options.issueKeyField);
  if (!existingIssueKey) {
    return;
  }

  if (existingIssueKey !== options.issueKey) {
    throw new Error(
      `Refusing to overwrite ${options.targetPath} because it belongs to ${existingIssueKey}, not ${options.issueKey}.`
    );
  }

  await rm(options.targetPath, { force: true });
}

export function buildCanonicalIssueFilePath(
  issueKey: string,
  summary: string,
  projectKey: string,
  cwd = process.cwd(),
  rootDir = "issues",
  ancestors: CanonicalIssuePathSegment[] = []
): string {
  return resolve(
    cwd,
    rootDir,
    projectKey.trim().toUpperCase(),
    ...ancestors.map((ancestor) => buildIssuePathSegmentLabel(ancestor)),
    `${buildIssuePathSegmentLabel({ issueKey, summary })}.md`
  );
}

async function pruneEmptyIssueDirectories(filePath: string, rootDir: string): Promise<void> {
  const projectRootPath = inferProjectRootPath(filePath, rootDir);
  if (!projectRootPath) {
    return;
  }

  let currentDirectory = dirname(filePath);
  const stopDirectory = resolve(projectRootPath);

  while (currentDirectory !== stopDirectory) {
    const entries = await readdir(currentDirectory);
    if (entries.length > 0) {
      return;
    }

    await rm(currentDirectory, { force: true, recursive: true });
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return;
    }

    currentDirectory = parentDirectory;
  }
}

export function formatPulledIssueMarkdown(input: {
  assignee?: string | undefined;
  body: string;
  extraFrontmatter?: Record<string, unknown> | undefined;
  issueKey: string;
  issueKeyField: string;
  issueTypeName?: string | undefined;
  labels?: string[] | undefined;
  parent?: string | undefined;
  sprint?: number | string | undefined;
  status?: string | undefined;
  summary: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    [input.issueKeyField]: input.issueKey,
    summary: input.summary
  };

  if (input.issueTypeName?.trim()) {
    frontmatter.issueType = input.issueTypeName.trim();
  }

  if (input.status?.trim()) {
    frontmatter.status = input.status.trim();
  }

  if (input.assignee?.trim()) {
    frontmatter.assignee = input.assignee.trim();
  }

  if (input.parent?.trim()) {
    frontmatter.parent = input.parent.trim();
  }

  if (
    (typeof input.sprint === "string" && input.sprint.trim()) ||
    typeof input.sprint === "number"
  ) {
    frontmatter.sprint = input.sprint;
  }

  for (const key of Object.keys(input.extraFrontmatter ?? {}).sort((left, right) =>
    left.localeCompare(right)
  )) {
    const value = input.extraFrontmatter?.[key];
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    frontmatter[key] = value;
  }

  const labels = (input.labels ?? [])
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  if (labels.length > 0) {
    frontmatter.labels = labels;
  }

  return matter.stringify(input.body.trim(), frontmatter);
}

export async function moveIssueFileToCanonicalPath(input: {
  currentPath: string;
  issueKey: string;
  issueKeyField: string;
  rootDir?: string | undefined;
  targetPath: string;
}): Promise<string> {
  if (input.currentPath === input.targetPath) {
    return input.targetPath;
  }

  await ensureParentDirectory(input.targetPath);
  await clearTargetPathIfSameIssue({
    issueKey: input.issueKey,
    issueKeyField: input.issueKeyField,
    targetPath: input.targetPath
  });
  await rename(input.currentPath, input.targetPath);
  await pruneEmptyIssueDirectories(input.currentPath, input.rootDir ?? "issues");
  return input.targetPath;
}

export async function writeIssueFileToCanonicalPath(input: {
  content: string;
  currentPath?: string | undefined;
  issueKey: string;
  issueKeyField: string;
  rootDir?: string | undefined;
  targetPath: string;
}): Promise<string> {
  let nextPath = input.targetPath;

  if (input.currentPath && input.currentPath !== input.targetPath) {
    nextPath = await moveIssueFileToCanonicalPath({
      currentPath: input.currentPath,
      issueKey: input.issueKey,
      issueKeyField: input.issueKeyField,
      rootDir: input.rootDir,
      targetPath: input.targetPath
    });
  } else {
    await ensureParentDirectory(input.targetPath);
    const existingIssueKey = await readIssueKeyAtPath(input.targetPath, input.issueKeyField);
    if (existingIssueKey && existingIssueKey !== input.issueKey) {
      throw new Error(
        `Refusing to overwrite ${input.targetPath} because it belongs to ${existingIssueKey}, not ${input.issueKey}.`
      );
    }
  }

  await writeFile(nextPath, input.content, "utf8");
  return nextPath;
}
