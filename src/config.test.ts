import { afterEach, describe, expect, test } from "./test-helpers.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getDefaultAuthFilePath } from "./auth-store.js";
import {
  createDefaultAppConfig,
  getDefaultConfigFilePath,
  initAppConfig,
  loadAppConfig,
  saveGeneratedUserMap
} from "./config.js";

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

async function withHomeDirectory<T>(
  directory: string,
  callback: () => Promise<T>
): Promise<T> {
  return withEnvironment({ HOME: directory }, callback);
}

async function withEnvironment<T>(
  updates: Record<string, string | undefined>,
  callback: () => Promise<T>
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
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

  test("expands a leading tilde in dir when loading config and generated maps", async () => {
    const fakeHomeDirectory = await createTempDirectory();
    const workspaceDirectory = await createTempDirectory();
    const configPath = join(workspaceDirectory, "jira-markdown.config.json");
    const expandedDir = join(fakeHomeDirectory, "src", "jira");
    const fieldMapPath = join(expandedDir, ".jira-markdown.field-map.json");
    const userMapPath = join(expandedDir, ".jira-markdown.user-map.json");

    await withHomeDirectory(fakeHomeDirectory, async () => {
      await writeFile(
        configPath,
        `${JSON.stringify({ dir: "~/src/jira" }, null, 2)}\n`,
        "utf8"
      );
      await mkdir(expandedDir, { recursive: true });
      await writeFile(
        fieldMapPath,
        `${JSON.stringify(
          {
            ENG: {
              Task: {
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

      expect(loaded.config.dir).toBe(expandedDir);
      expect(loaded.config.projectIssueTypeFieldMap.ENG?.Task?.storyPoints).toEqual({
        fieldId: "customfield_10016",
        resolver: "number"
      });
      expect(loaded.config.userMap["Alice Example"]).toEqual({
        accountId: "557058:alice"
      });
    });
  });

  test("writes generated maps under the expanded home directory", async () => {
    const fakeHomeDirectory = await createTempDirectory();

    await withHomeDirectory(fakeHomeDirectory, async () => {
      const savedPath = await saveGeneratedUserMap(
        {
          "Alice Example": {
            accountId: "557058:alice"
          }
        },
        "~/src/jira"
      );

      expect(savedPath).toBe(
        join(fakeHomeDirectory, "src", "jira", ".jira-markdown.user-map.json")
      );
      expect(JSON.parse(await readFile(savedPath, "utf8"))).toEqual({
        "Alice Example": {
          accountId: "557058:alice"
        }
      });
    });
  });

  test("expands shell-style environment variables in dir when loading config", async () => {
    const fakeHomeDirectory = await createTempDirectory();
    const workspaceDirectory = await createTempDirectory();
    const configPath = join(workspaceDirectory, "jira-markdown.config.json");
    const expandedDir = join(fakeHomeDirectory, "src", "jira");
    const userMapPath = join(expandedDir, ".jira-markdown.user-map.json");

    await withEnvironment({ HOME: fakeHomeDirectory }, async () => {
      await writeFile(
        configPath,
        `${JSON.stringify({ dir: "$HOME/src/jira" }, null, 2)}\n`,
        "utf8"
      );
      await mkdir(expandedDir, { recursive: true });
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

      expect(loaded.config.dir).toBe(expandedDir);
      expect(loaded.config.userMap["Alice Example"]).toEqual({
        accountId: "557058:alice"
      });
    });
  });

  test("expands percent-style environment variables when writing generated maps", async () => {
    const fakeAppDataDirectory = await createTempDirectory();

    await withEnvironment({ APPDATA: fakeAppDataDirectory }, async () => {
      const savedPath = await saveGeneratedUserMap(
        {
          "Alice Example": {
            accountId: "557058:alice"
          }
        },
        "%APPDATA%/jira-markdown/issues"
      );

      expect(savedPath).toBe(
        join(
          fakeAppDataDirectory,
          "jira-markdown",
          "issues",
          ".jira-markdown.user-map.json"
        )
      );
      expect(JSON.parse(await readFile(savedPath, "utf8"))).toEqual({
        "Alice Example": {
          accountId: "557058:alice"
        }
      });
    });
  });
});
