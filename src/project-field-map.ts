import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadStoredAuthConfig } from "./auth-store.js";
import {
  initAppConfig,
  saveGeneratedProjectIssueTypeFieldMap
} from "./config.js";
import { inferResolverForField } from "./field-value.js";
import { JiraClient } from "./jira.js";
import { inferProjectKeyFromFilePath } from "./project-path.js";
import {
  RESERVED_FRONTMATTER_KEYS,
  type AppConfig,
  type FieldMappingConfig,
  type JiraCreateField,
  type JiraField,
  type JiraIssueTypeSummary
} from "./types.js";

interface DiscoverProjectFieldMapOptions {
  allIssueTypes?: boolean;
  boardId?: number;
  configPath?: string;
  issueType?: string;
  project?: string;
  write?: boolean;
}

interface MappingScope {
  issueTypeName?: string | undefined;
  projectKey?: string | undefined;
}

type ScopedFieldMap = Record<string, FieldMappingConfig>;

function normalizeProjectKey(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeLookupKey(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

function toProjectLookupCandidates(projectKey: string): string[] {
  const trimmed = projectKey.trim();
  return [...new Set([trimmed, trimmed.toUpperCase(), trimmed.toLowerCase()])];
}

function findRecordByKey<T>(
  record: Record<string, T>,
  requestedKey: string | undefined
): T | undefined {
  if (!requestedKey?.trim()) {
    return undefined;
  }

  const direct = record[requestedKey];
  if (direct) {
    return direct;
  }

  const normalizedRequested = normalizeLookupKey(requestedKey);
  for (const [key, value] of Object.entries(record)) {
    if (normalizeLookupKey(key) === normalizedRequested) {
      return value;
    }
  }

  return undefined;
}

function toFrontmatterKey(fieldName: string): string {
  const words = fieldName
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "field";
  }

  return words
    .map((word, index) => {
      const normalized = word.toLowerCase();
      if (index === 0) {
        return normalized;
      }

      return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
    })
    .join("");
}

function isCustomField(field: JiraCreateField): boolean {
  return field.fieldId.startsWith("customfield_");
}

function getIssueTypeOverrideMap(
  config: AppConfig,
  scope: MappingScope
): ScopedFieldMap {
  if (!scope.projectKey || !scope.issueTypeName) {
    return {};
  }

  for (const projectCandidate of toProjectLookupCandidates(scope.projectKey)) {
    const issueTypeMaps = config.projectIssueTypeFieldMap[projectCandidate];
    if (!issueTypeMaps) {
      continue;
    }

    const issueTypeMap = findRecordByKey(issueTypeMaps, scope.issueTypeName);
    if (issueTypeMap) {
      return issueTypeMap;
    }
  }

  return {};
}

function getProjectIssueTypeMaps(
  config: AppConfig,
  projectKey: string | undefined
): Record<string, ScopedFieldMap> | undefined {
  if (!projectKey?.trim()) {
    return undefined;
  }

  return findRecordByKey(config.projectIssueTypeFieldMap, projectKey);
}

export function resolveFieldMapping(
  config: AppConfig,
  sourceKey: string,
  scope: MappingScope = {}
): FieldMappingConfig | undefined {
  const issueTypeScoped = getIssueTypeOverrideMap(config, scope);
  return issueTypeScoped[sourceKey];
}

export function inferProjectKeyForMappingScope(input: {
  dir?: string | undefined;
  filePath?: string | undefined;
  frontmatter?: Record<string, unknown>;
  issueKey?: string | undefined;
}): string | undefined {
  const rawProject = input.frontmatter?.project;
  if (typeof rawProject === "string" && rawProject.trim()) {
    return rawProject.trim();
  }

  const projectFromPath = input.filePath
    ? inferProjectKeyFromFilePath(input.filePath, input.dir)
    : undefined;
  if (projectFromPath) {
    return projectFromPath;
  }

  const issueKey = input.issueKey?.trim();
  if (!issueKey) {
    return undefined;
  }

  const match = /^([A-Z][A-Z0-9_]+)-\d+$/i.exec(issueKey);
  return match?.[1]?.toUpperCase();
}

export function inferIssueTypeForMappingScope(input: {
  frontmatter?: Record<string, unknown>;
  issueTypeName?: string | undefined;
}): string | undefined {
  const rawIssueType =
    input.frontmatter?.issueType ?? input.frontmatter?.issuetype;
  if (typeof rawIssueType === "string" && rawIssueType.trim()) {
    return rawIssueType.trim();
  }

  if (input.issueTypeName?.trim()) {
    return input.issueTypeName.trim();
  }

  return undefined;
}

function buildGlobalFieldCatalog(fields: JiraField[]): Map<string, JiraField> {
  return new Map(fields.map((field) => [field.id, field]));
}

export function buildProjectFieldMapTemplate(
  fields: JiraCreateField[],
  globalFields: JiraField[],
  options: { boardId?: number } = {}
): ScopedFieldMap {
  const globalById = buildGlobalFieldCatalog(globalFields);
  const template: ScopedFieldMap = {};

  for (const createField of fields) {
    if (!isCustomField(createField)) {
      continue;
    }

    const field = globalById.get(createField.fieldId) ?? createField;
    const frontmatterKey = toFrontmatterKey(createField.name);

    if (!frontmatterKey || RESERVED_FRONTMATTER_KEYS.has(frontmatterKey)) {
      continue;
    }

    const mapping: FieldMappingConfig = {
      fieldId: createField.fieldId
    };

    const resolver = inferResolverForField(field, options);
    if (resolver !== "passthrough") {
      mapping.resolver = resolver;
    }

    if (
      resolver === "sprintByName" &&
      options.boardId &&
      field.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint"
    ) {
      mapping.boardId = options.boardId;
    }

    template[frontmatterKey] = mapping;
  }

  return Object.fromEntries(
    Object.entries(template).sort(([left], [right]) => left.localeCompare(right))
  );
}

function findIssueTypeByNameOrId(
  issueTypes: JiraIssueTypeSummary[],
  requestedValue: string
): JiraIssueTypeSummary | undefined {
  const normalizedRequested = normalizeLookupKey(requestedValue);
  return issueTypes.find((issueType) => {
    return (
      issueType.id === requestedValue ||
      normalizeLookupKey(issueType.name) === normalizedRequested
    );
  });
}

async function chooseIssueTypeInteractively(
  issueTypes: JiraIssueTypeSummary[]
): Promise<JiraIssueTypeSummary> {
  const rl = createInterface({ input, output });

  try {
    output.write("Available issue types:\n");
    issueTypes.forEach((issueType, index) => {
      output.write(`  ${index + 1}. ${issueType.name} (${issueType.id})\n`);
    });

    const answer = (await rl.question("Choose an issue type by number: ")).trim();
    const selectedIndex = Number(answer);

    if (
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 1 ||
      selectedIndex > issueTypes.length
    ) {
      throw new Error("Invalid issue type selection.");
    }

    const selected = issueTypes[selectedIndex - 1];
    if (!selected) {
      throw new Error("Invalid issue type selection.");
    }

    return selected;
  } finally {
    rl.close();
  }
}

async function resolveProjectKeys(
  jira: JiraClient,
  project?: string
): Promise<string[]> {
  const requestedProject = project?.trim();
  if (requestedProject) {
    return [requestedProject];
  }

  const projects = await jira.listProjects();
  const projectKeys = [...new Set(
    projects
      .map((entry) => entry.key?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .sort((left, right) => left.localeCompare(right))
  )];

  if (projectKeys.length === 0) {
    throw new Error("No Jira projects were returned for field-map discovery.");
  }

  return projectKeys;
}

async function resolveIssueTypes(
  issueTypes: JiraIssueTypeSummary[],
  requestedIssueType?: string,
  allIssueTypes = false
): Promise<JiraIssueTypeSummary[]> {
  if (allIssueTypes) {
    return issueTypes;
  }

  const requested = requestedIssueType?.trim();
  if (requested) {
    const match = findIssueTypeByNameOrId(issueTypes, requested);
    if (!match) {
      throw new Error(
        `Issue type "${requested}" was not found for the selected project.`
      );
    }

    return [match];
  }

  if (issueTypes.length === 1) {
    return [issueTypes[0] as JiraIssueTypeSummary];
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Issue type is required. Pass --issue-type or use --all-issue-types."
    );
  }

  return [await chooseIssueTypeInteractively(issueTypes)];
}

function buildDiscoveryOutput(
  issueTypes: JiraIssueTypeSummary[],
  templatesByIssueTypeName: Record<string, ScopedFieldMap>
): Record<string, ScopedFieldMap> {
  const orderedEntries = issueTypes
    .filter((issueType) => templatesByIssueTypeName[issueType.name])
    .map((issueType) => [issueType.name, templatesByIssueTypeName[issueType.name] as ScopedFieldMap]);

  return Object.fromEntries(orderedEntries);
}

export function mergeDiscoveredProjectFieldMaps(
  config: AppConfig,
  discoveredByProject: Record<string, Record<string, ScopedFieldMap>>
): AppConfig {
  return {
    ...config,
    projectIssueTypeFieldMap: {
      ...config.projectIssueTypeFieldMap,
      ...Object.fromEntries(
        Object.entries(discoveredByProject).map(([projectKey, issueTypeMaps]) => [
          projectKey,
          {
            ...(config.projectIssueTypeFieldMap[projectKey] ?? {}),
            ...issueTypeMaps
          }
        ])
      )
    }
  };
}

export async function discoverMissingProjectIssueTypeFieldMaps(input: {
  config: AppConfig;
  globalFields: JiraField[];
  jira: JiraClient;
  projectKeys: Iterable<string>;
}): Promise<{
  changed: boolean;
  config: AppConfig;
  discoveredByProject: Record<string, Record<string, ScopedFieldMap>>;
}> {
  const discoveredByProject: Record<string, Record<string, ScopedFieldMap>> = {};
  const projectKeys = [...new Set(
    [...input.projectKeys]
      .map((projectKey) => projectKey.trim())
      .filter(Boolean)
      .map((projectKey) => normalizeProjectKey(projectKey))
      .sort((left, right) => left.localeCompare(right))
  )];

  for (const projectKey of projectKeys) {
    const availableIssueTypes = await input.jira.listCreateIssueTypes(projectKey);
    const existingIssueTypeMaps = getProjectIssueTypeMaps(input.config, projectKey) ?? {};
    const missingIssueTypes = availableIssueTypes.filter((issueType) => {
      return findRecordByKey(existingIssueTypeMaps, issueType.name) === undefined;
    });

    if (missingIssueTypes.length === 0) {
      continue;
    }

    const discoveredIssueTypes: Record<string, ScopedFieldMap> = {};
    for (const issueType of missingIssueTypes) {
      const createFields = await input.jira.listCreateFields(projectKey, issueType.id);
      discoveredIssueTypes[issueType.name] = buildProjectFieldMapTemplate(
        createFields,
        input.globalFields
      );
    }

    if (Object.keys(discoveredIssueTypes).length > 0) {
      discoveredByProject[projectKey] = discoveredIssueTypes;
    }
  }

  if (Object.keys(discoveredByProject).length === 0) {
    return {
      changed: false,
      config: input.config,
      discoveredByProject
    };
  }

  return {
    changed: true,
    config: mergeDiscoveredProjectFieldMaps(input.config, discoveredByProject),
    discoveredByProject
  };
}

export async function discoverProjectFieldMap(
  options: DiscoverProjectFieldMapOptions = {}
): Promise<void> {
  const { config, configPath, created } = await initAppConfig({
    configPath: options.configPath
  });
  if (created) {
    output.write(`Initialized starter config at ${configPath}.\n`);
  }
  const jira = new JiraClient(await loadStoredAuthConfig());
  const projectKeys = await resolveProjectKeys(jira, options.project);
  const globalFields = await jira.getFields();
  const discoveredByProject: Record<string, Record<string, ScopedFieldMap>> = {};

  for (const projectKey of projectKeys) {
    const availableIssueTypes = await jira.listCreateIssueTypes(projectKey);
    const selectedIssueTypes = await resolveIssueTypes(
      availableIssueTypes,
      options.issueType,
      options.allIssueTypes
    );
    const templatesByIssueTypeName: Record<string, ScopedFieldMap> = {};

    for (const issueType of selectedIssueTypes) {
      const createFields = await jira.listCreateFields(projectKey, issueType.id);
      const template = buildProjectFieldMapTemplate(
        createFields,
        globalFields,
        options.boardId ? { boardId: options.boardId } : {}
      );

      if (Object.keys(template).length > 0) {
        templatesByIssueTypeName[issueType.name] = template;
      }
    }

    const outputMap = buildDiscoveryOutput(selectedIssueTypes, templatesByIssueTypeName);
    if (Object.keys(outputMap).length === 0) {
      output.write(
        `No custom create fields were found for project ${projectKey} across the selected issue types.\n`
      );
      continue;
    }

    discoveredByProject[projectKey] = outputMap;
  }

  if (Object.keys(discoveredByProject).length === 0) {
    output.write("No custom create fields were found across the selected projects.\n");
    return;
  }

  if (options.write) {
    const nextConfig = mergeDiscoveredProjectFieldMaps(config, discoveredByProject);
    const savedPath = await saveGeneratedProjectIssueTypeFieldMap(
      nextConfig.projectIssueTypeFieldMap,
      nextConfig.dir,
      configPath
    );
    const issueTypeMapCount = Object.values(discoveredByProject).reduce(
      (count, issueTypeMaps) => count + Object.keys(issueTypeMaps).length,
      0
    );
    output.write(
      `Wrote ${issueTypeMapCount} issue-type field maps across ${Object.keys(discoveredByProject).length} project(s) to ${savedPath}.\n`
    );
    if (!options.boardId) {
      const hasSprint = Object.values(discoveredByProject).some((issueTypeMaps) =>
        Object.values(issueTypeMaps).some((map) => Boolean(map.sprint?.fieldId))
      );
      if (hasSprint) {
        output.write(
          "Sprint was configured as sprintById. Re-run with --board <id> if you want sprintByName.\n"
        );
      }
    }
    return;
  }

  const discoveredProjectKeys = Object.keys(discoveredByProject);
  if (discoveredProjectKeys.length === 1) {
    const onlyProjectKey = discoveredProjectKeys[0] as string;
    const projectOutputMap = discoveredByProject[onlyProjectKey] as Record<string, ScopedFieldMap>;
    const projectIssueTypeNames = Object.keys(projectOutputMap);

    if (projectIssueTypeNames.length === 1) {
      const onlyIssueType = projectIssueTypeNames[0] as string;
      output.write(
        `Project issue-type field map for ${onlyProjectKey} (${onlyIssueType}):\n${JSON.stringify(projectOutputMap[onlyIssueType], null, 2)}\n`
      );
      output.write(
        `Copy this into <dir>/.jira-markdown.field-map.json under ${onlyProjectKey}.${JSON.stringify(onlyIssueType)} or re-run with --write.\n`
      );
      return;
    }

    output.write(
      `Project issue-type field map for ${onlyProjectKey}:\n${JSON.stringify(projectOutputMap, null, 2)}\n`
    );
    output.write(
      `Copy this into <dir>/.jira-markdown.field-map.json under ${onlyProjectKey} or re-run with --write.\n`
    );
    return;
  }

  output.write(
    `Project issue-type field maps:\n${JSON.stringify(discoveredByProject, null, 2)}\n`
  );
  output.write("Copy this into <dir>/.jira-markdown.field-map.json or re-run with --write.\n");
}
