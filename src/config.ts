import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { getDefaultAppConfigDirectory } from "./auth-store";
import { type AppConfig } from "./types";

const fieldResolverSchema = z.enum([
  "passthrough",
  "string",
  "number",
  "stringArray",
  "optionByName",
  "optionById",
  "optionArrayByName",
  "componentArrayByName",
  "versionArrayByName",
  "priorityByName",
  "userByAccountId",
  "sprintById",
  "sprintByName"
]);

const fieldMappingSchema = z.object({
  boardId: z.coerce.number().int().positive().optional(),
  fieldId: z.string().min(1).optional(),
  fieldName: z.string().min(1).optional(),
  resolver: fieldResolverSchema.optional(),
  schemaCustom: z.string().min(1).optional()
});

const userMapEntrySchema = z.object({
  accountId: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  email: z.string().min(1).optional()
});

const appConfigSchema = z.object({
  dir: z.string().min(1).default("issues"),
  sync: z
    .object({
      createMissing: z.boolean().default(true),
      updateExisting: z.boolean().default(true)
    })
    .default({ createMissing: true, updateExisting: true })
});

const DEFAULT_CONFIG_FILE = "jira-markdown.config.json";
const GENERATED_FIELD_MAP_FILE = ".jira-markdown.field-map.json";
const GENERATED_USER_MAP_FILE = ".jira-markdown.user-map.json";

const generatedProjectIssueTypeFieldMapSchema = z
  .record(
    z.string(),
    z.record(z.string(), z.record(z.string(), fieldMappingSchema))
  )
  .default({});

const generatedUserMapSchema = z.record(z.string(), userMapEntrySchema).default({});

interface InitAppConfigOptions {
  createConfig?: (() => AppConfig | Promise<AppConfig>) | undefined;
  configPath?: string | undefined;
  force?: boolean | undefined;
}

export function getDefaultConfigFilePath(env = process.env): string {
  const override = env.JIRA_MARKDOWN_CONFIG_FILE?.trim();
  if (override) {
    return resolve(override);
  }

  return join(getDefaultAppConfigDirectory(env), DEFAULT_CONFIG_FILE);
}

function resolveConfigPath(configPath?: string): string {
  if (configPath?.trim()) {
    return resolve(process.cwd(), configPath);
  }

  return getDefaultConfigFilePath();
}

function resolveConfiguredDirPath(configPath: string, dir: string, cwd = process.cwd()): string {
  if (isAbsolute(dir)) {
    return resolve(dir);
  }

  const basePath = configPath === getDefaultConfigFilePath() ? cwd : dirname(configPath);
  return resolve(basePath, dir);
}

function resolveGeneratedConfigPath(
  configPath: string,
  dir: string,
  fileName: string,
  cwd = process.cwd()
): string {
  return resolve(resolveConfiguredDirPath(configPath, dir, cwd), fileName);
}

function isFileNotFoundError(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

async function readJsonFileIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function toStoredAppConfig(config: AppConfig): z.input<typeof appConfigSchema> {
  return {
    dir: config.dir,
    sync: config.sync
  };
}

export function createDefaultAppConfig(): AppConfig {
  return {
    dir: "issues",
    projectIssueTypeFieldMap: {},
    userMap: {},
    sync: {
      createMissing: true,
      updateExisting: true
    }
  };
}

export async function loadAppConfig(configPath?: string): Promise<{
  config: AppConfig;
  configPath: string;
}> {
  const absolutePath = resolveConfigPath(configPath);
  const parsed = ((await readJsonFileIfPresent(absolutePath)) ?? {}) as Partial<AppConfig> & {
    files?: unknown;
  };
  const parsedConfig = appConfigSchema.parse(parsed);
  const resolvedDir = inferLegacyDir(parsed.files) ?? parsedConfig.dir;
  const fieldMapPath = resolveGeneratedConfigPath(
    absolutePath,
    resolvedDir,
    GENERATED_FIELD_MAP_FILE
  );
  const userMapPath = resolveGeneratedConfigPath(
    absolutePath,
    resolvedDir,
    GENERATED_USER_MAP_FILE
  );
  const parsedFieldMap =
    (await readJsonFileIfPresent(fieldMapPath)) ??
    parsed.projectIssueTypeFieldMap ??
    {};
  const parsedUserMap = (await readJsonFileIfPresent(userMapPath)) ?? parsed.userMap ?? {};

  return {
    config: {
      ...createDefaultAppConfig(),
      ...parsedConfig,
      dir: resolvedDir,
      projectIssueTypeFieldMap: generatedProjectIssueTypeFieldMapSchema.parse(
        parsedFieldMap
      ),
      userMap: generatedUserMapSchema.parse(parsedUserMap)
    },
    configPath: absolutePath
  };
}

function inferLegacyDir(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      continue;
    }

    const normalized = entry.trim().replace(/\\/g, "/");
    if (normalized.endsWith("/**/*.md")) {
      return normalized.slice(0, -"/**/*.md".length) || undefined;
    }

    if (normalized.endsWith("/*.md")) {
      return normalized.slice(0, -"/*.md".length) || undefined;
    }

    if (!normalized.includes("*")) {
      return normalized;
    }
  }

  return undefined;
}

export async function initAppConfig(
  options: InitAppConfigOptions = {}
): Promise<{
  config: AppConfig;
  configPath: string;
  created: boolean;
}> {
  const configPath = options.configPath;
  const absolutePath = resolveConfigPath(configPath);

  if (!options.force && (await fileExists(absolutePath))) {
    const existing = await loadAppConfig(configPath);
    return {
      ...existing,
      created: false
    };
  }

  const config = options.createConfig
    ? await options.createConfig()
    : createDefaultAppConfig();
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(toStoredAppConfig(config), null, 2)}\n`,
    "utf8"
  );

  return {
    config,
    configPath: absolutePath,
    created: true
  };
}

export async function saveAppConfig(
  config: AppConfig,
  configPath?: string
): Promise<string> {
  const absolutePath = resolveConfigPath(configPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(toStoredAppConfig(config), null, 2)}\n`,
    "utf8"
  );
  return absolutePath;
}

export async function saveGeneratedProjectIssueTypeFieldMap(
  projectIssueTypeFieldMap: AppConfig["projectIssueTypeFieldMap"],
  dir: string,
  configPath?: string
): Promise<string> {
  const absoluteConfigPath = resolveConfigPath(configPath);
  const absolutePath = resolveGeneratedConfigPath(
    absoluteConfigPath,
    dir,
    GENERATED_FIELD_MAP_FILE
  );
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(projectIssueTypeFieldMap, null, 2)}\n`,
    "utf8"
  );
  return absolutePath;
}

export async function saveGeneratedUserMap(
  userMap: AppConfig["userMap"],
  dir: string,
  configPath?: string
): Promise<string> {
  const absoluteConfigPath = resolveConfigPath(configPath);
  const absolutePath = resolveGeneratedConfigPath(
    absoluteConfigPath,
    dir,
    GENERATED_USER_MAP_FILE
  );
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(userMap, null, 2)}\n`, "utf8");
  return absolutePath;
}
