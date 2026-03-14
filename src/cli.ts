#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Command, Option, type OptionValues } from "commander";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { authLogin, authLogout, authStatus } from "./auth.js";
import { createDefaultAppConfig, initAppConfig } from "./config.js";
import { inspectIssueAdf } from "./inspect.js";
import { planEpic } from "./planner.js";
import {
  listSprints,
  pullJiraToMarkdown,
  pushMarkdownToJira,
  syncMarkdownToJira
} from "./sync.js";
import {
  type ConflictMode,
  type ConflictResolution
} from "./types.js";

function collectProjectOption(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  ];
}

function collectListOption(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  ];
}

async function promptIssueDirectory(defaultValue: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return defaultValue;
  }

  const rl = createInterface({ input, output });

  try {
    const answer = (
      await rl.question(`Where should Jira issues be stored? [${defaultValue}]: `)
    ).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptConflictResolution(inputValue: {
  filePath: string;
  issueKey: string;
  summary: string;
}): Promise<ConflictResolution> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Conflict resolution prompting requires an interactive terminal. Re-run with --on-conflict keep-local, --on-conflict keep-jira, or --on-conflict fail."
    );
  }

  const rl = createInterface({ input, output });

  try {
    while (true) {
      const answer = (
        await rl.question(
          [
            `Conflict detected for ${inputValue.issueKey} (${inputValue.summary})`,
            `${inputValue.filePath}`,
            "Keep [l]ocal, keep [j]ira, or [a]bort? "
          ].join("\n")
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "l" || answer === "local" || answer === "keep-local") {
        return "keep-local";
      }

      if (answer === "j" || answer === "jira" || answer === "keep-jira") {
        return "keep-jira";
      }

      if (answer === "a" || answer === "abort" || answer === "fail") {
        return "abort";
      }
    }
  } finally {
    rl.close();
  }
}

function resolveConflictMode(optionValue: ConflictMode | undefined): ConflictMode {
  if (optionValue) {
    return optionValue;
  }

  return input.isTTY && output.isTTY ? "prompt" : "fail";
}

async function createStarterConfig() {
  const config = createDefaultAppConfig();
  config.dir = await promptIssueDirectory(config.dir);
  return config;
}

async function ensureConfigInitialized(configPath?: string): Promise<void> {
  const result = await initAppConfig({
    createConfig: createStarterConfig,
    configPath
  });

  if (result.created) {
    console.log(`Initialized starter config at ${result.configPath}.`);
  }
}

function shouldSkipAutomaticConfigInit(actionCommand: Command): boolean {
  const parentName = actionCommand.parent?.name();
  return (
    parentName === "auth" ||
    parentName === "config" ||
    parentName === "inspect" ||
    actionCommand.name() === "sprints"
  );
}

function requireEditor(env = process.env): string {
  const editor = env.EDITOR?.trim();

  if (!editor) {
    throw new Error(
      'EDITOR is not set. Set $EDITOR to a command such as "vim" or "code --wait".'
    );
  }

  return editor;
}

