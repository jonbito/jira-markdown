export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AuthMode = "basic" | "bearer";
export type AuthStorageKind = "file" | "keychain";

export interface JiraFieldSchema {
  custom?: string | undefined;
  items?: string | undefined;
  system?: string | undefined;
  type?: string | undefined;
}

export interface JiraField {
  id: string;
  key?: string | undefined;
  name: string;
  schema?: JiraFieldSchema | null | undefined;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  originBoardId?: number;
}

export interface JiraIssueAttachment {
  content?: string | undefined;
  created?: string | undefined;
  filename: string;
  id: string;
  mimeType?: string | undefined;
  size: number;
  thumbnail?: string | undefined;
}

export interface JiraIssueTypeSummary {
  description?: string | undefined;
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraProjectSummary {
  id?: string | undefined;
  key: string;
  name?: string | undefined;
}

export interface JiraIssueTypeReference {
  id?: string | undefined;
  name?: string | undefined;
  subtask?: boolean | undefined;
}

export interface JiraIssueParentReference {
  id?: string | undefined;
  key?: string | undefined;
}

export interface JiraProjectReference {
  id?: string | undefined;
  key?: string | undefined;
  name?: string | undefined;
}

export interface JiraIssueStatusReference {
  id?: string | undefined;
  name?: string | undefined;
}

export interface JiraUserSummary {
  active?: boolean | undefined;
  accountId: string;
  accountType?: string | undefined;
  displayName: string;
  emailAddress?: string | undefined;
}

export interface JiraIssueRecord {
  fields: {
    [fieldId: string]: unknown;
    assignee?: {
      accountId?: string | undefined;
      displayName?: string | undefined;
    } | null;
    attachment?: JiraIssueAttachment[] | undefined;
    description?: unknown;
    issuetype?: JiraIssueTypeReference | null;
    labels?: string[] | undefined;
    parent?: JiraIssueParentReference | null;
    project?: JiraProjectReference | null;
    status?: JiraIssueStatusReference | null;
    summary?: string | undefined;
    updated?: string | undefined;
  };
  id: string;
  key: string;
}

export interface JiraIssueHierarchyRecord {
  fields: {
    issuetype?: JiraIssueTypeReference | null;
    parent?: JiraIssueParentReference | null;
    project?: JiraProjectReference | null;
  };
  id: string;
  key: string;
}

export interface JiraCreateField {
  allowedValues?: JsonValue[] | undefined;
  autoCompleteUrl?: string | undefined;
  fieldId: string;
  hasDefaultValue?: boolean | undefined;
  key?: string | undefined;
  name: string;
  operations?: string[] | undefined;
  required: boolean;
  schema?: JiraFieldSchema | null | undefined;
}

export interface JiraIssueTransition {
  id: string;
  name: string;
  to?: JiraIssueStatusReference | null;
}

export type FieldResolverKind =
  | "passthrough"
  | "string"
  | "number"
  | "stringArray"
  | "optionByName"
  | "optionById"
  | "optionArrayByName"
  | "componentArrayByName"
  | "versionArrayByName"
  | "priorityByName"
  | "userByAccountId"
  | "sprintById"
  | "sprintByName";

export interface FieldMappingConfig {
  boardId?: number | undefined;
  fieldId?: string | undefined;
  fieldName?: string | undefined;
  resolver?: FieldResolverKind | undefined;
  schemaCustom?: string | undefined;
}

export interface UserMapEntry {
  accountId: string;
  aliases?: string[] | undefined;
  email?: string | undefined;
}

export interface AppConfig {
  dir: string;
  projectIssueTypeFieldMap: Record<
    string,
    Record<string, Record<string, FieldMappingConfig>>
  >;
  userMap: Record<string, UserMapEntry>;
  sync: {
    createMissing: boolean;
    updateExisting: boolean;
  };
}

export interface JiraAuthConfig {
  apiToken?: string | undefined;
  authMode: AuthMode;
  baseUrl: string;
  bearerToken?: string | undefined;
  email?: string | undefined;
}

export interface StoredAuthRecord {
  authMode: AuthMode;
  baseUrl: string;
  email?: string | undefined;
  secretStorage: AuthStorageKind;
  token?: string | undefined;
  updatedAt: string;
  version: 1;
}

export interface MarkdownIssueDocument {
  body: string;
  filePath: string;
  frontmatter: Record<string, unknown>;
  raw: string;
}

export type ConflictMode = "fail" | "keep-jira" | "keep-local" | "prompt";
export type ConflictResolution = "abort" | "keep-jira" | "keep-local";

export interface CoreIssuePayload {
  extraFrontmatter: Record<string, unknown>;
  fields: Record<string, unknown>;
  issueKey?: string | undefined;
  issueTypeName?: string | undefined;
  projectKey?: string | undefined;
  status?: string | undefined;
  summary: string;
}

export interface SyncFileResult {
  action:
    | "create"
    | "keep-jira"
    | "keep-local"
    | "pull"
    | "skip"
    | "update";
  filePath: string;
  issueKey?: string | undefined;
  summary: string;
}

export const RESERVED_FRONTMATTER_KEYS = new Set([
  "assignee",
  "description",
  "fields",
  "issue",
  "issueKey",
  "issuetype",
  "issueType",
  "labels",
  "parent",
  "project",
  "status",
  "summary"
]);
