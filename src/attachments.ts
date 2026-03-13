import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import {
  inferProjectKeyFromFilePath,
  inferProjectRootPath,
  inferWorkspaceRootPath
} from "./project-path";
import { type JiraIssueAttachment } from "./types";

export interface LocalAttachmentFile {
  fileName: string;
  filePath: string;
  mtimeMs: number;
  sha256: string;
  size: number;
}

function isFileNotFoundError(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

function sanitizeDirectorySegment(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^-+|-+$/g, "");

  return sanitized || "draft";
}

function toMarkdownPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith(".") || normalized.startsWith("/")) {
    return normalized;
  }

  return `./${normalized}`;
}

export function sanitizeAttachmentFileName(fileName: string): string {
  const extension = extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const sanitizedBase = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const sanitizedExtension = extension.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "");
  const finalBaseName = sanitizedBase || "attachment";
  return `${finalBaseName}${sanitizedExtension}`.slice(0, 180).trimEnd();
}

function buildDraftAttachmentDirectoryName(filePath: string): string {
  const projectRootPath = inferProjectRootPath(filePath);
  const relativePath = projectRootPath
    ? relative(projectRootPath, filePath)
    : basename(filePath);
  const draftStem = relativePath.replace(/\.[^.]+$/u, "").replace(/[\\/]+/g, "__");
  return sanitizeDirectorySegment(draftStem);
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

async function moveDirectoryContentsIfPresent(
  sourceDirectory: string,
  targetDirectory: string
): Promise<string> {
  if (sourceDirectory === targetDirectory) {
    return targetDirectory;
  }

  try {
    const sourceStats = await stat(sourceDirectory);
    if (!sourceStats.isDirectory()) {
      return targetDirectory;
    }
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return targetDirectory;
    }

    throw error;
  }

  try {
    await ensureDirectory(resolve(targetDirectory, ".."));
    await rename(sourceDirectory, targetDirectory);
    return targetDirectory;
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes((error as { code?: string })?.code ?? "")) {
      throw error;
    }
  }

  await ensureDirectory(targetDirectory);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = resolve(sourceDirectory, entry.name);
    const targetPath = resolve(targetDirectory, entry.name);
    await rm(targetPath, { force: true, recursive: true });
    await rename(sourcePath, targetPath);
  }

  await rm(sourceDirectory, { force: true, recursive: true });
  return targetDirectory;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function buildSignature(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function buildIssueAttachmentDirectory(
  issueKey: string,
  projectKey: string,
  cwd = process.cwd(),
  rootDir = "issues"
): string {
  return resolve(
    cwd,
    rootDir,
    projectKey.trim().toUpperCase(),
    ".attachments",
    issueKey.trim().toUpperCase()
  );
}

export function buildDraftAttachmentDirectory(filePath: string, rootDir = "issues"): string {
  const projectKey = inferProjectKeyFromFilePath(filePath, rootDir);
  const projectRootPath = inferProjectRootPath(filePath, rootDir);

  if (!projectKey || !projectRootPath) {
    return resolve(
      filePath,
      "..",
      ".attachments",
      "_drafts",
      sanitizeDirectorySegment(basename(filePath, extname(filePath)))
    );
  }

  return resolve(
    projectRootPath,
    ".attachments",
    "_drafts",
    buildDraftAttachmentDirectoryName(filePath)
  );
}

export function buildIssueAttachmentFilePath(
  issueKey: string,
  projectKey: string,
  fileName: string,
  cwd = process.cwd(),
  rootDir = "issues"
): string {
  return resolve(
    buildIssueAttachmentDirectory(issueKey, projectKey, cwd, rootDir),
    sanitizeAttachmentFileName(fileName)
  );
}

export function buildIssueAttachmentMarkdownPath(input: {
  fileName: string;
  issueKey: string;
  markdownFilePath: string;
  projectKey: string;
  rootDir?: string | undefined;
}): string {
  const rootDir = input.rootDir ?? "issues";
  const workspaceRoot = inferWorkspaceRootPath(input.markdownFilePath, rootDir) ?? process.cwd();
  const attachmentPath = buildIssueAttachmentFilePath(
    input.issueKey,
    input.projectKey,
    input.fileName,
    workspaceRoot,
    rootDir
  );
  return toMarkdownPath(relative(dirname(input.markdownFilePath), attachmentPath));
}

export function isLikelyImageAttachment(fileName: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }

  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(fileName);
}

