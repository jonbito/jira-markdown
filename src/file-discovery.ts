import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const ATTACHMENTS_DIRECTORY_NAME = ".attachments";

async function walkMarkdownFiles(directory: string, matches: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ATTACHMENTS_DIRECTORY_NAME) {
        continue;
      }

      await walkMarkdownFiles(filePath, matches);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      matches.add(filePath);
    }
  }
}

export async function collectMarkdownFiles(
  dir: string,
  cwd = process.cwd()
): Promise<string[]> {
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

  await walkMarkdownFiles(rootDirectory, matches);
  return [...matches].sort();
}
