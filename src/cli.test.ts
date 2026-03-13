import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-cli-"));
  tempDirectories.push(directory);
  return directory;
}

async function createEditorScript(directory: string): Promise<{
  editor: string;
  outputPath: string;
}> {
  const scriptPath = join(directory, "editor.sh");
  const outputPath = join(directory, "editor-output.txt");

  await writeFile(
    scriptPath,
    ['#!/bin/sh', 'printf "%s\\n" "$@" > "$JIRA_MARKDOWN_TEST_EDITOR_OUTPUT"'].join(
      "\n"
    ),
    "utf8"
  );
  await chmod(scriptPath, 0o755);

  return {
    editor: `${scriptPath} --wait`,
    outputPath
  };
}

describe("cli config auto-init", () => {
  test("auth status does not auto-create config when it is missing", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");
    const authFilePath = join(directory, "auth.json");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "auth", "status"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JIRA_MARKDOWN_AUTH_FILE: authFilePath,
          JIRA_MARKDOWN_CONFIG_FILE: configPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("No Jira auth is configured.");
    expect(stdout).not.toContain("Initialized starter config");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("auth login help does not create config just to show usage", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "auth", "login", "--help"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JIRA_MARKDOWN_CONFIG_FILE: configPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Store Jira authentication for future CLI use.");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("sprints help does not create config just to show usage", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "sprints", "--help"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JIRA_MARKDOWN_CONFIG_FILE: configPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("List sprints for a board so sprint names can be mapped to ids.");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("sync help describes dry-run as leaving Jira and local files unchanged", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "sync", "--help"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JIRA_MARKDOWN_CONFIG_FILE: configPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "Preview push payloads and pull file writes without changing Jira, local files, or sync history"
    );
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("push dry-run without local files explains how to get started", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "custom.config.json");
    const authFilePath = join(directory, "auth.json");
    await writeFile(
      authFilePath,
      JSON.stringify(
        {
          authMode: "basic",
          baseUrl: "https://example.atlassian.net",
          email: "you@example.com",
          secretStorage: "file",
          token: "secret-token",
          updatedAt: "2026-03-12T00:00:00.000Z",
          version: 1
        },
        null,
        2
      ),
      "utf8"
    );

    let thrown: Error & {
      stderr?: string;
      stdout?: string;
    };
    try {
      await execFileAsync(
        process.execPath,
        [
          "run",
          join(process.cwd(), "src/cli.ts"),
          "push",
          "--dry-run",
          "--on-conflict",
          "keep-local",
          "--config",
          configPath
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            JIRA_MARKDOWN_AUTH_FILE: authFilePath,
            JIRA_MARKDOWN_CONFIG_FILE: join(directory, "ignored-default-config.json")
          }
        }
      );
      throw new Error("Expected push --dry-run to fail without local markdown files.");
    } catch (error) {
      thrown = error as Error & {
        stderr?: string;
        stdout?: string;
      };
    }

    expect(thrown.stdout).toContain(`Initialized starter config at ${configPath}.`);
    expect(thrown.stderr).toContain(
      "No markdown files found under issues. Create a local issue file under issues/<PROJECT>/ or start with pull --project <KEY>."
    );
  });

  test("commands with --config auto-create that config path before running", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "custom.config.json");
    const authFilePath = join(directory, "auth.json");

    let thrown: Error & {
      stderr?: string;
      stdout?: string;
    };
    try {
      await execFileAsync(
        process.execPath,
        [
          "run",
          "src/cli.ts",
          "push",
          "--dry-run",
          "--on-conflict",
          "keep-local",
          "--config",
          configPath
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            JIRA_MARKDOWN_AUTH_FILE: authFilePath,
            JIRA_MARKDOWN_CONFIG_FILE: join(directory, "ignored-default-config.json")
          }
        }
      );
      throw new Error("Expected push --dry-run to fail without Jira auth.");
    } catch (error) {
      thrown = error as Error & {
        stderr?: string;
        stdout?: string;
      };
    }

    expect(thrown.stdout).toContain(`Initialized starter config at ${configPath}.`);
    expect(thrown.stderr).toContain('Jira auth is not configured. Run "jira-markdown auth login" first.');

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      dir?: string;
    };
    expect(parsed.dir).toBe("issues");
  });

  test("config edit opens the resolved config path with $EDITOR", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "custom path", "jira config.json");
    const { editor, outputPath } = await createEditorScript(directory);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "config", "edit"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EDITOR: editor,
          JIRA_MARKDOWN_CONFIG_FILE: configPath,
          JIRA_MARKDOWN_TEST_EDITOR_OUTPUT: outputPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain(`Initialized starter config at ${configPath}.`);
    expect(await readFile(outputPath, "utf8")).toBe(`--wait\n${configPath}\n`);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      dir?: string;
    };
    expect(parsed.dir).toBe("issues");
  });

  test("config edit fails without EDITOR before creating the config", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    let thrown: Error & {
      stderr?: string;
      stdout?: string;
    };
    try {
      await execFileAsync(
        process.execPath,
        ["run", "src/cli.ts", "config", "edit"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            EDITOR: "",
            JIRA_MARKDOWN_CONFIG_FILE: configPath
          }
        }
      );
      throw new Error("Expected config edit to fail without EDITOR.");
    } catch (error) {
      thrown = error as Error & {
        stderr?: string;
        stdout?: string;
      };
    }

    expect(thrown.stderr).toContain("EDITOR is not set.");
    expect(thrown.stdout).toBe("");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("inspect adf exposes a dedicated help surface", async () => {
    const directory = await createTempDirectory();
    const configPath = join(directory, "jira-markdown.config.json");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["run", "src/cli.ts", "inspect", "adf", "--help"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JIRA_MARKDOWN_CONFIG_FILE: configPath
        }
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Print the raw Jira ADF description for an issue.");
    expect(stdout).toContain("inspect adf");
    expect(stdout).not.toContain("--config");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
