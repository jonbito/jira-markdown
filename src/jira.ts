import { Buffer } from "node:buffer";
import {
  type JiraCreateField,
  type JiraAuthConfig,
  type JiraIssueHierarchyRecord,
  type JiraIssueAttachment,
  type JiraIssueRecord,
  type JiraIssueTransition,
  type JiraField,
  type JiraIssueTypeSummary,
  type JiraProjectSummary,
  type JiraSprint,
  type JiraUserSummary
} from "./types.js";

type JiraResponseErrorPayload = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  message?: string;
};

type SprintPage = {
  isLast: boolean;
  maxResults: number;
  startAt: number;
  values: JiraSprint[];
};

type CreateIssueTypesPage = {
  issueTypes: JiraIssueTypeSummary[];
  maxResults: number;
  startAt: number;
  total: number;
};

type CreateFieldsPage = {
  fields: JiraCreateField[];
  maxResults: number;
  startAt: number;
  total: number;
};

type EditFieldsResponse = {
  fields?: Record<string, Partial<JiraCreateField>>;
};

type ProjectsPage = {
  isLast: boolean;
  maxResults: number;
  startAt: number;
  total: number;
  values: JiraProjectSummary[];
};

type SearchIssuesPage = {
  issues: JiraIssueRecord[];
  isLast?: boolean;
  nextPageToken?: string;
};

type JiraRetryPolicy = {
  baseDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
};

type JiraClientOptions = {
  fetch?: JiraFetch;
  retry?: Partial<JiraRetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
};

type JiraFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_RETRY_POLICY: JiraRetryPolicy = {
  baseDelayMs: 500,
  maxAttempts: 4,
  maxDelayMs: 4_000
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterDelayMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const retryAfterSeconds = Number(trimmed);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, Math.ceil(retryAfterSeconds * 1_000));
  }

  const retryAfterTimestamp = Date.parse(trimmed);
  if (Number.isNaN(retryAfterTimestamp)) {
    return undefined;
  }

  return Math.max(0, retryAfterTimestamp - Date.now());
}

function buildRetryDelayMs(attempt: number, response: Response, policy: JiraRetryPolicy): number {
  const retryAfterDelayMs = parseRetryAfterDelayMs(response.headers.get("Retry-After"));
  if (retryAfterDelayMs !== undefined) {
    return retryAfterDelayMs;
  }

  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

async function sleepForDelay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProjectIssueSearchJql(projectKey: string, jqlClause?: string): string {
  const projectClause = `project = "${projectKey}"`;
  if (!jqlClause) {
    return `${projectClause} ORDER BY key ASC`;
  }

  return `${projectClause} AND (${jqlClause}) ORDER BY key ASC`;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: JiraResponseErrorPayload | string
  ) {
    super(message);
  }
}

