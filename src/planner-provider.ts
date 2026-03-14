import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AiPlannerConfig,
  type AiPlannerProvider,
  type ClaudeAiPlannerConfig,
  type CodexAiPlannerConfig,
  type JsonObject
} from "./types.js";

interface PlannerProviderRunInput {
  config: AiPlannerConfig;
  prompt: string;
  stderr: (content: string) => void;
}

interface ProcessResult {
  stderr: string;
  stdout: string;
}

interface ProviderAdapter<TConfig extends AiPlannerConfig> {
  run: (input: {
    config: TConfig;
    prompt: string;
    schema: JsonObject;
    stderr: (content: string) => void;
  }) => Promise<string>;
}

type ClaudeEnvelope = {
  result?: unknown;
};

function nullableStringSchema(): JsonObject {
  return {
    anyOf: [{ minLength: 1, type: "string" }, { type: "null" }]
  };
}

function nullableObjectSchema(additionalProperties: JsonObject): JsonObject {
  return {
    anyOf: [
      {
        additionalProperties,
        type: "object"
      },
      { type: "null" }
    ]
  };
}

function nullableStringArraySchema(): JsonObject {
  return {
    anyOf: [
      {
        items: { minLength: 1, type: "string" },
        type: "array"
      },
      { type: "null" }
    ]
  };
}

const plannerIssueItemProperties: JsonObject = {
  assignee: nullableStringSchema(),
  body: { type: "string" },
  frontmatter: nullableObjectSchema({ $ref: "#/$defs/jsonValue" }),
  issueType: { minLength: 1, type: "string" },
  labels: nullableStringArraySchema(),
  localId: { minLength: 1, type: "string" },
  parentRef: nullableStringSchema(),
  status: nullableStringSchema(),
  summary: { minLength: 1, type: "string" }
};

const plannerResponseJsonSchema: JsonObject = {
  $defs: {
    jsonValue: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        {
          items: { $ref: "#/$defs/jsonValue" },
          type: "array"
        },
        {
          additionalProperties: { $ref: "#/$defs/jsonValue" },
          type: "object"
        }
      ]
    }
  },
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    issues: {
      items: {
        additionalProperties: false,
        properties: plannerIssueItemProperties,
        required: Object.keys(plannerIssueItemProperties),
        type: "object"
      },
      minItems: 1,
      type: "array"
    }
  },
  required: ["issues"],
  type: "object"
};

function pushOptionalArg(args: string[], flag: string, value: string | undefined): void {
  if (!value?.trim()) {
    return;
  }

  args.push(flag, value.trim());
}

function pushOptionalConfigString(
  args: string[],
  key: string,
  value: string | undefined
): void {
  if (!value?.trim()) {
    return;
  }

  args.push("-c", `${key}=${JSON.stringify(value.trim())}`);
}

function buildCodexPlannerArgs(
  config: CodexAiPlannerConfig,
  schemaPath: string,
  outputPath: string
): string[] {
  const args = [
    "exec",
    "-",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--sandbox",
    "read-only",
    "--color",
    "never"
  ];

  pushOptionalArg(args, "--profile", config.codex?.profile);
  pushOptionalArg(args, "--model", config.model);
  pushOptionalConfigString(args, "reasoning.effort", config.codex?.reasoningEffort);
  return args;
}

function buildClaudePlannerArgs(config: ClaudeAiPlannerConfig, schema: JsonObject): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--permission-mode",
    "plan",
    "--tools",
    ""
  ];

  pushOptionalArg(args, "--model", config.model);
  return args;
}

function buildCodexProfileNotFoundErrorMessage(profile: string): string {
  return [
    `Configured Codex profile "${profile}" was not found.`,
    "Remove ai.planner.codex.profile from jira-markdown.config.json to use Codex defaults,",
    'or set it to a profile name returned by "codex profile list".'
  ].join(" ");
}

function buildCodexUnsupportedReasoningEffortErrorMessage(input: {
  configuredEffort: string;
  configuredModel?: string | undefined;
  rawMessage: string;
}): string {
  const unsupportedMatch = input.rawMessage.match(
    /Unsupported value:\s*[`']([^`']+)[`']\s+is not supported with the [`']([^`']+)[`'] model\./
  );
  const reportedEffort = unsupportedMatch?.[1] ?? input.configuredEffort;
  const reportedModel = unsupportedMatch?.[2] ?? input.configuredModel;
  const supportedValuesLine = input.rawMessage.match(/Supported values are:\s*([^\n.]+)/i)?.[1];
  const supportedValues = supportedValuesLine
    ?.replace(/[`']/g, "")
    .replace(/\s*,\s*and\s+/g, ", ")
    .trim();

  return [
    `Configured Codex reasoning effort "${reportedEffort}" is not supported${
      reportedModel ? ` by model "${reportedModel}"` : ""
    }.`,
    supportedValues ? `Codex reported supported values: ${supportedValues}.` : "",
    'Set ai.planner.model to the model you intend to use, or change ai.planner.codex.reasoningEffort to a value supported by that model.'
  ]
    .filter(Boolean)
    .join(" ");
}

async function runProcess(input: {
  args: string[];
  command: string;
  prompt: string;
  stderr: (content: string) => void;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(
        new Error(`Planner command timed out after ${input.timeoutMs}ms.`)
      );
    }, input.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const content = String(chunk);
      stderr += content;
      input.stderr(content);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Planner command exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`
          )
        );
        return;
      }

      resolvePromise({ stderr, stdout });
    });

    child.stdin.end(input.prompt);
  });
}

