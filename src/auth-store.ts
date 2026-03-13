import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type AuthMode,
  type AuthStorageKind,
  type JiraAuthConfig,
  type StoredAuthRecord
} from "./types";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "jira-markdown";
const KEYCHAIN_ACCOUNT = "default";

const storedAuthSchema = z
  .object({
    authMode: z.enum(["basic", "bearer"]),
    baseUrl: z.string().url(),
    email: z.string().email().optional(),
    secretStorage: z.enum(["file", "keychain"]),
    token: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
    version: z.literal(1)
  })
  .superRefine((value, ctx) => {
    if (value.authMode === "basic" && !value.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stored basic auth requires an email address."
      });
    }

    if (value.secretStorage === "file" && !value.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "File-backed auth storage requires a token."
      });
    }
  });

const persistAuthSchema = z
  .object({
    authMode: z.enum(["basic", "bearer"]),
    baseUrl: z.string().min(1),
    email: z.string().email().optional(),
    storagePreference: z.enum(["auto", "file", "keychain"]).default("auto"),
    token: z.string().min(1)
  })
  .superRefine((value, ctx) => {
    if (value.authMode === "basic" && !value.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Basic auth requires an email address."
      });
    }
  });

interface AuthPathOptions {
  authFilePath?: string;
}

interface PersistAuthOptions extends AuthPathOptions {
  storagePreference?: "auto" | "file" | "keychain";
}

export interface StoredAuthStatus {
  authFilePath: string;
  record?: StoredAuthRecord | undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function ensureBasicEmail(authMode: AuthMode, email: string | undefined): string | undefined {
  if (authMode === "basic" && !email) {
    throw new Error("Basic auth requires an email address.");
  }

  return email;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}

async function writeJsonFile(filePath: string, value: StoredAuthRecord): Promise<void> {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await chmod(filePath, 0o600);
}

async function keychainAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    await execFileAsync("security", ["help"]);
    return true;
  } catch {
    return false;
  }
}

async function writeTokenToKeychain(token: string): Promise<void> {
  await execFileAsync("security", [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-U",
    "-w",
    token
  ]);
}

async function readTokenFromKeychain(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w"
    ]);

    const token = stdout.trim();
    return token ? token : undefined;
  } catch {
    return undefined;
  }
}

async function deleteTokenFromKeychain(): Promise<void> {
  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE
    ]);
  } catch {
    // Ignore missing keychain items and unsupported environments.
  }
}

function resolveStoragePreference(
  storagePreference: "auto" | "file" | "keychain",
  canUseKeychain: boolean
): AuthStorageKind {
  if (storagePreference === "file") {
    return "file";
  }

  if (storagePreference === "keychain") {
    if (!canUseKeychain) {
      throw new Error("Keychain storage is not available on this machine.");
    }
    return "keychain";
  }

  return canUseKeychain ? "keychain" : "file";
}

export function getDefaultAppConfigDirectory(env = process.env): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "jira-markdown");
  }

  const configRoot = env.XDG_CONFIG_HOME?.trim()
    ? resolve(env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(configRoot, "jira-markdown");
}

export function getDefaultAuthFilePath(env = process.env): string {
  const override = env.JIRA_MARKDOWN_AUTH_FILE?.trim();
  if (override) {
    return resolve(override);
  }

  return join(getDefaultAppConfigDirectory(env), "auth.json");
}

export function normalizeBaseUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Jira base URL is required.");
  }

  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  const url = new URL(withScheme);

  if (url.username || url.password) {
    throw new Error("Jira base URL must not include embedded credentials.");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "Jira base URL must be the site root, for example https://your-domain.atlassian.net."
    );
  }

  url.hash = "";
  url.search = "";
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export async function readStoredAuthRecord(
  options: AuthPathOptions = {}
): Promise<StoredAuthRecord | undefined> {
  const authFilePath = options.authFilePath ?? getDefaultAuthFilePath();

  try {
    const raw = await readFile(authFilePath, "utf8");
    return storedAuthSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function readStoredAuthStatus(
  options: AuthPathOptions = {}
): Promise<StoredAuthStatus> {
  const authFilePath = options.authFilePath ?? getDefaultAuthFilePath();
  const record = await readStoredAuthRecord({ authFilePath });
  return { authFilePath, record };
}

export async function persistStoredAuth(
  input: {
    authMode: AuthMode;
    baseUrl: string;
    email?: string | undefined;
    token: string;
  },
  options: PersistAuthOptions = {}
): Promise<{ authFilePath: string; secretStorage: AuthStorageKind }> {
  const storagePreference = options.storagePreference ?? "auto";
  const parsed = persistAuthSchema.parse({
    ...input,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    email: ensureBasicEmail(input.authMode, input.email),
    storagePreference
  });
  const authFilePath = options.authFilePath ?? getDefaultAuthFilePath();
  const canUseKeychain = await keychainAvailable();
  const secretStorage = resolveStoragePreference(parsed.storagePreference, canUseKeychain);

  if (secretStorage === "keychain") {
    await writeTokenToKeychain(parsed.token);
    await writeJsonFile(authFilePath, {
      authMode: parsed.authMode,
      baseUrl: parsed.baseUrl,
      email: parsed.email,
      secretStorage,
      updatedAt: new Date().toISOString(),
      version: 1
    });
    return { authFilePath, secretStorage };
  }

  await deleteTokenFromKeychain();
  await writeJsonFile(authFilePath, {
    authMode: parsed.authMode,
    baseUrl: parsed.baseUrl,
    email: parsed.email,
    secretStorage,
    token: parsed.token,
    updatedAt: new Date().toISOString(),
    version: 1
  });

  return { authFilePath, secretStorage };
}

export async function clearStoredAuth(options: AuthPathOptions = {}): Promise<boolean> {
  const authFilePath = options.authFilePath ?? getDefaultAuthFilePath();
  const existing = await readStoredAuthRecord({ authFilePath });

  await deleteTokenFromKeychain();

  try {
    await rm(authFilePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return Boolean(existing);
}

export async function loadStoredAuthConfig(
  options: AuthPathOptions = {}
): Promise<JiraAuthConfig> {
  const authFilePath = options.authFilePath ?? getDefaultAuthFilePath();
  const record = await readStoredAuthRecord({ authFilePath });

  if (!record) {
    throw new Error(
      `Jira auth is not configured. Run "jira-markdown auth login" first.`
    );
  }

  const token =
    record.secretStorage === "keychain"
      ? await readTokenFromKeychain()
      : record.token;

  if (!token) {
    throw new Error(
      `Stored Jira auth is incomplete. Run "jira-markdown auth login" again.`
    );
  }

  return {
    apiToken: record.authMode === "basic" ? token : undefined,
    authMode: record.authMode,
    baseUrl: record.baseUrl,
    bearerToken: record.authMode === "bearer" ? token : undefined,
    email: record.email
  };
}
