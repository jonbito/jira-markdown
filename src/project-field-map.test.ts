import { describe, expect, test } from "./test-helpers.js";
import {
  buildProjectFieldMapTemplate,
  discoverMissingProjectIssueTypeFieldMaps,
  inferIssueTypeForMappingScope,
  inferProjectKeyForMappingScope,
  mergeDiscoveredProjectFieldMaps,
  resolveFieldMapping
} from "./project-field-map.js";
import { type AppConfig, type JiraCreateField, type JiraField } from "./types.js";

const baseConfig: AppConfig = {
  ai: {},
  dir: "issues",
  projectIssueTypeFieldMap: {
    ENG: {
      Task: {
        storyPoints: {
          fieldId: "customfield_10016",
          resolver: "number"
        }
      }
    },
    OPS: {
      Bug: {
        storyPoints: {
          fieldId: "customfield_30016",
          resolver: "number"
        }
      }
    }
  },
  userMap: {},
  sync: {
    createMissing: true,
    updateExisting: true
  }
};

describe("resolveFieldMapping", () => {
  test("uses issue-type-specific mappings for the current project and issue type", () => {
    expect(
      resolveFieldMapping(baseConfig, "storyPoints", {
        issueTypeName: "Bug",
        projectKey: "OPS"
      })
    ).toEqual({
      fieldId: "customfield_30016",
      resolver: "number"
    });

    expect(resolveFieldMapping(baseConfig, "storyPoints", {
      issueTypeName: "Task",
      projectKey: "ENG"
    })).toEqual({
      fieldId: "customfield_10016",
      resolver: "number"
    });

    expect(resolveFieldMapping(baseConfig, "storyPoints", { projectKey: "OPS" })).toBeUndefined();
  });
});

describe("inferProjectKeyForMappingScope", () => {
  test("prefers frontmatter project, then folder path, then issue key prefix", () => {
    expect(
      inferProjectKeyForMappingScope({
        filePath: "/tmp/repo/issues/ops/folder-scoped.md",
        frontmatter: { project: "OPS" },
        issueKey: "ABC-123"
      })
    ).toBe("OPS");

    expect(
      inferProjectKeyForMappingScope({
        filePath: "/tmp/repo/issues/ops/folder-scoped.md",
        frontmatter: {},
        issueKey: "ABC-123"
      })
    ).toBe("OPS");

    expect(
      inferProjectKeyForMappingScope({
        frontmatter: {},
        issueKey: "ABC-123"
      })
    ).toBe("ABC");
  });
});

describe("inferIssueTypeForMappingScope", () => {
  test("prefers frontmatter issue type, then explicit value", () => {
    expect(
      inferIssueTypeForMappingScope({
        frontmatter: { issueType: "Bug" },
        issueTypeName: "Story"
      })
    ).toBe("Bug");

    expect(
      inferIssueTypeForMappingScope({
        frontmatter: {},
        issueTypeName: "Story"
      })
    ).toBe("Story");
  });
});

describe("buildProjectFieldMapTemplate", () => {
  test("builds camelCase custom field mappings from create metadata", () => {
    const createFields: JiraCreateField[] = [
      {
        fieldId: "customfield_10016",
        name: "Story Points",
        required: false
      },
      {
        fieldId: "customfield_10020",
        name: "Sprint",
        required: false
      },
      {
        fieldId: "customfield_10030",
        name: "Audience",
        required: false
      },
      {
        fieldId: "summary",
        name: "Summary",
        required: true
      }
    ];

    const globalFields: JiraField[] = [
      {
        id: "customfield_10016",
        name: "Story Points",
        schema: { type: "number" }
      },
      {
        id: "customfield_10020",
        name: "Sprint",
        schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint", type: "array" }
      },
      {
        id: "customfield_10030",
        name: "Audience",
        schema: { items: "option", type: "array" }
      }
    ];

    expect(
      buildProjectFieldMapTemplate(createFields, globalFields, { boardId: 12 })
    ).toEqual({
      audience: {
        fieldId: "customfield_10030",
        resolver: "optionArrayByName"
      },
      sprint: {
        boardId: 12,
        fieldId: "customfield_10020",
        resolver: "sprintByName"
      },
      storyPoints: {
        fieldId: "customfield_10016",
        resolver: "number"
      }
    });
  });
});

describe("mergeDiscoveredProjectFieldMaps", () => {
  test("merges discovered issue-type maps across multiple projects", () => {
    const merged = mergeDiscoveredProjectFieldMaps(baseConfig, {
      ENG: {
        Task: {
          sprint: {
            fieldId: "customfield_40020",
            resolver: "sprintById"
          }
        }
      },
      OPS: {
        Story: {
          epicLink: {
            fieldId: "customfield_50014",
            resolver: "string"
          }
        }
      }
    });

    expect(merged.projectIssueTypeFieldMap.ENG?.Task?.sprint).toEqual({
      fieldId: "customfield_40020",
      resolver: "sprintById"
    });
    expect(merged.projectIssueTypeFieldMap.OPS?.Bug?.storyPoints).toEqual({
      fieldId: "customfield_30016",
      resolver: "number"
    });
    expect(merged.projectIssueTypeFieldMap.OPS?.Story?.epicLink).toEqual({
      fieldId: "customfield_50014",
      resolver: "string"
    });
  });
});

describe("discoverMissingProjectIssueTypeFieldMaps", () => {
  test("discovers only missing issue types and caches empty maps", async () => {
    const jira = {
      async listCreateFields(projectIdOrKey: string, issueTypeId: string) {
        expect(projectIdOrKey).toBe("ENG");
        if (issueTypeId === "20001") {
          return [
            {
              fieldId: "summary",
              name: "Summary",
              required: true
            }
          ];
        }

        throw new Error(`Unexpected issue type id ${issueTypeId}`);
      },
      async listCreateIssueTypes(projectIdOrKey: string) {
        expect(projectIdOrKey).toBe("ENG");
        return [
          {
            id: "10001",
            name: "Task",
            subtask: false
          },
          {
            id: "20001",
            name: "Bug",
            subtask: false
          }
        ];
      }
    };

    const result = await discoverMissingProjectIssueTypeFieldMaps({
      config: baseConfig,
      globalFields: [
        {
          id: "customfield_10016",
          name: "Story Points",
          schema: { type: "number" }
        }
      ],
      jira: jira as never,
      projectKeys: ["ENG"]
    });

    expect(result.changed).toBe(true);
    expect(result.discoveredByProject).toEqual({
      ENG: {
        Bug: {}
      }
    });
    expect(result.config.projectIssueTypeFieldMap.ENG?.Task?.storyPoints).toEqual({
      fieldId: "customfield_10016",
      resolver: "number"
    });
    expect(result.config.projectIssueTypeFieldMap.ENG?.Bug).toEqual({});
  });
});
