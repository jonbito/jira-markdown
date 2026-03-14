import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "./test-helpers.js";
import { createDefaultAppConfig } from "./config.js";
import {
  extractClaudePlannerResultForTest,
  getClaudePlannerArgsForTest,
  getCodexPlannerArgsForTest,
  getPlannerResponseJsonSchema
} from "./planner-provider.js";
import { buildEpicPlannerPrompt, planEpic } from "./planner.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-planner-"));
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
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createExecutableScript(directory: string, name: string, lines: string[]): Promise<string> {
  const scriptPath = join(directory, name);
  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("buildEpicPlannerPrompt", () => {
  test("includes project field mappings and local examples", async () => {
    const directory = await createTempDirectory();
    const issuesDirectory = join(directory, "issues", "ENG");
    await mkdir(issuesDirectory, { recursive: true });
    await writeFile(
      join(issuesDirectory, "ENG-1 - Existing epic.md"),
      [
        "---",
        "issue: ENG-1",
        "issueType: Epic",
        "summary: Existing epic",
        "storyPoints: 8",
        "---",
        "",
        "# Existing epic",
        "",
        "Already planned"
      ].join("\n"),
      "utf8"
    );

    const config = {
      ...createDefaultAppConfig(),
      projectIssueTypeFieldMap: {
        ENG: {
          Epic: {
            storyPoints: {
              fieldId: "customfield_10016",
              resolver: "number" as const
            }
          },
          Subtask: {},
          Task: {}
        }
      }
    };

    const prompt = await withWorkingDirectory(directory, () =>
      buildEpicPlannerPrompt({
        config,
        hierarchy: {
          childIssueTypes: ["Task"],
          epicIssueType: "Epic",
          subtaskIssueType: "Subtask"
        },
        projectKey: "ENG",
        requirement: "Build a better onboarding flow."
      })
    );

    expect(prompt).toContain('"storyPoints"');
    expect(prompt).toContain("Discovered project issue types: Epic, Subtask, Task");
    expect(prompt).toContain("Allowed direct child issue types: Task");
    expect(prompt).toContain(
      "Do not repeat the summary as the first heading or first line of the markdown body."
    );
    expect(prompt).toContain("issues/ENG/ENG-1 - Existing epic.md");
    expect(prompt).toContain("Build a better onboarding flow.");
  });
});

describe("planner provider adapters", () => {
  test("builds codex args for structured non-mutating execution", () => {
    const args = getCodexPlannerArgsForTest(
      {
        codex: {
          profile: "work",
          reasoningEffort: "xhigh"
        },
        model: "gpt-5.4",
        provider: "codex",
        timeoutMs: 60000
      },
      "/tmp/schema.json",
      "/tmp/result.json"
    );

    expect(args).toContain("exec");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("--profile");
    expect(args).toContain("work");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.4");
    expect(args).toContain("-c");
    expect(args).toContain('reasoning.effort="xhigh"');
    expect(args).not.toContain("--json");
  });

  test("builds claude args for structured JSON output with tools disabled", () => {
    const args = getClaudePlannerArgsForTest(
      {
        model: "sonnet",
        provider: "claude",
        timeoutMs: 45000
      },
      getPlannerResponseJsonSchema()
    );

    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--tools");
    expect(args).toContain("");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
  });

  test("extracts Claude result content from the JSON envelope", () => {
    expect(
      extractClaudePlannerResultForTest(
        JSON.stringify({
          result: '{"issues":[{"localId":"root","issueType":"Epic","summary":"Root","body":"# Root"}]}'
        })
      )
    ).toContain('"issues"');
  });

  test("builds a Codex schema that requires every issue property", () => {
    const schema = getPlannerResponseJsonSchema() as {
      properties: {
        issues: {
          items: {
            properties: Record<string, unknown>;
            required: string[];
          }
        }
      }
    };
    const itemSchema = schema.properties.issues.items;

    expect(itemSchema.required.sort()).toEqual(Object.keys(itemSchema.properties).sort());
  });
});

describe("planEpic", () => {
  test("writes planned draft issues from the Codex provider", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    const promptCapturePath = join(directory, "codex-prompt.txt");
    const argsCapturePath = join(directory, "codex-args.txt");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Ship multi-team onboarding automation.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$JIRA_MARKDOWN_TEST_ARGS"',
      'cat > "$JIRA_MARKDOWN_TEST_PROMPT"',
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s' '{\"issues\":[{\"assignee\":null,\"body\":\"# Onboarding epic\\\\n\\\\nPlan the rollout\",\"frontmatter\":{\"priority\":\"High\"},\"issueType\":\"Epic\",\"labels\":[\"planning\"],\"localId\":\"onboarding-epic\",\"parentRef\":null,\"status\":null,\"summary\":\"Onboarding epic\"},{\"assignee\":null,\"body\":\"# Automate onboarding steps\\\\n\\\\nBuild workflow\",\"frontmatter\":{\"storyPoints\":5},\"issueType\":\"Task\",\"labels\":null,\"localId\":\"story-automation\",\"parentRef\":\"onboarding-epic\",\"status\":null,\"summary\":\"Automate onboarding steps\"},{\"assignee\":null,\"body\":\"# Implement API integration\\\\n\\\\nWire the endpoint\",\"frontmatter\":null,\"issueType\":\"Subtask\",\"labels\":null,\"localId\":\"subtask-api\",\"parentRef\":\"story-automation\",\"status\":null,\"summary\":\"Implement API integration\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              codex: {
                profile: "work",
                reasoningEffort: "xhigh"
              },
              model: "gpt-5.4",
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues",
          projectIssueTypeFieldMap: {
            ENG: {
              Epic: {},
              Task: {
                storyPoints: {
                  fieldId: "customfield_10016",
                  resolver: "number"
                }
              },
              Subtask: {}
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        JIRA_MARKDOWN_TEST_ARGS: argsCapturePath,
        JIRA_MARKDOWN_TEST_PROMPT: promptCapturePath,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          const result = await planEpic({
            configPath,
            inputPath,
            projectKey: "ENG"
          });

          expect(result.drafts).toHaveLength(3);
        });
      }
    );

    const epicPath = join(
      directory,
      "issues",
      "ENG",
      "_drafts",
      "onboarding-epic",
      "onboarding-epic.md"
    );
    const storyPath = join(
      directory,
      "issues",
      "ENG",
      "_drafts",
      "onboarding-epic",
      "story-automation.md"
    );

    expect(await readFile(epicPath, "utf8")).toContain("localId: onboarding-epic");
    expect(await readFile(epicPath, "utf8")).toContain("priority: High");
    expect(await readFile(storyPath, "utf8")).toContain("parentRef: onboarding-epic");
    expect(await readFile(promptCapturePath, "utf8")).toContain("Target project: ENG");
    expect(await readFile(promptCapturePath, "utf8")).toContain(
      "Use null for optional fields when you have no value"
    );
    const argsText = await readFile(argsCapturePath, "utf8");
    expect(argsText).toContain("exec");
    expect(argsText).toContain("--output-schema");
    expect(argsText).toContain("--output-last-message");
    expect(argsText).toContain("--sandbox");
    expect(argsText).toContain("read-only");
  });

  test("strips a redundant leading summary heading from planned issue bodies", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a cleaner issue body.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat >/dev/null',
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s' '{\"issues\":[{\"assignee\":null,\"body\":\"# Root epic\\n\\nActual description\",\"frontmatter\":null,\"issueType\":\"Epic\",\"labels\":null,\"localId\":\"root-epic\",\"parentRef\":null,\"status\":null,\"summary\":\"Root epic\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues",
          projectIssueTypeFieldMap: {
            ENG: {
              Epic: {},
              Task: {},
              Subtask: {}
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await planEpic({
            configPath,
            inputPath,
            projectKey: "ENG"
          });
        });
      }
    );

    const epicPath = join(
      directory,
      "issues",
      "ENG",
      "_drafts",
      "root-epic",
      "root-epic.md"
    );
    const content = await readFile(epicPath, "utf8");

    expect(content).toContain("Actual description");
    expect(content).not.toContain("# Root epic");
  });

  test("derives allowed child issue types from project context and rejects unsupported ones", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    const promptCapturePath = join(directory, "codex-prompt.txt");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan project-specific work.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat > "$JIRA_MARKDOWN_TEST_PROMPT"',
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s' '{\"issues\":[{\"assignee\":null,\"body\":\"# Root epic\",\"frontmatter\":null,\"issueType\":\"Epic\",\"labels\":null,\"localId\":\"root-epic\",\"parentRef\":null,\"status\":null,\"summary\":\"Root epic\"},{\"assignee\":null,\"body\":\"# Invalid child\",\"frontmatter\":null,\"issueType\":\"Story\",\"labels\":null,\"localId\":\"invalid-story\",\"parentRef\":\"root-epic\",\"status\":null,\"summary\":\"Invalid child\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues",
          projectIssueTypeFieldMap: {
            ENG: {
              Bug: {},
              Epic: {},
              Task: {},
              Subtask: {}
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        JIRA_MARKDOWN_TEST_PROMPT: promptCapturePath,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await expect(
            planEpic({
              configPath,
              inputPath,
              projectKey: "ENG"
            })
          ).rejects.toThrow(
            'Planner returned unsupported issue type "Story" for invalid-story.'
          );
        });
      }
    );

    expect(await readFile(promptCapturePath, "utf8")).toContain(
      "Do not create issue types outside this project set: Bug, Epic, Task, Subtask."
    );
    expect(await readFile(promptCapturePath, "utf8")).toContain(
      "Allowed direct child issue types: Bug, Task"
    );
  });

  test("suppresses provider stderr by default and shows a progress line", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a quiet epic.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat >/dev/null',
      "printf '%s\\n' 'planner noise' >&2",
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s' '{\"issues\":[{\"assignee\":null,\"body\":\"# Quiet epic\",\"frontmatter\":null,\"issueType\":\"Epic\",\"labels\":null,\"localId\":\"quiet-epic\",\"parentRef\":null,\"status\":null,\"summary\":\"Quiet epic\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await planEpic({
            configPath,
            inputPath,
            projectKey: "ENG",
            stderr: (content) => stderrChunks.push(content),
            stdout: (content) => stdoutChunks.push(content)
          });
        });
      }
    );

    expect(stderrChunks.join("")).toBe("");
    expect(stdoutChunks.join("")).toContain("[PLAN] Running codex planner...");
  });

  test("forwards provider stderr when verbose is enabled", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    const stderrChunks: string[] = [];
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a verbose epic.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat >/dev/null',
      "printf '%s\\n' 'planner noise' >&2",
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s' '{\"issues\":[{\"assignee\":null,\"body\":\"# Verbose epic\",\"frontmatter\":null,\"issueType\":\"Epic\",\"labels\":null,\"localId\":\"verbose-epic\",\"parentRef\":null,\"status\":null,\"summary\":\"Verbose epic\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await planEpic({
            configPath,
            inputPath,
            projectKey: "ENG",
            stderr: (content) => stderrChunks.push(content),
            stdout: () => {},
            verbose: true
          });
        });
      }
    );

    expect(stderrChunks.join("")).toContain("planner noise");
  });

  test("surfaces a clear error when a configured Codex profile does not exist", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a new epic.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat >/dev/null',
      "printf '%s\\n' 'Error: config profile `work` not found' >&2",
      "exit 1"
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              codex: {
                profile: "work"
              },
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await expect(
            planEpic({
              configPath,
              inputPath,
              projectKey: "ENG"
            })
          ).rejects.toThrow(
            'Configured Codex profile "work" was not found. Remove ai.planner.codex.profile from jira-markdown.config.json to use Codex defaults, or set it to a profile name returned by "codex profile list".'
          );
        });
      }
    );
  });

  test("surfaces a clear error when a configured Codex reasoning effort is unsupported", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a new epic.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'cat >/dev/null',
      "printf '%s\\n' 'ERROR: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"code\":\"unsupported_value\",\"message\":\"Unsupported value: `xhigh` is not supported with the `codex-1p-q-20251024-ev3` model. Supported values are: `low`, `medium`, and `high`.\",\"param\":\"reasoning.effort\"},\"status\":400}' >&2",
      "exit 1"
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              codex: {
                reasoningEffort: "xhigh"
              },
              model: "gpt-5.4",
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await expect(
            planEpic({
              configPath,
              inputPath,
              projectKey: "ENG"
            })
          ).rejects.toThrow(
            'Configured Codex reasoning effort "xhigh" is not supported by model "codex-1p-q-20251024-ev3".'
          );
        });
      }
    );
  });

  test("writes planned draft issues from the Claude provider", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    const promptCapturePath = join(directory, "claude-prompt.txt");
    const argsCapturePath = join(directory, "claude-args.txt");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a new customer onboarding program.", "utf8");
    await createExecutableScript(binDirectory, "claude", [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$JIRA_MARKDOWN_TEST_ARGS"',
      'cat > "$JIRA_MARKDOWN_TEST_PROMPT"',
      "printf '%s' '{\"result\":\"{\\\"issues\\\":[{\\\"localId\\\":\\\"customer-epic\\\",\\\"issueType\\\":\\\"Epic\\\",\\\"summary\\\":\\\"Customer onboarding epic\\\",\\\"body\\\":\\\"# Customer onboarding epic\\\\n\\\\nDefine the program\\\"},{\\\"localId\\\":\\\"customer-story\\\",\\\"parentRef\\\":\\\"customer-epic\\\",\\\"issueType\\\":\\\"Story\\\",\\\"summary\\\":\\\"Prepare onboarding workflow\\\",\\\"body\\\":\\\"# Prepare onboarding workflow\\\\n\\\\nBuild the flow\\\"},{\\\"localId\\\":\\\"customer-subtask\\\",\\\"parentRef\\\":\\\"customer-story\\\",\\\"issueType\\\":\\\"Subtask\\\",\\\"summary\\\":\\\"Create API checklist\\\",\\\"body\\\":\\\"# Create API checklist\\\\n\\\\nDocument the endpoint\\\"}]}\"}'"
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              model: "sonnet",
              provider: "claude",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        JIRA_MARKDOWN_TEST_ARGS: argsCapturePath,
        JIRA_MARKDOWN_TEST_PROMPT: promptCapturePath,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          const result = await planEpic({
            configPath,
            inputPath,
            projectKey: "ENG"
          });

          expect(result.drafts).toHaveLength(3);
        });
      }
    );

    const epicPath = join(
      directory,
      "issues",
      "ENG",
      "_drafts",
      "customer-epic",
      "customer-epic.md"
    );
    const subtaskPath = join(
      directory,
      "issues",
      "ENG",
      "_drafts",
      "customer-epic",
      "customer-subtask.md"
    );

    expect(await readFile(epicPath, "utf8")).toContain("localId: customer-epic");
    expect(await readFile(subtaskPath, "utf8")).toContain("parentRef: customer-story");
    expect(await readFile(promptCapturePath, "utf8")).toContain("Target project: ENG");
    const argsText = await readFile(argsCapturePath, "utf8");
    expect(argsText).toContain("-p");
    expect(argsText).toContain("--output-format");
    expect(argsText).toContain("json");
    expect(argsText).toContain("--json-schema");
    expect(argsText).toContain("--tools");
    expect(argsText).toContain("--permission-mode");
  });

  test("rejects invalid planner hierarchies from a provider response", async () => {
    const directory = await createTempDirectory();
    const binDirectory = join(directory, "bin");
    const configPath = join(directory, "jira-markdown.config.json");
    const inputPath = join(directory, "requirement.md");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(inputPath, "Plan a broken hierarchy.", "utf8");
    await createExecutableScript(binDirectory, "codex", [
      "#!/bin/sh",
      'output_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    output_file="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'cat >/dev/null',
      "printf '%s' '{\"issues\":[{\"localId\":\"root\",\"issueType\":\"Epic\",\"summary\":\"Root\",\"body\":\"# Root\"},{\"localId\":\"child\",\"parentRef\":\"missing\",\"issueType\":\"Story\",\"summary\":\"Child\",\"body\":\"# Child\"}]}' > \"$output_file\""
    ]);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ai: {
            planner: {
              provider: "codex",
              timeoutMs: 60000
            }
          },
          dir: "issues"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await withEnvironment(
      {
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`
      },
      async () => {
        await withWorkingDirectory(directory, async () => {
          await expect(
            planEpic({
              configPath,
              inputPath,
              projectKey: "ENG"
            })
          ).rejects.toThrow('parentRef "missing"');
        });
      }
    );
  });
});