async function openFileInEditor(
  filePath: string,
  editor: string,
  env = process.env
): Promise<void> {
  const shell = env.SHELL?.trim() || "/bin/sh";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      shell,
      ["-lc", 'eval "exec $EDITOR \\"$JIRA_MARKDOWN_EDIT_FILE\\""'],
      {
        env: {
          ...env,
          EDITOR: editor,
          JIRA_MARKDOWN_EDIT_FILE: filePath
        },
        stdio: "inherit"
      }
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`EDITOR exited due to signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`EDITOR exited with code ${code}.`));
        return;
      }

      resolve();
    });
  });
}

const program = new Command();

program
  .name("jira-markdown")
  .description("Sync markdown files and YAML frontmatter into Jira issues.");

program.hook("preAction", async (_thisCommand, actionCommand) => {
  if (shouldSkipAutomaticConfigInit(actionCommand)) {
    return;
  }

  const options = actionCommand.optsWithGlobals<OptionValues>() as {
    config?: string | undefined;
  };
  await ensureConfigInitialized(options.config);
});

const auth = program.command("auth").description("Manage Jira authentication.");

auth
  .command("login")
  .description("Store Jira authentication for future CLI use.")
  .addOption(
    new Option("--auth-mode <mode>", "Authentication mode")
      .choices(["basic", "bearer"])
  )
  .option("--base-url <url>", "Jira base URL, for example https://your-domain.atlassian.net")
  .option("--email <email>", "Jira account email for basic auth")
  .option("--token <token>", "Jira API token or bearer token")
  .addOption(
    new Option("--storage <kind>", "Credential storage backend")
      .choices(["auto", "file", "keychain"])
      .default("auto")
  )
  .option("--no-verify", "Skip Jira credential verification before saving")
  .action(async (options) => {
    await authLogin({
      authMode: options.authMode,
      baseUrl: options.baseUrl,
      email: options.email,
      storage: options.storage,
      token: options.token,
      verify: options.verify
    });
  });

auth
  .command("status")
  .description("Show the currently stored Jira authentication.")
  .action(async () => {
    await authStatus();
  });

auth
  .command("logout")
  .description("Remove stored Jira authentication.")
  .action(async () => {
    await authLogout();
  });

const configCommand = program
  .command("config")
  .description("Manage sync configuration.");

configCommand
  .command("init")
  .description("Create a starter config file and prompt for the issue storage path.")
  .option("-c, --config <path>", "Path to config file")
  .option("--force", "Overwrite an existing config file", false)
  .action(async (options) => {
    const result = await initAppConfig({
      createConfig: createStarterConfig,
      configPath: options.config,
      force: options.force
    });

    if (result.created) {
      console.log(`Initialized starter config at ${result.configPath}.`);
      return;
    }

    console.log(`Config already exists at ${result.configPath}. Use --force to overwrite it.`);
  });

configCommand
  .command("edit")
  .description("Open the config file in $EDITOR, creating it if needed.")
  .action(async () => {
    const editor = requireEditor();

    const result = await initAppConfig();

    if (result.created) {
      console.log(`Initialized starter config at ${result.configPath}.`);
    }

    await openFileInEditor(result.configPath, editor);
  });

const inspectCommand = program
  .command("inspect")
  .description("Inspect remote Jira issue data.");

inspectCommand
  .command("adf <issueKey>")
  .description("Print the raw Jira ADF description for an issue.")
  .action(async (issueKey: string) => {
    await inspectIssueAdf(issueKey);
  });

const planCommand = program
  .command("plan")
  .description("Generate draft Jira issue hierarchies with an external AI planner.");

planCommand
  .command("epic")
  .description("Plan a new epic and write draft markdown issues under the target project.")
  .requiredOption("--project <key>", "Jira project key to plan under")
  .option("-c, --config <path>", "Path to config file")
  .option("--input <path>", "Read the business requirement from a file")
  .option("--dry-run", "Preview the draft files without writing them", false)
  .option("--print-prompt", "Print the assembled planner prompt without invoking the AI command", false)
  .option("--verbose", "Show raw AI planner stderr while planning", false)
  .option("--epic-type <name>", "Root issue type to generate. Defaults to Epic.")
  .option(
    "--child-type <name>",
    "Allowed direct child issue type (repeatable or comma-separated). Defaults to the project's discovered non-epic issue types.",
    collectListOption
  )
  .option(
    "--subtask-type <name>",
    "Allowed grandchild sub-task issue type. Defaults to Subtask."
  )
  .action(async (options) => {
    await planEpic({
      childIssueTypes: options.childType,
      configPath: options.config,
      dryRun: options.dryRun,
      epicIssueType: options.epicType,
      inputPath: options.input,
      printPrompt: options.printPrompt,
      projectKey: options.project,
      subtaskIssueType: options.subtaskType,
      verbose: options.verbose
    });
  });

program
  .command("push")
  .description("Push local markdown changes to Jira and rename files to canonical paths.")
  .option("-c, --config <path>", "Path to config file")
  .option(
    "--dry-run",
    "Preview Jira payloads without changing Jira, local files, or sync history",
    false
  )
  .addOption(
    new Option("--on-conflict <mode>", "Concurrent local/Jira change handling")
      .choices(["prompt", "keep-local", "keep-jira", "fail"])
  )
  .option(
    "--no-write-back",
    "Do not write newly created issue keys back into markdown frontmatter"
  )
  .action(async (options) => {
    const onConflict = resolveConflictMode(options.onConflict);
    await pushMarkdownToJira({
      configPath: options.config,
      dryRun: options.dryRun,
      onConflict,
      resolveConflict: onConflict === "prompt" ? promptConflictResolution : undefined,
      writeBack: options.writeBack
    });
  });

program
  .command("pull")
  .description("Pull Jira issues into canonical markdown files under project folders.")
  .option("-c, --config <path>", "Path to config file")
  .option(
    "--project <key>",
    "Jira project key to pull (repeatable or comma-separated)",
    collectProjectOption,
    []
  )
  .option(
    "--jql <clause>",
    "Additional JQL filter clause applied within each selected project"
  )
  .addOption(
    new Option("--on-conflict <mode>", "Concurrent local/Jira change handling")
      .choices(["prompt", "keep-local", "keep-jira", "fail"])
  )
  .option(
    "--dry-run",
    "Preview the files that would be written without changing local files or sync history",
    false
  )
  .action(async (options) => {
    const onConflict = resolveConflictMode(options.onConflict);
    await pullJiraToMarkdown({
      configPath: options.config,
      dryRun: options.dryRun,
      jql: options.jql,
      onConflict,
      projects: options.project,
      resolveConflict: onConflict === "prompt" ? promptConflictResolution : undefined
    });
  });

program
  .command("sync")
  .description("Run push and then pull.")
  .option("-c, --config <path>", "Path to config file")
  .option(
    "--project <key>",
    "Jira project key to pull after push (repeatable or comma-separated)",
    collectProjectOption,
    []
  )
  .option(
    "--jql <clause>",
    "Additional JQL filter clause applied during sync's pull step within each selected project"
  )
  .option(
    "--dry-run",
    "Preview push payloads and pull file writes without changing Jira, local files, or sync history",
    false
  )
  .addOption(
    new Option("--on-conflict <mode>", "Concurrent local/Jira change handling")
      .choices(["prompt", "keep-local", "keep-jira", "fail"])
  )
  .option(
    "--no-write-back",
    "Do not write newly created issue keys back into markdown frontmatter"
  )
  .action(async (options) => {
    const onConflict = resolveConflictMode(options.onConflict);
    await syncMarkdownToJira({
      configPath: options.config,
      dryRun: options.dryRun,
      jql: options.jql,
      onConflict,
      projects: options.project,
      resolveConflict: onConflict === "prompt" ? promptConflictResolution : undefined,
      writeBack: options.writeBack
    });
  });

program
  .command("sprints")
  .description("List sprints for a board so sprint names can be mapped to ids.")
  .requiredOption("--board <id>", "Jira board id", Number)
  .option("--state <value>", "Sprint states, for example active,future")
  .action(async (options) => {
    await listSprints(options.board, options.state);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
