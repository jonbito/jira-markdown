import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  clearStoredAuth,
  loadStoredAuthConfig,
  normalizeBaseUrl,
  persistStoredAuth,
  readStoredAuthStatus
} from "./auth-store.js";
import { JiraClient } from "./jira.js";
import { type AuthMode } from "./types.js";

interface AuthLoginOptions {
  authMode?: AuthMode;
  baseUrl?: string;
  email?: string;
  storage?: "auto" | "file" | "keychain";
  token?: string;
  verify?: boolean;
}

function ensureInteractive(fieldName: string): never {
  throw new Error(
    `Missing ${fieldName}. Provide it as a flag or run the command in an interactive terminal.`
  );
}

async function promptLine(label: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
  const rl = createInterface({ input, output });

  try {
    const answer = (await rl.question(prompt)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    ensureInteractive("token");
  }

  return await new Promise<string>((resolve, reject) => {
    const stdin = input;
    const stdout = output;
    let value = "";

    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const finish = (result: string) => {
      cleanup();
      stdout.write("\n");
      resolve(result);
    };

    const fail = (error: Error) => {
      cleanup();
      stdout.write("\n");
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      for (const character of text) {
        if (character === "\u0003") {
          fail(new Error("Cancelled."));
          return;
        }

        if (character === "\u0004") {
          fail(new Error("Input closed."));
          return;
        }

        if (character === "\r" || character === "\n") {
          finish(value.trim());
          return;
        }

        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        value += character;
      }
    };

    stdout.write(`${label}: `);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

async function resolveBaseUrl(baseUrl?: string): Promise<string> {
  if (baseUrl?.trim()) {
    return normalizeBaseUrl(baseUrl);
  }

  if (!input.isTTY) {
    ensureInteractive("base URL");
  }

  return normalizeBaseUrl(await promptLine("Jira base URL"));
}

async function resolveAuthMode(authMode?: AuthMode): Promise<AuthMode> {
  if (authMode) {
    return authMode;
  }

  if (!input.isTTY) {
    return "basic";
  }

  const raw = (await promptLine("Auth mode (basic/bearer)", "basic")).toLowerCase();
  if (raw !== "basic" && raw !== "bearer") {
    throw new Error(`Unsupported auth mode "${raw}". Use "basic" or "bearer".`);
  }

  return raw;
}

async function resolveEmail(authMode: AuthMode, email?: string): Promise<string | undefined> {
  if (authMode !== "basic") {
    return undefined;
  }

  if (email?.trim()) {
    return email.trim();
  }

  if (!input.isTTY) {
    ensureInteractive("email");
  }

  const resolved = (await promptLine("Jira account email")).trim();
  if (!resolved) {
    throw new Error("Basic auth requires an email address.");
  }

  return resolved;
}

async function resolveToken(authMode: AuthMode, token?: string): Promise<string> {
  if (token?.trim()) {
    return token.trim();
  }

  const label =
    authMode === "basic" ? "Jira API token" : "Jira bearer token";
  const resolved = await promptSecret(label);

  if (!resolved) {
    throw new Error("A token is required.");
  }

  return resolved;
}

export async function authLogin(options: AuthLoginOptions = {}): Promise<void> {
  const authMode = await resolveAuthMode(options.authMode);
  const baseUrl = await resolveBaseUrl(options.baseUrl);
  const email = await resolveEmail(authMode, options.email);
  const token = await resolveToken(authMode, options.token);

  const auth =
    authMode === "basic"
      ? {
          apiToken: token,
          authMode,
          baseUrl,
          email
        }
      : {
          authMode,
          baseUrl,
          bearerToken: token
        };

  let verifiedDisplayName: string | undefined;
  if (options.verify ?? true) {
    output.write("Verifying Jira credentials...\n");
    const jira = new JiraClient(auth);
    const currentUser = await jira.getCurrentUser();
    verifiedDisplayName = currentUser.displayName;
  }

  const saved = await persistStoredAuth(
    {
      authMode,
      baseUrl,
      email,
      token
    },
    options.storage
      ? {
          storagePreference: options.storage
        }
      : undefined
  );

  output.write(
    `Saved Jira auth for ${baseUrl} using ${saved.secretStorage} storage at ${saved.authFilePath}.\n`
  );
  if (verifiedDisplayName) {
    output.write(`Verified as ${verifiedDisplayName}.\n`);
  }
}

export async function authStatus(): Promise<void> {
  const status = await readStoredAuthStatus();

  if (!status.record) {
    output.write("No Jira auth is configured. Run \"jira-markdown auth login\".\n");
    output.write(`Expected auth file path: ${status.authFilePath}\n`);
    return;
  }

  await loadStoredAuthConfig();

  output.write(`Auth file: ${status.authFilePath}\n`);
  output.write(`Base URL: ${status.record.baseUrl}\n`);
  output.write(`Auth mode: ${status.record.authMode}\n`);
  output.write(`Storage: ${status.record.secretStorage}\n`);
  if (status.record.email) {
    output.write(`Email: ${status.record.email}\n`);
  }
  output.write(`Updated: ${status.record.updatedAt}\n`);
}

export async function authLogout(): Promise<void> {
  const removed = await clearStoredAuth();
  if (removed) {
    output.write("Cleared stored Jira auth.\n");
    return;
  }

  output.write("No stored Jira auth was found.\n");
}
