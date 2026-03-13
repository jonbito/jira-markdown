import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getDefaultAuthFilePath } from "./auth-store";
import {
  createDefaultAppConfig,
  getDefaultConfigFilePath,
  initAppConfig,
  loadAppConfig,
  saveGeneratedUserMap
} from "./config";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-config-"));
  tempDirectories.push(directory);
  return directory;
}

async function withWorkingDirectory<T>(
  directory: string,
  callback: () => Promise<T>
): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

describe("initAppConfig", () => {
  test("uses the same user config directory as auth metadata by default", () => {
    const defaultConfigPath = getDefaultConfigFilePath();
    const defaultAuthPath = getDefaultAuthFilePath();

    expect(dirname(defaultConfigPath)).toBe(dirname(defaultAuthPath));
    expect(basename(defaultConfigPath)).toBe("jira-markdown.config.json");
  });

  test("creates a starter config", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "nested", "jira-markdown.config.json");

    const result = await initAppConfig({ configPath });

    expect(result.created).toBe(true);
    expect(result.config.dir).toBe("issues");
    expect(result.config.projectIssueTypeFieldMap).toEqual({});
    expect(result.config.userMap).toEqual({});

    const loaded = await loadAppConfig(configPath);
    expect(loaded.config).toEqual(result.config);
  });

  test("creates a starter config from a provided config factory", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const result = await initAppConfig({
      configPath,
      createConfig: () => ({
        ...createDefaultAppConfig(),
        dir: "docs"
      })
    });

    expect(result.created).toBe(true);
    expect(result.config.dir).toBe("docs");

    const loaded = await loadAppConfig(configPath);
    expect(loaded.config.dir).toBe("docs");
  });

  test("does not overwrite an existing config unless forced", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");
    const existingConfig = {
      ...createDefaultAppConfig(),
      dir: "docs"
    };

    await writeFile(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf8");

    const result = await initAppConfig({ configPath });

    expect(result.created).toBe(false);
    expect(result.config.dir).toBe("docs");
    expect(result.config.projectIssueTypeFieldMap).toEqual({});
    expect(result.config.userMap).toEqual({});
  });

  test("overwrites an existing config when forced", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");
    const existingConfig = {
      ...createDefaultAppConfig(),
      dir: "docs"
    };

    await writeFile(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf8");

    const result = await initAppConfig({ configPath, force: true });

    expect(result.created).toBe(true);
    expect(result.config.dir).toBe("issues");
    expect(result.config.projectIssueTypeFieldMap).toEqual({});
    expect(result.config.userMap).toEqual({});

    const raw = JSON.parse(await readFile(configPath, "utf8")) as {
      projectIssueTypeFieldMap?: Record<string, unknown>;
      userMap?: Record<string, unknown>;
    };
    expect(raw.projectIssueTypeFieldMap).toBeUndefined();
    expect(raw.userMap).toBeUndefined();
  });

  test("loads generated maps from dir-root dotfiles", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");
    const fieldMapPath = join(directory, "docs", ".jira-markdown.field-map.json");
    const userMapPath = join(directory, "docs", ".jira-markdown.user-map.json");

    await writeFile(
      configPath,
      `${JSON.stringify({ dir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(
      fieldMapPath,
      `${JSON.stringify(
        {
          ENG: {
            Task: {
              priority: {
                fieldId: "priority",
                resolver: "priorityByName"
              },
              storyPoints: {
                fieldId: "customfield_10016",
                resolver: "number"
              }
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      userMapPath,
      `${JSON.stringify(
        {
          "Alice Example": {
            accountId: "557058:alice"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const loaded = await loadAppConfig(configPath);

    expect(loaded.config.dir).toBe("docs");
    expect(loaded.config.projectIssueTypeFieldMap.ENG?.Task?.priority).toEqual({
      fieldId: "priority",
      resolver: "priorityByName"
    });
    expect(loaded.config.projectIssueTypeFieldMap.ENG?.Task?.storyPoints).toEqual({
      fieldId: "customfield_10016",
      resolver: "number"
    });
    expect(loaded.config.userMap["Alice Example"]).toEqual({
      accountId: "557058:alice"
    });
  });

  test("falls back to default config when the config file is missing", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const loaded = await loadAppConfig(configPath);

    expect(loaded.config).toEqual(createDefaultAppConfig());
    expect(loaded.configPath).toBe(configPath);
  });

  test("loads generated maps from the default dir without a config file", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");
    const fieldMapPath = join(directory, "issues", ".jira-markdown.field-map.json");
    const userMapPath = join(directory, "issues", ".jira-markdown.user-map.json");

    await mkdir(join(directory, "issues"), { recursive: true });
    await writeFile(
      fieldMapPath,
      `${JSON.stringify(
        {
          ENG: {
            Task: {
              priority: {
                fieldId: "priority",
                resolver: "priorityByName"
              },
              storyPoints: {
                fieldId: "customfield_10016",
                resolver: "number"
              }
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      userMapPath,
      `${JSON.stringify(
        {
          "Alice Example": {
            accountId: "557058:alice"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const loaded = await loadAppConfig(configPath);

    expect(loaded.config.dir).toBe("issues");
    expect(loaded.config.projectIssueTypeFieldMap.ENG?.Task?.priority).toEqual({
      fieldId: "priority",
      resolver: "priorityByName"
    });
    expect(loaded.config.projectIssueTypeFieldMap.ENG?.Task?.storyPoints).toEqual({
      fieldId: "customfield_10016",
      resolver: "number"
    });
    expect(loaded.config.userMap["Alice Example"]).toEqual({
      accountId: "557058:alice"
    });
  });

  test("writes generated maps under the workspace when using the default config path", async () => {
    const directory = await createTempDirectory();

    await withWorkingDirectory(directory, async () => {
      const savedPath = await saveGeneratedUserMap(
        {
          "Alice Example": {
            accountId: "557058:alice"
          }
        },
        "issues"
      );

      expect(savedPath).toBe(join(process.cwd(), "issues", ".jira-markdown.user-map.json"));
    });
  });

  test("loads legacy files arrays as dir", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    await writeFile(
      configPath,
      `${JSON.stringify({ files: ["docs/**/*.md"] }, null, 2)}\n`,
      "utf8"
    );

    const loaded = await loadAppConfig(configPath);

    expect(loaded.config.dir).toBe("docs");
  });
});
