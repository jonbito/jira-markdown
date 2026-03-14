import { mkdir, readFile, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { loadAppConfig } from "./config.js";
import { collectMarkdownFiles } from "./file-discovery.js";
import { loadMarkdownDocument } from "./markdown.js";
import { runPlannerProvider } from "./planner-provider.js";
import { inferProjectKeyFromFilePath } from "./project-path.js";
import {
  RESERVED_FRONTMATTER_KEYS,
  type AppConfig,
  type JsonObject,
  type JsonValue
} from "./types.js";

const DEFAULT_CHILD_ISSUE_TYPES = ["Story", "Task"];
const DEFAULT_EPIC_ISSUE_TYPE = "Epic";
const DEFAULT_SUBTASK_ISSUE_TYPE = "Subtask";
const EXAMPLE_LIMIT = 3;
const PROMPT_SEPARATOR = `${EOL}---${EOL}`;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

function optionalPlannerStringSchema() {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().min(1).optional()
  );
}

function optionalPlannerFrontmatterSchema() {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z.record(z.string(), jsonValueSchema).optional()
  );
}

function optionalPlannerLabelsSchema() {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(z.string().min(1)).optional()
  );
}

const plannerIssueSchema = z.object({
  assignee: optionalPlannerStringSchema(),
  body: z.string(),
  frontmatter: optionalPlannerFrontmatterSchema(),
  issueType: z.string().min(1),
  labels: optionalPlannerLabelsSchema(),
  localId: z.string().min(1),
  parentRef: optionalPlannerStringSchema(),
  status: optionalPlannerStringSchema(),
  summary: z.string().min(1)
}).strict();

const plannerResponseSchema = z.object({
  issues: z.array(plannerIssueSchema).min(1)
});

export interface PlanEpicOptions {
  childIssueTypes?: string[] | undefined;
  configPath?: string | undefined;
  dryRun?: boolean | undefined;
  epicIssueType?: string | undefined;
  inputPath?: string | undefined;
  printPrompt?: boolean | undefined;
  projectKey: string;
  stderr?: (content: string) => void;
  stdin?: NodeJS.ReadStream;
  stdout?: (content: string) => void;
  subtaskIssueType?: string | undefined;
  verbose?: boolean | undefined;
}

export interface PlannedIssueDraft {
  content: string;
  filePath: string;
  localId: string;
  parentRef?: string | undefined;
}

interface PlannerHierarchyOptions {
  childIssueTypes: string[];
  epicIssueType: string;
  subtaskIssueType: string;
}

interface ProjectExample {
  filePath: string;
  raw: string;
}

interface ProjectPlanningContext {
  examples: ProjectExample[];
  issueTypes: string[];
}

function normalizeLookupKey(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

function sanitizeDraftSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!sanitized) {
    throw new Error(`Cannot derive a draft path segment from "${value}".`);
  }

  return sanitized.slice(0, 120);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const lookupKey = normalizeLookupKey(trimmed);
    if (seen.has(lookupKey)) {
      continue;
    }

    seen.add(lookupKey);
    result.push(trimmed);
  }

  return result;
}

function normalizeSummaryText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~#]+/g, "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/[\s_-]+/g, " ");
}

function readIssueTypeFromFrontmatter(frontmatter: Record<string, unknown>): string | undefined {
  const rawIssueType = frontmatter.issueType ?? frontmatter.issuetype;
  return typeof rawIssueType === "string" && rawIssueType.trim()
    ? rawIssueType.trim()
    : undefined;
}

function findProjectIssueTypeMap(
  config: AppConfig,
  projectKey: string
): Record<string, Record<string, unknown>> | undefined {
  const requestedProjectKey = normalizeLookupKey(projectKey);

  for (const [configuredProjectKey, issueTypeMap] of Object.entries(
    config.projectIssueTypeFieldMap
  )) {
    if (normalizeLookupKey(configuredProjectKey) === requestedProjectKey) {
      return issueTypeMap;
    }
  }

  return undefined;
}

function inferProjectIssueTypesFromFieldMap(
  config: AppConfig,
  projectKey: string
): string[] {
  return Object.keys(findProjectIssueTypeMap(config, projectKey) ?? {});
}

