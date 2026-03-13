import { stdout as output } from "node:process";
import { loadStoredAuthConfig } from "./auth-store.js";
import { JiraClient } from "./jira.js";

export async function inspectIssueAdf(
  issueKey: string,
  write: (content: string) => void = (content) => {
    output.write(content);
  }
): Promise<void> {
  const jira = new JiraClient(await loadStoredAuthConfig());
  const description = await jira.getIssueDescription(issueKey.trim());
  write(`${JSON.stringify(description ?? null, null, 2)}\n`);
}
