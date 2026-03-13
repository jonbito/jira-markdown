import { afterEach, describe, expect, test } from "./test-helpers.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { persistStoredAuth } from "./auth-store.js";
import {
  buildLocalAttachmentSignature,
  buildRemoteAttachmentSignature
} from "./attachments.js";
import { loadSyncHistory, toHistoryPath } from "./sync-history.js";
import {
  pullJiraToMarkdown,
  pushMarkdownToJira,
  syncMarkdownToJira
} from "./sync.js";
import { type JiraIssueRecord } from "./types.js";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalAuthFile = process.env.JIRA_MARKDOWN_AUTH_FILE;
const originalConfigFile = process.env.JIRA_MARKDOWN_CONFIG_FILE;
const tempDirectories: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;

  if (originalAuthFile === undefined) {
    delete process.env.JIRA_MARKDOWN_AUTH_FILE;
  } else {
    process.env.JIRA_MARKDOWN_AUTH_FILE = originalAuthFile;
  }

  if (originalConfigFile === undefined) {
    delete process.env.JIRA_MARKDOWN_CONFIG_FILE;
  } else {
    process.env.JIRA_MARKDOWN_CONFIG_FILE = originalConfigFile;
  }

  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-sync-"));
  tempDirectories.push(directory);
  return directory;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}

function createIssueRecord(input: {
  description: string;
  id?: string;
  issueKey?: string;
  statusName?: string;
  issueTypeName?: string;
  issueTypeSubtask?: boolean;
  parentKey?: string;
  projectKey?: string;
  summary: string;
  updated: string;
}): JiraIssueRecord {
  return {
    fields: {
      attachment: [],
      description: {
        content: [
          {
            content: [
              {
                text: input.description,
                type: "text"
              }
            ],
            type: "paragraph"
          }
        ],
        type: "doc",
        version: 1
      },
      issuetype: {
        name: input.issueTypeName ?? "Task",
        subtask: input.issueTypeSubtask ?? false
      },
      labels: [],
      ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
      project: {
        key: input.projectKey ?? "ENG"
      },
      ...(input.statusName ? { status: { name: input.statusName } } : {}),
      summary: input.summary,
      updated: input.updated
    },
    id: input.id ?? "10001",
    key: input.issueKey ?? "ENG-1"
  };
}

function createIssueTypesPage(
  issueTypes: Array<{ id: string; name: string; subtask: boolean }> = [
    {
      id: "10000",
      name: "Task",
      subtask: false
    }
  ]
): {
  issueTypes: Array<{ id: string; name: string; subtask: boolean }>;
  maxResults: number;
  startAt: number;
  total: number;
} {
  return {
    issueTypes,
    maxResults: 50,
    startAt: 0,
    total: issueTypes.length
  };
}

function createSequentialFetch(responses: Response[]): {
  calls: Array<{
    body: string | undefined;
    method: string;
    url: string;
  }>;
} {
  const calls: Array<{
    body: string | undefined;
    method: string;
    url: string;
  }> = [];
  let index = 0;

  globalThis.fetch = (async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method ?? "GET",
      url: String(input)
    });

    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error(`Unexpected fetch call ${index}.`);
    }

    return response;
  }) as typeof fetch;

  return { calls };
}

