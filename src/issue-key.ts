export const ISSUE_KEY_FRONTMATTER_FIELD = "issue";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveIssueKey(input: {
  filePath: string;
  frontmatter: Record<string, unknown>;
  issueKeyField?: string;
}): string | undefined {
  return (
    asString(input.frontmatter[input.issueKeyField ?? ISSUE_KEY_FRONTMATTER_FIELD]) ??
    asString(input.frontmatter.issue) ??
    asString(input.frontmatter.issueKey)
  );
}