function inferChildIssueTypesFromProjectContext(input: {
  epicIssueType: string;
  issueTypes: string[];
  subtaskIssueType: string;
}): string[] {
  const epicLookupKey = normalizeLookupKey(input.epicIssueType);
  const subtaskLookupKey = normalizeLookupKey(input.subtaskIssueType);

  return uniqueStrings(
    input.issueTypes.filter((issueType) => {
      const issueTypeLookupKey = normalizeLookupKey(issueType);
      return (
        issueTypeLookupKey !== epicLookupKey &&
        issueTypeLookupKey !== subtaskLookupKey
      );
    })
  );
}

function formatFieldMapContext(
  config: AppConfig,
  projectKey: string,
  issueTypes: string[]
): string {
  const issueTypeMap = config.projectIssueTypeFieldMap[projectKey] ?? {};
  const scoped = Object.fromEntries(
    issueTypes
      .filter((issueType) => issueTypeMap[issueType])
      .map((issueType) => [issueType, issueTypeMap[issueType]])
  );

  return Object.keys(scoped).length > 0
    ? JSON.stringify(scoped, null, 2)
    : "{}";
}

async function collectProjectPlanningContext(
  config: AppConfig,
  projectKey: string
): Promise<ProjectPlanningContext> {
  const matches = await collectMarkdownFiles(config.dir);
  const examples: ProjectExample[] = [];
  const issueTypes = [
    ...inferProjectIssueTypesFromFieldMap(config, projectKey)
  ];

  for (const filePath of matches) {
    if (inferProjectKeyFromFilePath(filePath, config.dir) !== projectKey) {
      continue;
    }

    const document = await loadMarkdownDocument(filePath);
    const issueType = readIssueTypeFromFrontmatter(document.frontmatter);
    if (issueType) {
      issueTypes.push(issueType);
    }

    examples.push({
      filePath,
      raw:
        document.raw.length > 1_200
          ? `${document.raw.slice(0, 1_200).trimEnd()}${EOL}...`
          : document.raw
    });

    if (examples.length >= EXAMPLE_LIMIT) {
      break;
    }
  }

  return {
    examples,
    issueTypes: uniqueStrings(issueTypes)
  };
}

function formatProjectExamples(examples: ProjectExample[]): string {
  if (examples.length === 0) {
    return "No local examples were found for this project.";
  }

  return examples
    .map(
      (example) =>
        `File: ${example.filePath}${PROMPT_SEPARATOR}${example.raw.trim()}`
    )
    .join(`${EOL}${PROMPT_SEPARATOR}`);
}

