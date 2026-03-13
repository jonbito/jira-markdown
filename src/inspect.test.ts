import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistStoredAuth } from "./auth-store";
import { inspectIssueAdf } from "./inspect";

const originalFetch = globalThis.fetch;
const originalAuthFile = process.env.JIRA_MARKDOWN_AUTH_FILE;
const tempDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;

  if (originalAuthFile === undefined) {
    delete process.env.JIRA_MARKDOWN_AUTH_FILE;
  } else {
    process.env.JIRA_MARKDOWN_AUTH_FILE = originalAuthFile;
  }

  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-inspect-"));
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

describe("inspectIssueAdf", () => {
  test("prints the Jira description document for an issue key", async () => {
    const directory = await createTempDirectory();
    const authFilePath = join(directory, "auth.json");
    process.env.JIRA_MARKDOWN_AUTH_FILE = authFilePath;

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

    const calls: Array<{
      authorization: string | null;
      method: string;
      url: string;
    }> = [];

    globalThis.fetch = (async (input, init) => {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET",
        url: String(input)
      });

      return jsonResponse(200, {
        fields: {
          description: {
            content: [
              {
                content: [{ text: "Inspect me", type: "text" }],
                type: "paragraph"
              }
            ],
            type: "doc",
            version: 1
          }
        }
      });
    }) as typeof fetch;

    let output = "";
    await inspectIssueAdf("GRIP-2", (content) => {
      output += content;
    });

    expect(JSON.parse(output)).toEqual({
      content: [
        {
          content: [{ text: "Inspect me", type: "text" }],
          type: "paragraph"
        }
      ],
      type: "doc",
      version: 1
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET"
    });
    expect(calls[0]?.authorization).toMatch(/^Basic /);
    const requestUrl = new URL(calls[0]?.url ?? "/");
    expect(requestUrl.pathname).toBe("/rest/api/3/issue/GRIP-2");
    expect(requestUrl.searchParams.get("fields")).toBe("description");
  });
});