export class JiraClient {
  private readonly fetchImpl: JiraFetch;
  private readonly retryPolicy: JiraRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly auth: JiraAuthConfig,
    options: JiraClientOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retry
    };
    this.sleep = options.sleep ?? sleepForDelay;
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.request("/rest/api/3/issue", {
      body: JSON.stringify({ fields }),
      method: "POST"
    });
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.request(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE"
    });
  }

  async downloadAttachmentContent(attachmentId: string): Promise<Uint8Array> {
    return this.requestBytes(
      `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`
    );
  }

  getAttachmentContentUrl(attachment: Pick<JiraIssueAttachment, "content" | "id">): string {
    return (
      attachment.content ??
      new URL(
        `/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`,
        `${this.auth.baseUrl}/`
      ).toString()
    );
  }

  async getFields(): Promise<JiraField[]> {
    return this.request("/rest/api/3/field");
  }

  async getCurrentUser(): Promise<{ accountId: string; displayName: string }> {
    return this.request("/rest/api/3/myself");
  }

  async getUser(accountId: string): Promise<JiraUserSummary> {
    const params = new URLSearchParams({
      accountId
    });

    return this.request(`/rest/api/3/user?${params.toString()}`);
  }

  async getIssueAttachments(issueKey: string): Promise<JiraIssueAttachment[]> {
    const issue = await this.request<{
      fields: {
        attachment?: JiraIssueAttachment[] | undefined;
      };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`);

    return issue.fields.attachment ?? [];
  }

  async getIssueDescription(issueKey: string): Promise<unknown> {
    const issue = await this.request<{
      fields: {
        description?: unknown;
      };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description`);

    return issue.fields.description ?? null;
  }

  async getIssue(issueKey: string, extraFieldIds: string[] = []): Promise<JiraIssueRecord> {
    const fields = [
      "assignee",
      "summary",
      "description",
      "issuetype",
      "labels",
      "parent",
      "project",
      "status",
      "updated",
      "attachment",
      ...extraFieldIds
    ];
    const params = new URLSearchParams({
      fields: [...new Set(fields)].join(",")
    });

    return this.request(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params.toString()}`
    );
  }

  async getIssueHierarchy(issueIdOrKey: string): Promise<JiraIssueHierarchyRecord> {
    const params = new URLSearchParams({
      fields: "issuetype,parent,project"
    });

    return this.request(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?${params.toString()}`
    );
  }

  async getTransitions(issueKey: string): Promise<JiraIssueTransition[]> {
    const response = await this.request<{
      transitions?: JiraIssueTransition[] | undefined;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);

    return response.transitions ?? [];
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      body: JSON.stringify({
        transition: {
          id: transitionId
        }
      }),
      method: "POST"
    });
  }

  async getEditFields(issueIdOrKey: string): Promise<JiraCreateField[]> {
    const response = await this.request<EditFieldsResponse>(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/editmeta`
    );

    return Object.entries(response.fields ?? {}).map(([fieldId, field]) => ({
      allowedValues: field.allowedValues,
      autoCompleteUrl: field.autoCompleteUrl,
      fieldId,
      hasDefaultValue: field.hasDefaultValue,
      key: field.key,
      name: field.name ?? fieldId,
      operations: field.operations,
      required: field.required ?? false,
      schema: field.schema
    }));
  }

  async listCreateFields(
    projectIdOrKey: string,
    issueTypeId: string
  ): Promise<JiraCreateField[]> {
    const results: JiraCreateField[] = [];
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt)
      });

      const page = await this.request<CreateFieldsPage>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?${params.toString()}`
      );

      results.push(...page.fields);

      if (page.startAt + page.maxResults >= page.total || page.fields.length === 0) {
        return results;
      }

      startAt = page.startAt + page.maxResults;
    }
  }

  async listCreateIssueTypes(projectIdOrKey: string): Promise<JiraIssueTypeSummary[]> {
    const results: JiraIssueTypeSummary[] = [];
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt)
      });

      const page = await this.request<CreateIssueTypesPage>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes?${params.toString()}`
      );

      results.push(...page.issueTypes);

      if (page.startAt + page.maxResults >= page.total || page.issueTypes.length === 0) {
        return results;
      }

      startAt = page.startAt + page.maxResults;
    }
  }

  async listProjects(): Promise<JiraProjectSummary[]> {
    const results: JiraProjectSummary[] = [];
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt)
      });

      const page = await this.request<ProjectsPage>(
        `/rest/api/3/project/search?${params.toString()}`
      );

      results.push(...page.values);

      if (page.isLast || page.values.length === 0) {
        return results;
      }

      startAt = page.startAt + page.maxResults;
    }
  }

  async listSprints(boardId: number, state?: string): Promise<JiraSprint[]> {
    const results: JiraSprint[] = [];
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt)
      });

      if (state) {
        params.set("state", state);
      }

      const page = await this.request<SprintPage>(
        `/rest/agile/1.0/board/${boardId}/sprint?${params.toString()}`
      );

      results.push(...page.values);

      if (page.isLast || page.values.length === 0) {
        return results;
      }

      startAt = page.startAt + page.maxResults;
    }
  }

  async resolveSprintId(boardId: number, sprintName: string): Promise<number | undefined> {
    const normalizedTarget = sprintName.trim().toLowerCase();
    const sprints = await this.listSprints(boardId, "active,future");
    const match = sprints.find(
      (sprint) => sprint.name.trim().toLowerCase() === normalizedTarget
    );
    return match?.id;
  }

  async searchUsers(query: string): Promise<JiraUserSummary[]> {
    const params = new URLSearchParams({
      query
    });

    return this.request(`/rest/api/3/user/search?${params.toString()}`);
  }

  async searchAssignableUsers(input: {
    accountId?: string | undefined;
    issueKey?: string | undefined;
    query?: string | undefined;
  }): Promise<JiraUserSummary[]> {
    const params = new URLSearchParams();

    if (input.accountId) {
      params.set("accountId", input.accountId);
    }

    if (input.issueKey) {
      params.set("issueKey", input.issueKey);
    }

    if (input.query) {
      params.set("query", input.query);
    }

    return this.request(`/rest/api/3/user/assignable/search?${params.toString()}`);
  }

  async listUsers(): Promise<JiraUserSummary[]> {
    const results: JiraUserSummary[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      });
      const page = await this.request<JiraUserSummary[]>(
        `/rest/api/3/users/search?${params.toString()}`
      );

      results.push(...page);

      if (page.length < maxResults) {
        return results;
      }

      startAt += maxResults;
    }
  }

  async searchIssuesByProject(
    projectKey: string,
    extraFieldIds: string[] = [],
    jqlClause?: string
  ): Promise<JiraIssueRecord[]> {
    const results: JiraIssueRecord[] = [];
    let nextPageToken: string | undefined;

    while (true) {
      const fields = [
        "assignee",
        "summary",
        "description",
        "issuetype",
        "labels",
        "parent",
        "project",
        "status",
        "updated",
        "attachment",
        ...extraFieldIds
      ];

      const page = await this.request<SearchIssuesPage>("/rest/api/3/search/jql", {
        body: JSON.stringify({
          fields: [...new Set(fields)],
          jql: buildProjectIssueSearchJql(projectKey, jqlClause),
          ...(nextPageToken ? { nextPageToken } : {}),
          maxResults: 100
        }),
        method: "POST"
      });

      results.push(...page.issues);

      if (page.isLast || !page.nextPageToken || page.issues.length === 0) {
        return results;
      }

      nextPageToken = page.nextPageToken;
    }
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      body: JSON.stringify({ fields }),
      method: "PUT"
    });
  }

  async uploadIssueAttachment(
    issueKey: string,
    fileName: string,
    content: Uint8Array
  ): Promise<JiraIssueAttachment[]> {
    const formData = new FormData();
    formData.append("file", new Blob([Uint8Array.from(content)]), fileName);

    return this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
      body: formData,
      headers: {
        "X-Atlassian-Token": "no-check"
      },
      method: "POST"
    });
  }

  private createHeaders(init?: RequestInit): Headers {
    const headers = new Headers({
      Accept: "application/json"
    });

    if (this.auth.authMode === "basic") {
      const encoded = Buffer.from(
        `${this.auth.email ?? ""}:${this.auth.apiToken ?? ""}`
      ).toString("base64");
      headers.set("Authorization", `Basic ${encoded}`);
    } else {
      headers.set("Authorization", `Bearer ${this.auth.bearerToken ?? ""}`);
    }

    if (init?.headers) {
      const overrideHeaders = new Headers(init.headers);
      overrideHeaders.forEach((value, key) => headers.set(key, value));
    }

    if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return headers;
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, `${this.auth.baseUrl}/`);
    const headers = this.createHeaders(init);

    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        ...init,
        headers
      });

      if (
        !RETRYABLE_STATUS_CODES.has(response.status) ||
        attempt >= this.retryPolicy.maxAttempts
      ) {
        return response;
      }

      await response.arrayBuffer();
      await this.sleep(buildRetryDelayMs(attempt, response, this.retryPolicy));
    }
  }

  private async createApiError(response: Response): Promise<JiraApiError> {
    const text = await response.text();
    let payload: JiraResponseErrorPayload | string = text;

    try {
      payload = JSON.parse(text) as JiraResponseErrorPayload;
    } catch {
      // Leave plain text payload in place.
    }

    const details =
      typeof payload === "string"
        ? payload
        : [
            ...(payload.errorMessages ?? []),
            ...Object.entries(payload.errors ?? {}).map(
              ([field, message]) => `${field}: ${message}`
            ),
            payload.message ?? ""
          ]
            .filter(Boolean)
            .join("; ");

    return new JiraApiError(
      `Jira request failed (${response.status})${details ? `: ${details}` : ""}`,
      response.status,
      payload
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.send(path, init);

    if (response.status === 204) {
      return undefined as T;
    }

    if (!response.ok) {
      throw await this.createApiError(response);
    }

    return (await response.json()) as T;
  }

  private async requestBytes(path: string, init?: RequestInit): Promise<Uint8Array> {
    const response = await this.send(path, init);

    if (!response.ok) {
      throw await this.createApiError(response);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}