async function readRequirement(inputPath: string | undefined, stdin: NodeJS.ReadStream): Promise<string> {
  if (inputPath) {
    const content = await readFile(resolve(process.cwd(), inputPath), "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error(`Planning input file ${inputPath} is empty.`);
    }

    return trimmed;
  }

  if (stdin.isTTY) {
    throw new Error("Provide --input <path> or pipe the planning requirement on stdin.");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const content = Buffer.concat(chunks).toString("utf8").trim();
  if (!content) {
    throw new Error("Planning requirement from stdin is empty.");
  }

  return content;
}

export async function buildEpicPlannerPrompt(input: {
  config: AppConfig;
  hierarchy: PlannerHierarchyOptions;
  projectContext?: ProjectPlanningContext | undefined;
  projectKey: string;
  requirement: string;
}): Promise<string> {
  const issueTypes = uniqueStrings([
    input.hierarchy.epicIssueType,
    ...input.hierarchy.childIssueTypes,
    input.hierarchy.subtaskIssueType
  ]);
  const projectContext =
    input.projectContext ??
    (await collectProjectPlanningContext(input.config, input.projectKey));

  return [
    "You are planning a new Jira epic from a business requirement.",
    "Return JSON only. Do not include markdown fences, prose, or explanations.",
    "",
    `Target project: ${input.projectKey}`,
    `Issue storage root: ${input.config.dir}`,
    `Discovered project issue types: ${
      projectContext.issueTypes.length > 0
        ? projectContext.issueTypes.join(", ")
        : "none"
    }`,
    `Root issue type: ${input.hierarchy.epicIssueType}`,
    `Allowed direct child issue types: ${input.hierarchy.childIssueTypes.join(", ")}`,
    `Allowed sub-task issue type: ${input.hierarchy.subtaskIssueType}`,
    "",
    "Required output shape:",
    JSON.stringify(
      {
        issues: [
          {
            assignee: null,
            frontmatter: {
              priority: "High"
            },
            localId: "root-epic",
            parentRef: null,
            status: null,
            issueType: input.hierarchy.epicIssueType,
            summary: "Epic summary",
            body:
              "Goal:\\nDeliver a usable planning workflow for operators without changing the push flow.\\n\\nAcceptance criteria:\\n- Users can plan a new issue from a requirement file or stdin.\\n- Draft output stays compatible with jira-markdown push behavior.\\n- The planner reuses the configured provider and project field mappings.",
            labels: ["example"],
          },
          {
            assignee: null,
            frontmatter: {
              storyPoints: 3
            },
            localId: "child-story",
            parentRef: "root-epic",
            status: null,
            issueType: input.hierarchy.childIssueTypes[0] ?? "Story",
            summary: "Child work item summary",
            body:
              "Goal:\\nSupport invoking the new planning flow from the CLI with predictable options.\\n\\nAcceptance criteria:\\n- The command is available under the existing plan command group.\\n- Users can preview the prompt and run a dry run.\\n- Help text explains when to use the command.",
            labels: null
          },
          {
            assignee: null,
            frontmatter: null,
            localId: "child-subtask",
            parentRef: "child-story",
            labels: null,
            status: null,
            issueType: input.hierarchy.subtaskIssueType,
            summary: "Subtask summary",
            body:
              "Goal:\\nAdd option parsing for the CLI entrypoint.\\n\\nAcceptance criteria:\\n- Required options are parsed and passed through.\\n- Invalid combinations fail with a clear error."
          }
        ]
      },
      null,
      2
    ),
    "",
    "Hierarchy rules:",
    `- Exactly one root issue with no parentRef and issueType "${input.hierarchy.epicIssueType}".`,
    `- Root children must use one of: ${input.hierarchy.childIssueTypes.join(", ")}.`,
    `- Only grandchildren are allowed below the root, and they must use issueType "${input.hierarchy.subtaskIssueType}".`,
    projectContext.issueTypes.length > 0
      ? `- Do not create issue types outside this project set: ${projectContext.issueTypes.join(", ")}.`
      : "- If project issue type availability is unclear, stay within the explicitly allowed hierarchy types above.",
    "- localId values must be unique and stable identifiers.",
    "- parentRef must reference another issue localId in the same response.",
    "- Use null for optional fields when you have no value: assignee, frontmatter, labels, parentRef, and status.",
    "",
    "Issue-writing best practices:",
    "- Make each summary outcome-based and recognizable as done. Prefer deliverable language over implementation-only labels such as \"refactor\", \"wiring\", or \"tests\" when a user-visible or workflow-visible outcome exists.",
    "- Each issue body should include concise context or goal plus an `Acceptance criteria:` section with observable bullet points.",
    "- Prefer top-level children that represent independently completable deliverables or capabilities. Avoid splitting the first level only by implementation layer such as CLI, prompt, refactor, tests, or docs unless the requirement is primarily internal infrastructure work.",
    "- Refactor-only, test-only, or documentation-only work should usually support a parent deliverable instead of becoming peer tasks unless they are independently valuable to track.",
    "- Use Stories for end-user functionality and Tasks for technical or internal work when both are available.",
    "- Review local examples and avoid drafting an epic or child issue that duplicates existing project scope with only minor wording changes.",
    "",
    "Markdown/frontmatter rules for jira-markdown draft issues:",
    "- New planned issues must omit the Jira issue key.",
    "- jira-markdown will render markdown files itself; you only provide structured issue data.",
    "- issueType, summary, localId, parentRef, labels, status, and assignee are first-class fields.",
    "- Do not repeat the summary as the first heading or first line of the markdown body.",
    "- Put project-specific mapped Jira fields in frontmatter, not in the markdown body.",
    "- Do not emit reserved frontmatter keys inside frontmatter: issue, issueKey, project, issueType, issuetype, summary, description, labels, assignee, parent, status, fields, localId, parentRef.",
    "",
    "Project-specific field map context:",
    formatFieldMapContext(input.config, input.projectKey, issueTypes),
    "",
    "Local issue examples from this project:",
    formatProjectExamples(projectContext.examples),
    "",
    "Business requirement:",
    input.requirement
  ].join(EOL);
}

function resolvePlannerHierarchyOptions(input: {
  childIssueTypes?: string[] | undefined;
  epicIssueType?: string | undefined;
  projectContext: ProjectPlanningContext;
  projectKey: string;
  subtaskIssueType?: string | undefined;
}): PlannerHierarchyOptions {
  const epicIssueType = input.epicIssueType?.trim() || DEFAULT_EPIC_ISSUE_TYPE;
  const subtaskIssueType = input.subtaskIssueType?.trim() || DEFAULT_SUBTASK_ISSUE_TYPE;
  const childIssueTypes = uniqueStrings(
    input.childIssueTypes ??
      (input.projectContext.issueTypes.length > 0
        ? inferChildIssueTypesFromProjectContext({
            epicIssueType,
            issueTypes: input.projectContext.issueTypes,
            subtaskIssueType
          })
        : DEFAULT_CHILD_ISSUE_TYPES)
  );

  if (childIssueTypes.length === 0) {
    throw new Error(
      `Could not infer any allowed child issue types for project ${input.projectKey} from the field map or local issue examples. Pass --child-type explicitly if needed.`
    );
  }

  return {
    childIssueTypes,
    epicIssueType,
    subtaskIssueType
  };
}

function validatePlannedHierarchy(
  issues: z.infer<typeof plannerIssueSchema>[],
  hierarchy: PlannerHierarchyOptions
): z.infer<typeof plannerIssueSchema>[] {
  const issuesByLocalId = new Map<string, z.infer<typeof plannerIssueSchema>>();
  const allowedIssueTypes = new Set(
    uniqueStrings([
      hierarchy.epicIssueType,
      ...hierarchy.childIssueTypes,
      hierarchy.subtaskIssueType
    ]).map((issueType) => normalizeLookupKey(issueType))
  );

  for (const issue of issues) {
    const normalizedLocalId = normalizeLookupKey(issue.localId);
    if (issuesByLocalId.has(normalizedLocalId)) {
      throw new Error(`Planner returned duplicate localId "${issue.localId}".`);
    }

    if (!allowedIssueTypes.has(normalizeLookupKey(issue.issueType))) {
      throw new Error(
        `Planner returned unsupported issue type "${issue.issueType}" for ${issue.localId}.`
      );
    }

    const reservedKey = Object.keys(issue.frontmatter ?? {}).find((key) =>
      RESERVED_FRONTMATTER_KEYS.has(key)
    );
    if (reservedKey) {
      throw new Error(
        `Planner returned reserved frontmatter key "${reservedKey}" inside frontmatter for ${issue.localId}.`
      );
    }

    issuesByLocalId.set(normalizedLocalId, issue);
  }

  const roots = issues.filter((issue) => !issue.parentRef);
  if (roots.length !== 1) {
    throw new Error(`Planner must return exactly one root issue, received ${roots.length}.`);
  }

  const rootIssue = roots[0] as z.infer<typeof plannerIssueSchema>;
  if (
    normalizeLookupKey(rootIssue.issueType) !== normalizeLookupKey(hierarchy.epicIssueType)
  ) {
    throw new Error(
      `Planner root issue must use issue type "${hierarchy.epicIssueType}", received "${rootIssue.issueType}".`
    );
  }

  const depthByLocalId = new Map<string, number>();
  const visit = (issue: z.infer<typeof plannerIssueSchema>, stack = new Set<string>()): number => {
    const issueLookup = normalizeLookupKey(issue.localId);
    const cached = depthByLocalId.get(issueLookup);
    if (cached !== undefined) {
      return cached;
    }

    if (stack.has(issueLookup)) {
      throw new Error(`Planner returned a cycle involving "${issue.localId}".`);
    }

    if (!issue.parentRef) {
      depthByLocalId.set(issueLookup, 0);
      return 0;
    }

    const parent = issuesByLocalId.get(normalizeLookupKey(issue.parentRef));
    if (!parent) {
      throw new Error(
        `Planner returned parentRef "${issue.parentRef}" for ${issue.localId}, but no matching localId exists.`
      );
    }

    stack.add(issueLookup);
    const depth = visit(parent, stack) + 1;
    stack.delete(issueLookup);
    depthByLocalId.set(issueLookup, depth);
    return depth;
  };

  for (const issue of issues) {
    const depth = visit(issue);

    if (depth > 2) {
      throw new Error(`Planner returned unsupported depth for "${issue.localId}".`);
    }

    if (depth === 1) {
      if (
        !hierarchy.childIssueTypes.some(
          (issueType) => normalizeLookupKey(issueType) === normalizeLookupKey(issue.issueType)
        )
      ) {
        throw new Error(
          `Planner child issue "${issue.localId}" must use one of: ${hierarchy.childIssueTypes.join(", ")}.`
        );
      }
    }

    if (
      depth === 2 &&
      normalizeLookupKey(issue.issueType) !== normalizeLookupKey(hierarchy.subtaskIssueType)
    ) {
      throw new Error(
        `Planner grandchild issue "${issue.localId}" must use issue type "${hierarchy.subtaskIssueType}".`
      );
    }
  }

  return issues;
}

function stripRedundantLeadingSummary(body: string, summary: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return trimmedBody;
  }

  const normalizedSummary = normalizeSummaryText(summary);
  if (!normalizedSummary) {
    return trimmedBody;
  }

  const lines = trimmedBody.split(/\r?\n/);
  let firstContentLineIndex = 0;
  while (
    firstContentLineIndex < lines.length &&
    lines[firstContentLineIndex]?.trim().length === 0
  ) {
    firstContentLineIndex += 1;
  }

  const firstLine = lines[firstContentLineIndex]?.trim() ?? "";
  const atxHeadingMatch = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(firstLine);
  if (
    atxHeadingMatch &&
    normalizeSummaryText(atxHeadingMatch[1] ?? "") === normalizedSummary
  ) {
    let nextLineIndex = firstContentLineIndex + 1;
    while (nextLineIndex < lines.length && lines[nextLineIndex]?.trim().length === 0) {
      nextLineIndex += 1;
    }

    return lines.slice(nextLineIndex).join("\n").trim();
  }

  const secondLine = lines[firstContentLineIndex + 1]?.trim() ?? "";
  if (
    firstLine &&
    /^(=+|-+)$/.test(secondLine) &&
    normalizeSummaryText(firstLine) === normalizedSummary
  ) {
    let nextLineIndex = firstContentLineIndex + 2;
    while (nextLineIndex < lines.length && lines[nextLineIndex]?.trim().length === 0) {
      nextLineIndex += 1;
    }

    return lines.slice(nextLineIndex).join("\n").trim();
  }

  return trimmedBody;
}