async function withPlannerTempDirectory<T>(
  callback: (directory: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-planner-provider-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function extractClaudePlannerResult(stdout: string): string {
  let parsedEnvelope: ClaudeEnvelope;
  try {
    parsedEnvelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch (error) {
    throw new Error(
      `Claude planner returned invalid JSON envelope: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsedEnvelope.result === "string" && parsedEnvelope.result.trim()) {
    return parsedEnvelope.result.trim();
  }

  if (
    parsedEnvelope.result &&
    typeof parsedEnvelope.result === "object" &&
    !Array.isArray(parsedEnvelope.result)
  ) {
    return JSON.stringify(parsedEnvelope.result);
  }

  throw new Error('Claude planner response did not include a usable "result" field.');
}

const codexAdapter: ProviderAdapter<CodexAiPlannerConfig> = {
  async run(input) {
    return withPlannerTempDirectory(async (directory) => {
      const schemaPath = join(directory, "planner-schema.json");
      const outputPath = join(directory, "planner-result.json");
      await writeFile(
        schemaPath,
        `${JSON.stringify(input.schema, null, 2)}\n`,
        "utf8"
      );

      try {
        await runProcess({
          args: buildCodexPlannerArgs(input.config, schemaPath, outputPath),
          command: "codex",
          prompt: input.prompt,
          stderr: input.stderr,
          timeoutMs: input.config.timeoutMs
        });
      } catch (error) {
        const profile = input.config.codex?.profile?.trim();
        const reasoningEffort = input.config.codex?.reasoningEffort?.trim();
        const message = error instanceof Error ? error.message : String(error);
        if (
          profile &&
          message.includes("config profile") &&
          message.includes("not found")
        ) {
          throw new Error(buildCodexProfileNotFoundErrorMessage(profile));
        }

        if (
          reasoningEffort &&
          message.includes("unsupported_value") &&
          message.includes("reasoning.effort")
        ) {
          throw new Error(
            buildCodexUnsupportedReasoningEffortErrorMessage({
              configuredEffort: reasoningEffort,
              configuredModel: input.config.model,
              rawMessage: message
            })
          );
        }

        throw error;
      }

      const rawResult = (await readFile(outputPath, "utf8")).trim();
      if (!rawResult) {
        throw new Error("Codex planner did not write a final result message.");
      }

      return rawResult;
    });
  }
};

const claudeAdapter: ProviderAdapter<ClaudeAiPlannerConfig> = {
  async run(input) {
    const { stdout } = await runProcess({
      args: buildClaudePlannerArgs(input.config, input.schema),
      command: "claude",
      prompt: input.prompt,
      stderr: input.stderr,
      timeoutMs: input.config.timeoutMs
    });

    if (!stdout.trim()) {
      throw new Error("Claude planner returned no output.");
    }

    return extractClaudePlannerResult(stdout.trim());
  }
};

const plannerProviderAdapters: Record<AiPlannerProvider, ProviderAdapter<AiPlannerConfig>> = {
  claude: claudeAdapter as ProviderAdapter<AiPlannerConfig>,
  codex: codexAdapter as ProviderAdapter<AiPlannerConfig>
};

export async function runPlannerProvider(input: PlannerProviderRunInput): Promise<string> {
  return plannerProviderAdapters[input.config.provider].run({
    config: input.config,
    prompt: input.prompt,
    schema: plannerResponseJsonSchema,
    stderr: input.stderr
  });
}

export function getPlannerResponseJsonSchema(): JsonObject {
  return plannerResponseJsonSchema;
}

export function getCodexPlannerArgsForTest(
  config: CodexAiPlannerConfig,
  schemaPath: string,
  outputPath: string
): string[] {
  return buildCodexPlannerArgs(config, schemaPath, outputPath);
}

export function getClaudePlannerArgsForTest(
  config: ClaudeAiPlannerConfig,
  schema: JsonObject
): string[] {
  return buildClaudePlannerArgs(config, schema);
}

export function extractClaudePlannerResultForTest(stdout: string): string {
  return extractClaudePlannerResult(stdout);
}
