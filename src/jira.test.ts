import { describe, expect, test } from "./test-helpers.js";
import { JiraApiError, JiraClient } from "./jira.js";
import { type JiraAuthConfig } from "./types.js";

const auth: JiraAuthConfig = {
  apiToken: "token",
  authMode: "basic",
  baseUrl: "https://example.atlassian.net",
  email: "dev@example.com"
};

function jsonResponse(status: number, body: unknown, headers: RequestInit["headers"] = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");

  return new Response(JSON.stringify(body), {
    headers: responseHeaders,
    status
  });
}

function textResponse(status: number, body: string, headers: RequestInit["headers"] = {}): Response {
  const responseHeaders = new Headers(headers);

  return new Response(body, {
    headers: responseHeaders,
    status
  });
}

function createClient(
  responses: Response[],
  retry: {
    baseDelayMs?: number;
    maxAttempts?: number;
    maxDelayMs?: number;
  } = {}
): {
  calls: Array<{
    body: RequestInit["body"] | null | undefined;
    headers: Headers;
    method: string;
    url: string;
  }>;
  client: JiraClient;
  delays: number[];
} {
  const calls: Array<{
    body: RequestInit["body"] | null | undefined;
    headers: Headers;
    method: string;
    url: string;
  }> = [];
  const delays: number[] = [];
  let callIndex = 0;

  const client = new JiraClient(auth, {
    fetch: async (input, init) => {
      calls.push({
        body: init?.body,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(input)
      });

      const response = responses[callIndex];
      callIndex += 1;
      if (!response) {
        throw new Error(`Unexpected fetch call ${callIndex}.`);
      }

      return response;
    },
    retry,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    }
  });

  return { calls, client, delays };
}

describe("JiraClient retry behavior", () => {
  test("retries 429 responses using Retry-After before succeeding", async () => {
    const { client, calls, delays } = createClient([
      jsonResponse(429, { errorMessages: ["Rate limited"] }, { "Retry-After": "2" }),
      jsonResponse(200, [{ id: "summary", name: "Summary" }])
    ]);

    const fields = await client.getFields();

    expect(fields).toEqual([{ id: "summary", name: "Summary" }]);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2_000]);
  });

  test("retries transient 5xx responses for JSON POST requests", async () => {
    const { client, calls, delays } = createClient(
      [
        jsonResponse(503, { message: "Temporarily unavailable" }),
        jsonResponse(201, { id: "10001", key: "ENG-1" })
      ],
      {
        baseDelayMs: 25,
        maxAttempts: 3,
        maxDelayMs: 100
      }
    );

    const created = await client.createIssue({ summary: "Retry me" });

    expect(created).toEqual({ id: "10001", key: "ENG-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[0]?.body).toBe('{"fields":{"summary":"Retry me"}}');
    expect(calls[1]?.body).toBe('{"fields":{"summary":"Retry me"}}');
    expect(delays).toEqual([25]);
  });

  test("does not retry non-retryable Jira errors", async () => {
    const { client, calls, delays } = createClient([
      jsonResponse(400, { errorMessages: ["Bad request"] })
    ]);

    let thrown: unknown;
    try {
      await client.getFields();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JiraApiError);
    expect((thrown as JiraApiError).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("stops retrying after the configured max attempts", async () => {
    const { client, calls, delays } = createClient(
      [
        jsonResponse(503, { message: "Still unavailable" }),
        jsonResponse(503, { message: "Still unavailable" }),
        jsonResponse(503, { message: "Still unavailable" })
      ],
      {
        baseDelayMs: 25,
        maxAttempts: 3,
        maxDelayMs: 100
      }
    );

    let thrown: unknown;
    try {
      await client.getFields();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JiraApiError);
    expect((thrown as JiraApiError).status).toBe(503);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([25, 50]);
  });

  test("retries transient 5xx responses for attachment downloads", async () => {
    const { client, calls, delays } = createClient(
      [
        textResponse(502, "Temporary gateway error"),
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      ],
      {
        baseDelayMs: 25,
        maxAttempts: 3,
        maxDelayMs: 100
      }
    );

    const bytes = await client.downloadAttachmentContent("10001");

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/rest/api/3/attachment/content/10001");
    expect(delays).toEqual([25]);
  });
});