function renderPlannedIssueMarkdown(issue: z.infer<typeof plannerIssueSchema>): string {
  const frontmatter: JsonObject = {
    localId: issue.localId,
    issueType: issue.issueType,
    summary: issue.summary
  };

  if (issue.parentRef) {
    frontmatter.parentRef = issue.parentRef;
  }

  if (issue.status) {
    frontmatter.status = issue.status;
  }

  if (issue.assignee) {
    frontmatter.assignee = issue.assignee;
  }

  if (issue.labels?.length) {
    frontmatter.labels = issue.labels;
  }

  for (const key of Object.keys(issue.frontmatter ?? {}).sort((left, right) =>
    left.localeCompare(right)
  )) {
    frontmatter[key] = issue.frontmatter?.[key] as JsonValue;
  }

  return matter.stringify(
    stripRedundantLeadingSummary(issue.body, issue.summary),
    frontmatter
  );
}

export function materializePlannedIssueDrafts(input: {
  issues: z.infer<typeof plannerIssueSchema>[];
  projectKey: string;
  rootDir: string;
}): PlannedIssueDraft[] {
  const rootIssue = input.issues.find((issue) => !issue.parentRef) as z.infer<
    typeof plannerIssueSchema
  >;
  const draftDirectory = join(
    process.cwd(),
    input.rootDir,
    input.projectKey,
    "_drafts",
    sanitizeDraftSegment(rootIssue.localId)
  );
  const filePathsBySanitizedLocalId = new Map<string, string>();

  return input.issues.map((issue) => {
    const fileName = `${sanitizeDraftSegment(issue.localId)}.md`;
    if (filePathsBySanitizedLocalId.has(fileName)) {
      throw new Error(
        `Planner draft ids "${issue.localId}" and "${filePathsBySanitizedLocalId.get(fileName)}" collide after path sanitization.`
      );
    }

    filePathsBySanitizedLocalId.set(fileName, issue.localId);
    return {
      content: renderPlannedIssueMarkdown(issue),
      filePath: join(draftDirectory, fileName),
      localId: issue.localId,
      ...(issue.parentRef ? { parentRef: issue.parentRef } : {})
    };
  });
}