async function setupWorkspace(input: {
  dir?: string;
  fileContent: string;
  fileName: string;
  issueSummary: string;
}): Promise<{
  authFilePath: string;
  configPath: string;
  filePath: string;
  historyPath: string;
}> {
  const directory = await createTempDirectory();
  const authFilePath = join(directory, "auth.json");
  const configPath = join(directory, "jira-markdown.config.json");
  const configuredDir = input.dir ?? "issues";
  const issuesRoot = resolve(directory, configuredDir);
  const issuesDirectory = join(issuesRoot, "ENG");
  const filePath = join(issuesDirectory, input.fileName);
  const historyPath = join(issuesRoot, ".sync-history");

  process.chdir(directory);
  process.env.JIRA_MARKDOWN_AUTH_FILE = authFilePath;
  process.env.JIRA_MARKDOWN_CONFIG_FILE = configPath;

  await persistStoredAuth(
    {
      authMode: "basic",
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "secret-token"
    },
    {
      authFilePath,
      storagePreference: "file"
    }
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        dir: configuredDir,
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {}
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await mkdir(issuesDirectory, { recursive: true });
  await writeFile(filePath, input.fileContent, "utf8");

  const fileStats = await stat(filePath);
  const emptyLocalAttachmentSignature = buildLocalAttachmentSignature([]);
  const emptyRemoteAttachmentSignature = buildRemoteAttachmentSignature([]);
  const history = {
    attachments: {},
    files: {
      [filePath]: {
        issueKey: "ENG-1",
        lastAttachmentSignature: emptyLocalAttachmentSignature,
        lastSyncedAt: "2026-03-10T00:00:00.000Z",
        lastSyncedMtimeMs: Math.max(0, fileStats.mtimeMs - 1_000)
      }
    },
    issues: {
      "ENG-1": {
        filePath,
        lastPulledAttachmentSignature: emptyRemoteAttachmentSignature,
        lastPulledAt: "2026-03-10T00:00:00.000Z",
        lastPulledFileMtimeMs: Math.max(0, fileStats.mtimeMs - 1_000),
        lastPulledLocalAttachmentSignature: emptyLocalAttachmentSignature,
        lastPulledRemoteUpdatedAt: "2026-03-10T00:00:00.000Z",
        lastSyncedRemoteAttachmentSignature: emptyRemoteAttachmentSignature,
        lastSyncedRemoteUpdatedAt: "2026-03-10T00:00:00.000Z",
        projectKey: "ENG",
        summary: input.issueSummary
      }
    },
    stats: {},
    version: 2
  };
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");

  return {
    authFilePath,
    configPath,
    filePath,
    historyPath
  };
}

async function setupProjectWorkspace(input: {
  config?: Record<string, unknown> | undefined;
  fileContent?: string | undefined;
  fileName?: string | undefined;
}): Promise<{
  authFilePath: string;
  configPath: string;
  filePath?: string | undefined;
}> {
  const directory = await createTempDirectory();
  const authFilePath = join(directory, "auth.json");
  const configPath = join(directory, "jira-markdown.config.json");
  const issuesDirectory = join(directory, "issues", "ENG");

  process.chdir(directory);
  process.env.JIRA_MARKDOWN_AUTH_FILE = authFilePath;
  process.env.JIRA_MARKDOWN_CONFIG_FILE = configPath;

  await persistStoredAuth(
    {
      authMode: "basic",
      baseUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "secret-token"
    },
    {
      authFilePath,
      storagePreference: "file"
    }
  );

  await writeFile(
    configPath,
    `${JSON.stringify(
      input.config ?? {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {}
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await mkdir(issuesDirectory, { recursive: true });

  const filePath =
    input.fileContent !== undefined && input.fileName !== undefined
      ? join(issuesDirectory, input.fileName)
      : undefined;
  if (filePath) {
    await writeFile(filePath, input.fileContent ?? "", "utf8");
  }

  return {
    authFilePath,
    configPath,
    filePath
  };
}

describe("sync conflict resolution", () => {
  test("push defaults to fail on concurrent local and Jira changes", async () => {
    await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nLocal body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });
    createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Remote body",
          summary: "Remote summary",
          updated: "2026-03-11T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      })
    ]);

    await expect(pushMarkdownToJira()).rejects.toThrow(
      /Conflict detected for ENG-1/
    );
  });

  test("push keep-jira rewrites local markdown to the Jira version", async () => {
    const { historyPath } = await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nLocal body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Remote body",
          summary: "Remote summary",
          updated: "2026-03-11T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      })
    ]);

    const results = await pushMarkdownToJira({
      onConflict: "keep-jira"
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "keep-jira",
      issueKey: "ENG-1",
      summary: "Remote summary"
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET"]);

    const rewrittenPath = join(
      process.cwd(),
      "issues",
      "ENG",
      "ENG-1 - Remote summary.md"
    );
    const rewritten = await readFile(rewrittenPath, "utf8");
    expect(rewritten).toContain("summary: Remote summary");
    expect(rewritten).toContain("Remote body");

    const history = JSON.parse(await readFile(historyPath, "utf8")) as {
      issues?: Record<string, { lastSyncedRemoteUpdatedAt?: string }>;
    };
    expect(history.issues?.["ENG-1"]?.lastSyncedRemoteUpdatedAt).toBe(
      "2026-03-11T00:00:00.000Z"
    );
  });

  test("pull keep-local updates Jira instead of overwriting the markdown file", async () => {
    const { filePath } = await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nLocal body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });
    const finalRemoteIssue = createIssueRecord({
      description: "Local body",
      summary: "Local summary",
      updated: "2026-03-12T00:00:00.000Z"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        issues: [
          createIssueRecord({
            description: "Remote body",
            summary: "Remote summary",
            updated: "2026-03-11T00:00:00.000Z"
          })
        ],
        isLast: true
      }),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      }),
      new Response(null, { status: 204 }),
      jsonResponse(200, finalRemoteIssue)
    ]);

    const results = await pullJiraToMarkdown({
      onConflict: "keep-local",
      projects: ["ENG"]
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "keep-local",
      issueKey: "ENG-1",
      summary: "Local summary"
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeDefined();
    const updatePayload = JSON.parse(updateCall?.body ?? "{}") as {
      fields?: {
        summary?: string;
      };
    };
    expect(updatePayload.fields?.summary).toBe("Local summary");

    const localFile = await readFile(filePath, "utf8");
    expect(localFile).toContain("summary: Local summary");
    expect(localFile).toContain("Local body");
  });

  test("sync does not reprocess an issue after push resolved it with keep-jira", async () => {
    await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nLocal body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });
    const remoteIssue = createIssueRecord({
      description: "Remote body",
      summary: "Remote summary",
      updated: "2026-03-11T00:00:00.000Z"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, remoteIssue),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      }),
      jsonResponse(200, {
        issues: [remoteIssue],
        isLast: true
      })
    ]);

    const results = await syncMarkdownToJira({
      onConflict: "keep-jira",
      projects: ["ENG"]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("keep-jira");
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET", "POST"]);
  });
});

describe("pull JQL filters", () => {
  test("pull applies a project-scoped JQL clause to Jira search", async () => {
    await setupProjectWorkspace({});

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        issues: [],
        isLast: true
      })
    ]);

    const results = await pullJiraToMarkdown({
      jql: "statusCategory != Done",
      projects: ["ENG"]
    });

    expect(results).toEqual([]);

    const searchCall = calls.find((call) => call.url.endsWith("/rest/api/3/search/jql"));
    expect(searchCall?.method).toBe("POST");
    expect(JSON.parse(searchCall?.body ?? "{}")).toMatchObject({
      jql: 'project = "ENG" AND (statusCategory != Done) ORDER BY key ASC'
    });
  });

  test("pull applies the same JQL clause to each selected project", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {}
          },
          OPS: {
            Task: {}
          }
        }
      }
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        issues: [],
        isLast: true
      }),
      jsonResponse(200, {
        issues: [],
        isLast: true
      })
    ]);

    const results = await pullJiraToMarkdown({
      jql: "assignee is not EMPTY",
      projects: ["OPS", "ENG"]
    });

    expect(results).toEqual([]);

    const searchCalls = calls.filter((call) => call.url.endsWith("/rest/api/3/search/jql"));
    expect(searchCalls).toHaveLength(2);
    expect(JSON.parse(searchCalls[0]?.body ?? "{}")).toMatchObject({
      jql: 'project = "ENG" AND (assignee is not EMPTY) ORDER BY key ASC'
    });
    expect(JSON.parse(searchCalls[1]?.body ?? "{}")).toMatchObject({
      jql: 'project = "OPS" AND (assignee is not EMPTY) ORDER BY key ASC'
    });
  });

  test("sync applies JQL to its pull phase search", async () => {
    await setupProjectWorkspace({});

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        issues: [],
        isLast: true
      })
    ]);

    const results = await syncMarkdownToJira({
      jql: "labels = backend",
      projects: ["ENG"]
    });

    expect(results).toEqual([]);

    const searchCall = calls.find((call) => call.url.endsWith("/rest/api/3/search/jql"));
    expect(searchCall?.method).toBe("POST");
    expect(JSON.parse(searchCall?.body ?? "{}")).toMatchObject({
      jql: 'project = "ENG" AND (labels = backend) ORDER BY key ASC'
    });
  });

  test("pull rejects blank JQL clauses", async () => {
    await setupProjectWorkspace({});

    await expect(
      pullJiraToMarkdown({
        jql: "   ",
        projects: ["ENG"]
      })
    ).rejects.toThrow(/non-empty JQL filter clause/i);
  });

  test("sync rejects JQL clauses that include ORDER BY", async () => {
    await setupProjectWorkspace({});

    await expect(
      syncMarkdownToJira({
        jql: "statusCategory != Done ORDER BY updated DESC",
        projects: ["ENG"]
      })
    ).rejects.toThrow(/do not include ORDER BY/i);
  });
});

describe("modern parent hierarchy support", () => {
  test("push fails when creating a sub-task without a parent", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {},
            "Sub-task": {}
          }
        }
      },
      fileContent:
        "---\nissueType: Sub-task\nsummary: Missing parent\n---\nChild body\n",
      fileName: "missing-parent.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "parent", name: "Parent" }
      ]),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(200, {
        fields: [
          {
            fieldId: "parent",
            name: "Parent",
            required: true
          }
        ],
        maxResults: 50,
        startAt: 0,
        total: 1
      })
    ]);

    await expect(pushMarkdownToJira()).rejects.toThrow(/requires a parent/i);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("push fails when creating a sub-task under a parent in another project", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {},
            "Sub-task": {}
          }
        }
      },
      fileContent:
        "---\nissueType: Sub-task\nparent: OPS-1\nsummary: Cross-project child\n---\nChild body\n",
      fileName: "cross-project-subtask.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "parent", name: "Parent" }
      ]),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(200, {
        fields: [
          {
            fieldId: "parent",
            name: "Parent",
            required: true
          }
        ],
        maxResults: 50,
        startAt: 0,
        total: 1
      }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Parent body",
          issueKey: "OPS-1",
          issueTypeName: "Task",
          projectKey: "OPS",
          summary: "Parent task",
          updated: "2026-03-11T00:00:00.000Z"
        })
      )
    ]);

    await expect(pushMarkdownToJira()).rejects.toThrow(/same project/i);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("push creates a sub-task when the parent is valid", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {},
            "Sub-task": {}
          }
        }
      },
      fileContent:
        "---\nissueType: Sub-task\nparent: ENG-1\nsummary: Child task\n---\nChild body\n",
      fileName: "child-task.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "parent", name: "Parent" }
      ]),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(
        200,
        createIssueTypesPage([
          { id: "10000", name: "Task", subtask: false },
          { id: "10001", name: "Sub-task", subtask: true }
        ])
      ),
      jsonResponse(200, {
        fields: [
          {
            fieldId: "parent",
            name: "Parent",
            required: true
          }
        ],
        maxResults: 50,
        startAt: 0,
        total: 1
      }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Parent body",
          issueKey: "ENG-1",
          issueTypeName: "Task",
          projectKey: "ENG",
          summary: "Parent task",
          updated: "2026-03-11T00:00:00.000Z"
        })
      ),
      jsonResponse(201, { id: "10002", key: "ENG-2" }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Child body",
          id: "10002",
          issueKey: "ENG-2",
          issueTypeName: "Sub-task",
          issueTypeSubtask: true,
          parentKey: "ENG-1",
          projectKey: "ENG",
          summary: "Child task",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "create",
      issueKey: "ENG-2",
      summary: "Child task"
    });

    const createCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/rest/api/3/issue")
    );
    expect(createCall).toBeDefined();
    const createPayload = JSON.parse(createCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(createPayload.fields?.parent).toEqual({ key: "ENG-1" });
    expect(createPayload.fields?.issuetype).toEqual({ name: "Sub-task" });
  });

  test("push allows modern parent on non-subtask creates when Jira exposes the field", async () => {
    await setupProjectWorkspace({
      fileContent:
        "---\nissueType: Task\nparent: ENG-1\nsummary: Story under epic\n---\nBody\n",
      fileName: "modern-parent-create.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "parent", name: "Parent" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        fields: [
          {
            fieldId: "parent",
            name: "Parent",
            required: false
          }
        ],
        maxResults: 50,
        startAt: 0,
        total: 1
      }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Epic body",
          issueKey: "ENG-1",
          issueTypeName: "Epic",
          projectKey: "ENG",
          summary: "Parent epic",
          updated: "2026-03-11T00:00:00.000Z"
        })
      ),
      jsonResponse(201, { id: "10003", key: "ENG-3" }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Body",
          id: "10003",
          issueKey: "ENG-3",
          issueTypeName: "Task",
          parentKey: "ENG-1",
          projectKey: "ENG",
          summary: "Story under epic",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "create",
      issueKey: "ENG-3",
      summary: "Story under epic"
    });

    const createCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/rest/api/3/issue")
    );
    expect(createCall).toBeDefined();
    const createPayload = JSON.parse(createCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(createPayload.fields?.parent).toEqual({ key: "ENG-1" });
  });

  test("push updates parent through the modern Jira parent field", async () => {
    await setupWorkspace({
      fileContent:
        "---\nissue: ENG-1\nsummary: Reparent me\nparent: ENG-42\n---\nLocal body\n",
      fileName: "ENG-1 - Reparent me.md",
      issueSummary: "Reparent me"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "parent", name: "Parent" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Local body",
          issueKey: "ENG-1",
          issueTypeName: "Task",
          parentKey: "ENG-2",
          projectKey: "ENG",
          summary: "Reparent me",
          updated: "2026-03-10T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          parent: {
            name: "Parent",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Parent body",
          issueKey: "ENG-42",
          issueTypeName: "Epic",
          projectKey: "ENG",
          summary: "Parent epic",
          updated: "2026-03-11T00:00:00.000Z"
        })
      ),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Local body",
          issueKey: "ENG-1",
          issueTypeName: "Task",
          parentKey: "ENG-42",
          projectKey: "ENG",
          summary: "Reparent me",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "update",
      issueKey: "ENG-1",
      summary: "Reparent me"
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeDefined();
    const updatePayload = JSON.parse(updateCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(updatePayload.fields).toEqual({
      parent: { key: "ENG-42" }
    });
  });
});

describe("field resolver coverage", () => {
  test("push resolves create fields for common Jira field types from create metadata", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {
              audience: {
                fieldId: "customfield_10010",
                resolver: "optionArrayByName"
              }
            }
          }
        }
      },
      fileContent:
        "---\nissueType: Task\nsummary: Create resolver coverage\npriority: High\ncomponents:\n  - API\n  - UI\nfixVersions:\n  - 2026.03\naudience:\n  - Customer\n  - Internal\n---\nCreate body\n",
      fileName: "create-resolver-coverage.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "priority", name: "Priority", schema: { system: "priority", type: "priority" } },
        {
          id: "components",
          name: "Components",
          schema: { items: "component", system: "components", type: "array" }
        },
        {
          id: "fixVersions",
          name: "Fix versions",
          schema: { items: "version", system: "fixVersions", type: "array" }
        },
        {
          id: "customfield_10010",
          name: "Audience",
          schema: { items: "option", type: "array" }
        }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        fields: [
          {
            allowedValues: [
              { id: "2", name: "High" }
            ],
            fieldId: "priority",
            name: "Priority",
            required: false
          },
          {
            allowedValues: [
              { id: "10", name: "API" },
              { id: "11", name: "UI" }
            ],
            fieldId: "components",
            name: "Components",
            required: false
          },
          {
            allowedValues: [
              { id: "20", name: "2026.03" }
            ],
            fieldId: "fixVersions",
            name: "Fix versions",
            required: false
          },
          {
            allowedValues: [
              { id: "100", value: "Customer" },
              { id: "101", value: "Internal" }
            ],
            fieldId: "customfield_10010",
            name: "Audience",
            required: false
          }
        ],
        maxResults: 50,
        startAt: 0,
        total: 4
      }),
      jsonResponse(201, { id: "10002", key: "ENG-2" }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Create body",
          summary: "Create resolver coverage",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "create",
      issueKey: "ENG-2",
      summary: "Create resolver coverage"
    });

    const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/rest/api/3/issue"));
    expect(createCall).toBeDefined();
    const createPayload = JSON.parse(createCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(createPayload.fields?.priority).toEqual({ id: "2" });
    expect(createPayload.fields?.components).toEqual([{ id: "10" }, { id: "11" }]);
    expect(createPayload.fields?.fixVersions).toEqual([{ id: "20" }]);
    expect(createPayload.fields?.customfield_10010).toEqual([{ id: "100" }, { id: "101" }]);
  });

  test("push transitions newly created issues when frontmatter status is set", async () => {
    await setupProjectWorkspace({
      fileContent:
        "---\nissueType: Task\nsummary: Create with status\nstatus: Done\n---\nCreate body\n",
      fileName: "create-with-status.md"
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        fields: [],
        maxResults: 50,
        startAt: 0,
        total: 0
      }),
      jsonResponse(201, { id: "10002", key: "ENG-2" }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Create body",
          id: "10002",
          issueKey: "ENG-2",
          statusName: "To Do",
          summary: "Create with status",
          updated: "2026-03-12T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        transitions: [
          {
            id: "41",
            name: "Complete",
            to: { name: "Done" }
          }
        ]
      }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Create body",
          id: "10002",
          issueKey: "ENG-2",
          statusName: "Done",
          summary: "Create with status",
          updated: "2026-03-12T01:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "create",
      issueKey: "ENG-2",
      summary: "Create with status"
    });

    const createCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/rest/api/3/issue")
    );
    expect(createCall).toBeDefined();
    const createPayload = JSON.parse(createCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(createPayload.fields?.status).toBeUndefined();

    const transitionCall = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith("/rest/api/3/issue/ENG-2/transitions")
    );
    expect(transitionCall).toBeDefined();
    expect(JSON.parse(transitionCall?.body ?? "{}")).toEqual({
      transition: {
        id: "41"
      }
    });
  });

  test("push resolves update fields from edit metadata", async () => {
    await setupWorkspace({
      fileContent:
        "---\nissue: ENG-1\nsummary: Update resolver coverage\npriority: High\ncomponents:\n  - API\naudience:\n  - Customer\n---\nUpdate body\n",
      fileName: "ENG-1 - Update resolver coverage.md",
      issueSummary: "Update resolver coverage"
    });
    const configPath = process.env.JIRA_MARKDOWN_CONFIG_FILE as string;
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          dir: "issues",
          projectIssueTypeFieldMap: {
            ENG: {
              Task: {
                audience: {
                  fieldId: "customfield_10010",
                  resolver: "optionArrayByName"
                }
              }
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const remoteIssue = createIssueRecord({
      description: "Remote body",
      summary: "Update resolver coverage",
      updated: "2026-03-10T00:00:00.000Z"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "priority", name: "Priority", schema: { system: "priority", type: "priority" } },
        {
          id: "components",
          name: "Components",
          schema: { items: "component", system: "components", type: "array" }
        },
        {
          id: "customfield_10010",
          name: "Audience",
          schema: { items: "option", type: "array" }
        }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, remoteIssue),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          },
          priority: {
            allowedValues: [{ id: "2", name: "High" }],
            name: "Priority",
            operations: ["set"],
            schema: { system: "priority", type: "priority" }
          },
          components: {
            allowedValues: [{ id: "10", name: "API" }],
            name: "Components",
            operations: ["set"],
            schema: { items: "component", system: "components", type: "array" }
          },
          customfield_10010: {
            allowedValues: [{ id: "100", value: "Customer" }],
            name: "Audience",
            operations: ["set"],
            schema: { items: "option", type: "array" }
          }
        }
      }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Update body",
          summary: "Update resolver coverage",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "update",
      issueKey: "ENG-1",
      summary: "Update resolver coverage"
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeDefined();
    const updatePayload = JSON.parse(updateCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(updatePayload.fields?.priority).toEqual({ id: "2" });
    expect(updatePayload.fields?.components).toEqual([{ id: "10" }]);
    expect(updatePayload.fields?.customfield_10010).toEqual([{ id: "100" }]);
  });

  test("push falls back to priority name when Jira omits allowedValues for the operation", async () => {
    await setupWorkspace({
      fileContent:
        "---\nissue: ENG-1\nsummary: Update resolver coverage\npriority: High\n---\nUpdate body\n",
      fileName: "ENG-1 - Update resolver coverage.md",
      issueSummary: "Update resolver coverage"
    });

    const remoteIssue = createIssueRecord({
      description: "Remote body",
      summary: "Update resolver coverage",
      updated: "2026-03-10T00:00:00.000Z"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "priority", name: "Priority", schema: { system: "priority", type: "priority" } }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, remoteIssue),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          },
          priority: {
            name: "Priority",
            operations: ["set"],
            schema: { system: "priority", type: "priority" }
          }
        }
      }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Update body",
          summary: "Update resolver coverage",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "update",
      issueKey: "ENG-1",
      summary: "Update resolver coverage"
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeDefined();
    const updatePayload = JSON.parse(updateCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    expect(updatePayload.fields?.priority).toEqual({ name: "High" });
  });

  test("push prunes unchanged non-editable priority before edit-screen validation", async () => {
    await setupWorkspace({
      fileContent:
        "---\nissue: ENG-1\nsummary: Update resolver coverage\npriority: High\n---\nLocal body\n",
      fileName: "ENG-1 - Update resolver coverage.md",
      issueSummary: "Update resolver coverage"
    });

    const remoteIssue = createIssueRecord({
      description: "Remote body",
      summary: "Update resolver coverage",
      updated: "2026-03-10T00:00:00.000Z"
    });
    remoteIssue.fields.priority = { id: "2", name: "High" };

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "priority", name: "Priority", schema: { system: "priority", type: "priority" } }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, remoteIssue),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Local body",
          summary: "Update resolver coverage",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "update",
      issueKey: "ENG-1",
      summary: "Update resolver coverage"
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeDefined();
    const updatePayload = JSON.parse(updateCall?.body ?? "{}") as {
      fields?: Record<string, unknown>;
    };
    const issueFetchCall = calls.find(
      (call) =>
        call.method === "GET" &&
        call.url.includes("/rest/api/3/issue/ENG-1?")
    );
    expect(issueFetchCall?.url).toContain("priority");
    expect(updatePayload.fields?.priority).toBeUndefined();
    expect(updatePayload.fields?.description).toBeDefined();
  });

  test("push dry-run skips updates when every field is pruned", async () => {
    await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nRemote body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const { calls } = createSequentialFetch([
        jsonResponse(200, [
          { id: "summary", name: "Summary" },
          { id: "description", name: "Description" }
        ]),
        jsonResponse(200, createIssueTypesPage()),
        jsonResponse(
          200,
          createIssueRecord({
            description: "Remote body",
            summary: "Local summary",
            updated: "2026-03-10T00:00:00.000Z"
          })
        ),
        jsonResponse(200, {
          fields: {
            description: {
              name: "Description",
              operations: ["set"]
            },
            summary: {
              name: "Summary",
              operations: ["set"]
            }
          }
        })
      ]);

      const results = await pushMarkdownToJira({ dryRun: true });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        action: "skip",
        issueKey: "ENG-1",
        summary: "Local summary"
      });
      expect(calls.find((call) => call.method === "PUT")).toBeUndefined();
      expect(logs).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  test("push records equivalent no-op updates as skips", async () => {
    const { filePath, historyPath } = await setupWorkspace({
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nRemote body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const { calls } = createSequentialFetch([
        jsonResponse(200, [
          { id: "summary", name: "Summary" },
          { id: "description", name: "Description" }
        ]),
        jsonResponse(200, createIssueTypesPage()),
        jsonResponse(
          200,
          createIssueRecord({
            description: "Remote body",
            summary: "Local summary",
            updated: "2026-03-10T00:00:00.000Z"
          })
        ),
        jsonResponse(200, {
          fields: {
            description: {
              name: "Description",
              operations: ["set"]
            },
            summary: {
              name: "Summary",
              operations: ["set"]
            }
          }
        })
      ]);

      const results = await pushMarkdownToJira();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        action: "skip",
        issueKey: "ENG-1",
        summary: "Local summary"
      });
      expect(calls.find((call) => call.method === "PUT")).toBeUndefined();
      expect(logs).toEqual([]);

      const reloaded = await loadSyncHistory(historyPath);
      const fileStats = await stat(filePath);
      const fileRecords = Object.values(reloaded.history.files);
      expect(fileRecords).toHaveLength(1);
      expect(fileRecords[0]?.lastSyncedMtimeMs).toBe(fileStats.mtimeMs);
      expect(reloaded.history.stats.push?.skippedUnchanged).toBe(1);
      expect(reloaded.history.stats.push?.updated).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  test("push skip-by-history survives cwd changes when config dir is absolute", async () => {
    const absoluteDir = join(await createTempDirectory(), "issues");
    const { filePath, historyPath } = await setupWorkspace({
      dir: absoluteDir,
      fileContent: "---\nissue: ENG-1\nsummary: Local summary\n---\nRemote body\n",
      fileName: "ENG-1 - Local summary.md",
      issueSummary: "Local summary"
    });

    createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Remote body",
          summary: "Local summary",
          updated: "2026-03-10T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      })
    ]);

    await pushMarkdownToJira();

    const reloaded = await loadSyncHistory(historyPath);
    expect(Object.keys(reloaded.history.files)).toEqual([toHistoryPath(filePath)]);
    expect(reloaded.history.issues["ENG-1"]?.filePath).toBe(toHistoryPath(filePath));

    process.chdir(await createTempDirectory());
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Remote body",
          summary: "Local summary",
          updated: "2026-03-10T00:00:00.000Z"
        })
      ),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      })
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "skip",
      issueKey: "ENG-1",
      summary: "Local summary"
    });
    expect(calls.some((call) => call.url.includes("/rest/api/3/issue/ENG-1?"))).toBe(false);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test("push transitions Jira when frontmatter status changes", async () => {
    await setupWorkspace({
      fileContent:
        "---\nissue: ENG-1\nsummary: Status sync\nstatus: In Progress\n---\nRemote body\n",
      fileName: "ENG-1 - Status sync.md",
      issueSummary: "Status sync"
    });

    const remoteIssue = createIssueRecord({
      description: "Remote body",
      statusName: "To Do",
      summary: "Status sync",
      updated: "2026-03-10T00:00:00.000Z"
    });
    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, remoteIssue),
      jsonResponse(200, {
        fields: {
          description: {
            name: "Description",
            operations: ["set"]
          },
          summary: {
            name: "Summary",
            operations: ["set"]
          }
        }
      }),
      jsonResponse(200, {
        transitions: [
          {
            id: "31",
            name: "Start progress",
            to: { name: "In Progress" }
          }
        ]
      }),
      new Response(null, { status: 204 }),
      jsonResponse(
        200,
        createIssueRecord({
          description: "Remote body",
          statusName: "In Progress",
          summary: "Status sync",
          updated: "2026-03-12T00:00:00.000Z"
        })
      )
    ]);

    const results = await pushMarkdownToJira();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "update",
      issueKey: "ENG-1",
      summary: "Status sync"
    });

    const issueFetchCall = calls.find(
      (call) =>
        call.method === "GET" &&
        call.url.includes("/rest/api/3/issue/ENG-1?")
    );
    expect(issueFetchCall?.url).toContain("status");

    const transitionCall = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith("/rest/api/3/issue/ENG-1/transitions")
    );
    expect(transitionCall).toBeDefined();
    expect(JSON.parse(transitionCall?.body ?? "{}")).toEqual({
      transition: {
        id: "31"
      }
    });

    const updateCall = calls.find((call) => call.method === "PUT");
    expect(updateCall).toBeUndefined();
  });

  test("pull writes system and mapped custom fields back into top-level frontmatter", async () => {
    await setupProjectWorkspace({
      config: {
        dir: "issues",
        projectIssueTypeFieldMap: {
          ENG: {
            Task: {
              audience: {
                fieldId: "customfield_10010",
                resolver: "optionArrayByName"
              }
            }
          }
        }
      }
    });

    const { calls } = createSequentialFetch([
      jsonResponse(200, [
        { id: "summary", name: "Summary" },
        { id: "description", name: "Description" },
        { id: "priority", name: "Priority", schema: { system: "priority", type: "priority" } },
        {
          id: "components",
          name: "Components",
          schema: { items: "component", system: "components", type: "array" }
        },
        {
          id: "fixVersions",
          name: "Fix versions",
          schema: { items: "version", system: "fixVersions", type: "array" }
        },
        {
          id: "customfield_10010",
          name: "Audience",
          schema: { items: "option", type: "array" }
        }
      ]),
      jsonResponse(200, createIssueTypesPage()),
      jsonResponse(200, {
        issues: [
          {
            fields: {
              attachment: [],
              components: [
                { id: "10", name: "API" },
                { id: "11", name: "UI" }
              ],
              customfield_10010: [
                { id: "100", value: "Customer" },
                { id: "101", value: "Internal" }
              ],
              description: {
                content: [
                  {
                    content: [{ text: "Remote body", type: "text" }],
                    type: "paragraph"
                  }
                ],
                type: "doc",
                version: 1
              },
              fixVersions: [{ id: "20", name: "2026.03" }],
              issuetype: { name: "Task" },
              labels: [],
              priority: { id: "2", name: "High" },
              project: { key: "ENG" },
              status: { name: "In Progress" },
              summary: "Pulled resolver coverage",
              updated: "2026-03-12T00:00:00.000Z"
            },
            id: "10001",
            key: "ENG-1"
          }
        ],
        isLast: true
      })
    ]);

    const results = await pullJiraToMarkdown({
      projects: ["ENG"]
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "pull",
      issueKey: "ENG-1",
      summary: "Pulled resolver coverage"
    });
    expect(calls[2]?.method).toBe("POST");

    const pulledPath = join(process.cwd(), "issues", "ENG", "ENG-1 - Pulled resolver coverage.md");
    const pulledMarkdown = await readFile(pulledPath, "utf8");
    expect(pulledMarkdown).toContain("status: In Progress");
    expect(pulledMarkdown).toContain("priority: High");
    expect(pulledMarkdown).toContain("components:");
    expect(pulledMarkdown).toContain("- API");
    expect(pulledMarkdown).toContain("fixVersions:");
    expect(pulledMarkdown).toContain("- '2026.03'");
    expect(pulledMarkdown).toContain("audience:");
    expect(pulledMarkdown).toContain("- Customer");
  });
});
