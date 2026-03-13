import { afterEach, describe, expect, test } from "./test-helpers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStoredAuth,
  loadStoredAuthConfig,
  normalizeBaseUrl,
  persistStoredAuth,
  readStoredAuthStatus
} from "./auth-store.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function createTempAuthFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-markdown-auth-"));
  tempDirectories.push(directory);
  return join(directory, "auth.json");
}

describe("normalizeBaseUrl", () => {
  test("adds https when a scheme is omitted", () => {
    expect(normalizeBaseUrl("arch.atlassian.net")).toBe("https://arch.atlassian.net");
  });

  test("rejects base urls with paths", () => {
    expect(() => normalizeBaseUrl("https://arch.atlassian.net/jira")).toThrow();
  });
});

describe("file-backed auth storage", () => {
  test("persists and reloads basic auth", async () => {
    const authFilePath = await createTempAuthFilePath();

    await persistStoredAuth(
      {
        authMode: "basic",
        baseUrl: "arch.atlassian.net",
        email: "dev@example.com",
        token: "super-secret"
      },
      {
        authFilePath,
        storagePreference: "file"
      }
    );

    const loaded = await loadStoredAuthConfig({ authFilePath });
    expect(loaded.baseUrl).toBe("https://arch.atlassian.net");
    expect(loaded.authMode).toBe("basic");
    expect(loaded.email).toBe("dev@example.com");
    expect(loaded.apiToken).toBe("super-secret");

    const status = await readStoredAuthStatus({ authFilePath });
    expect(status.record?.secretStorage).toBe("file");

    const raw = JSON.parse(await readFile(authFilePath, "utf8")) as {
      token?: string;
      baseUrl?: string;
    };
    expect(raw.token).toBe("super-secret");
    expect(raw.baseUrl).toBe("https://arch.atlassian.net");
  });

  test("clears stored auth", async () => {
    const authFilePath = await createTempAuthFilePath();

    await persistStoredAuth(
      {
        authMode: "bearer",
        baseUrl: "https://arch.atlassian.net",
        token: "bearer-token"
      },
      {
        authFilePath,
        storagePreference: "file"
      }
    );

    expect(await clearStoredAuth({ authFilePath })).toBe(true);
    const status = await readStoredAuthStatus({ authFilePath });
    expect(status.record).toBeUndefined();
  });
});