async function writePlannedDrafts(
  drafts: PlannedIssueDraft[],
  dryRun: boolean,
  stdout: (content: string) => void
): Promise<void> {
  for (const draft of drafts) {
    if (dryRun) {
      stdout(`[DRY RUN] WRITE ${draft.filePath}${EOL}`);
      stdout(`${draft.content.trimEnd()}${EOL}`);
      continue;
    }

    await mkdir(resolve(dirname(draft.filePath)), { recursive: true });
    await writeFile(draft.filePath, draft.content, "utf8");
    stdout(`[PLAN] ${draft.filePath}${EOL}`);
  }
}

export async function planEpic(options: PlanEpicOptions): Promise<{
  drafts: PlannedIssueDraft[];
  prompt: string;
}> {
  const stdout = options.stdout ?? ((content: string) => process.stdout.write(content));
  const stderr = options.stderr ?? ((content: string) => process.stderr.write(content));
  const stdin = options.stdin ?? process.stdin;
  const projectKey = options.projectKey.trim().toUpperCase();
  const { config } = await loadAppConfig(options.configPath);
  const requirement = await readRequirement(options.inputPath, stdin);
  const projectContext = await collectProjectPlanningContext(config, projectKey);
  const hierarchy = resolvePlannerHierarchyOptions({
    childIssueTypes: options.childIssueTypes,
    epicIssueType: options.epicIssueType,
    projectContext,
    projectKey,
    subtaskIssueType: options.subtaskIssueType
  });
  const prompt = await buildEpicPlannerPrompt({
    config,
    hierarchy,
    projectContext,
    projectKey,
    requirement
  });

  if (options.printPrompt) {
    stdout(`${prompt}${EOL}`);
    return {
      drafts: [],
      prompt
    };
  }

  const plannerConfig = config.ai.planner;
  if (!plannerConfig) {
    throw new Error(
      'Planner config is missing. Set ai.planner.provider to "codex" or "claude" in jira-markdown.config.json.'
    );
  }

  stdout(`[PLAN] Running ${plannerConfig.provider} planner...${EOL}`);

  const rawResponse = (await runPlannerProvider({
    config: plannerConfig,
    prompt,
    stderr: options.verbose ? stderr : () => {}
  })).trim();
  if (!rawResponse) {
    throw new Error("Planner command returned no output.");
  }

  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(rawResponse);
  } catch (error) {
    throw new Error(
      `Planner command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const response = plannerResponseSchema.parse(parsedResponse);
  const validatedIssues = validatePlannedHierarchy(response.issues, hierarchy);
  const drafts = materializePlannedIssueDrafts({
    issues: validatedIssues,
    projectKey,
    rootDir: config.dir
  });
  await writePlannedDrafts(drafts, options.dryRun ?? false, stdout);
  return {
    drafts,
    prompt
  };
}

export function getDefaultEpicPlannerIssueTypes(): {
  childIssueTypes: string[];
  epicIssueType: string;
  subtaskIssueType: string;
} {
  return {
    childIssueTypes: [...DEFAULT_CHILD_ISSUE_TYPES],
    epicIssueType: DEFAULT_EPIC_ISSUE_TYPE,
    subtaskIssueType: DEFAULT_SUBTASK_ISSUE_TYPE
  };
}