export function buildRemoteAttachmentSignature(attachments: JiraIssueAttachment[]): string {
  const parts = attachments
    .map((attachment) =>
      [
        attachment.id,
        sanitizeAttachmentFileName(attachment.filename),
        String(attachment.size),
        attachment.created ?? ""
      ].join("|")
    )
    .sort((left, right) => left.localeCompare(right));

  return buildSignature(parts);
}

export function buildLocalAttachmentSignature(attachments: LocalAttachmentFile[]): string {
  const parts = attachments
    .map((attachment) =>
      [attachment.fileName, String(attachment.size), attachment.sha256].join("|")
    )
    .sort((left, right) => left.localeCompare(right));

  return buildSignature(parts);
}

export function createUniqueAttachmentFileName(
  fileName: string,
  takenFileNames: Set<string>,
  suffix: string
): string {
  const safeFileName = sanitizeAttachmentFileName(fileName);
  if (!takenFileNames.has(safeFileName)) {
    takenFileNames.add(safeFileName);
    return safeFileName;
  }

  const extension = extname(safeFileName);
  const baseName = safeFileName.slice(0, safeFileName.length - extension.length) || "attachment";
  const nextName = `${baseName} (${suffix})${extension}`;
  takenFileNames.add(nextName);
  return nextName;
}

export async function listLocalAttachmentFiles(
  directoryPath: string
): Promise<LocalAttachmentFile[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const files: LocalAttachmentFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        continue;
      }

      const filePath = resolve(directoryPath, entry.name);
      const fileStats = await stat(filePath);
      files.push({
        fileName: entry.name,
        filePath,
        mtimeMs: fileStats.mtimeMs,
        sha256: await hashFile(filePath),
        size: fileStats.size
      });
    }

    return files.sort((left, right) => left.fileName.localeCompare(right.fileName));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

export async function moveIssueAttachmentDirectory(input: {
  fromProjectKey?: string | undefined;
  issueKey: string;
  rootDir?: string | undefined;
  toProjectKey: string;
}): Promise<string> {
  const rootDir = input.rootDir ?? "issues";
  const targetDirectory = buildIssueAttachmentDirectory(
    input.issueKey,
    input.toProjectKey,
    process.cwd(),
    rootDir
  );
  if (!input.fromProjectKey || input.fromProjectKey === input.toProjectKey) {
    return targetDirectory;
  }

  const sourceDirectory = buildIssueAttachmentDirectory(
    input.issueKey,
    input.fromProjectKey,
    process.cwd(),
    rootDir
  );
  return moveDirectoryContentsIfPresent(sourceDirectory, targetDirectory);
}

export async function promoteDraftAttachmentDirectory(input: {
  filePath: string;
  issueKey: string;
  projectKey: string;
  rootDir?: string | undefined;
}): Promise<string> {
  const rootDir = input.rootDir ?? "issues";
  const sourceDirectory = buildDraftAttachmentDirectory(input.filePath, rootDir);
  const targetDirectory = buildIssueAttachmentDirectory(
    input.issueKey,
    input.projectKey,
    inferWorkspaceRootPath(input.filePath, rootDir) ?? process.cwd(),
    rootDir
  );
  return moveDirectoryContentsIfPresent(sourceDirectory, targetDirectory);
}

export async function writeAttachmentFile(filePath: string, content: Uint8Array): Promise<void> {
  await ensureDirectory(resolve(filePath, ".."));
  await writeFile(filePath, content);
}
