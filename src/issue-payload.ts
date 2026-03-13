import { basename } from "node:path";
import { markdownToAdf, type MarkdownToAdfOptions } from "./adf.js";
import { resolveIssueKey } from "./issue-key.js";
import { inferProjectKeyFromFilePath } from "./project-path.js";
import { type CoreIssuePayload, RESERVED_FRONTMATTER_KEYS } from "./types.js";

interface BuildCoreIssuePayloadInput {
  body: string;
  dir?: string | undefined;
  descriptionOptions?: MarkdownToAdfOptions | undefined;
  filePath: string;
  frontmatter: Record<string, unknown>;
  issueKeyField?: string;
  omitDescription?: boolean | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const strings = value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return strings.length > 0 ? strings : undefined;
  }

  const single = asString(value);
  return single ? [single] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function inferSummary(body: string, filePath: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }

  return basename(filePath, ".md");
}

function collectExtraFrontmatter(
  frontmatter: Record<string, unknown>,
  issueKeyField: string
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === issueKeyField || RESERVED_FRONTMATTER_KEYS.has(key)) {
      continue;
    }
    extra[key] = value;
  }

  return extra;
}

function sanitizeRawFieldsForIssueOperation(
  rawFields: Record<string, unknown> | undefined,
  issueKey: string | undefined
): Record<string, unknown> | undefined {
  if (!rawFields) {
    return undefined;
  }

  if (!issueKey) {
    return rawFields;
  }

  const { issuetype: _issueType, ...rest } = rawFields;
  return rest;
}

export function buildCoreIssuePayload(
  input: BuildCoreIssuePayloadInput
): CoreIssuePayload {
  const issueKeyField = input.issueKeyField ?? "issue";
  const issueKey = resolveIssueKey({
    filePath: input.filePath,
    frontmatter: input.frontmatter,
    issueKeyField
  });

  const summary =
    asString(input.frontmatter.summary) ?? inferSummary(input.body, input.filePath);

  const project =
    asString(input.frontmatter.project) ??
    inferProjectKeyFromFilePath(input.filePath, input.dir);
  const explicitIssueType =
    asString(input.frontmatter.issueType) ??
    asString(input.frontmatter.issuetype);
  const issueType = explicitIssueType;

  if (!issueKey && !project) {
    throw new Error(
      `Missing project for ${input.filePath}. Set frontmatter.project or place the file under ${input.dir ?? "issues"}/<PROJECT>/.`
    );
  }

  if (!issueKey && !issueType) {
    throw new Error(
      `Missing issue type for ${input.filePath}. Set frontmatter.issueType.`
    );
  }

  const projectKey = project;
  const issueTypeName = issueType;

  const descriptionSource = asString(input.frontmatter.description) ?? input.body;
  const labels = asStringArray(input.frontmatter.labels);
  const status = asString(input.frontmatter.status);
  const rawFields = sanitizeRawFieldsForIssueOperation(
    asRecord(input.frontmatter.fields),
    issueKey
  );

  const fields: Record<string, unknown> = {
    summary
  };

  if (!input.omitDescription && descriptionSource.trim()) {
    fields.description = markdownToAdf(descriptionSource, input.descriptionOptions);
  }

  if (!issueKey) {
    fields.project = { key: projectKey as string };
    fields.issuetype = { name: issueTypeName as string };
  }

  if (labels && labels.length > 0) {
    fields.labels = labels;
  }

  const parent = asString(input.frontmatter.parent);
  if (parent) {
    fields.parent = { key: parent };
  }

  const assignee = asString(input.frontmatter.assignee);
  if (assignee) {
    fields.assignee = { accountId: assignee };
  }

  return {
    extraFrontmatter: collectExtraFrontmatter(input.frontmatter, issueKeyField),
    fields: rawFields ? { ...fields, ...rawFields } : fields,
    issueKey,
    issueTypeName,
    projectKey,
    status,
    summary
  };
}
