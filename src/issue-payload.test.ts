import { describe, expect, test } from "./test-helpers.js";
import { adfToMarkdown, collectMediaBlocks, markdownToAdf } from "./adf.js";
import { buildCoreIssuePayload } from "./issue-payload.js";

describe("markdownToAdf", () => {
  test("converts headings, paragraphs, and lists", () => {
    const document = markdownToAdf("# Title\n\nParagraph text\n\n- one\n- two");

    expect(document.version).toBe(1);
    expect(document.content[0]?.type).toBe("heading");
    expect(document.content[1]?.type).toBe("paragraph");
    expect(document.content[2]?.type).toBe("bulletList");
  });

  test("converts ADF back into markdown", () => {
    const markdown = [
      "# Title",
      "",
      "Paragraph with **bold** and [link](https://example.com).",
      "",
      "- one",
      "- two"
    ].join("\n");

    expect(adfToMarkdown(markdownToAdf(markdown))).toContain("# Title");
    expect(adfToMarkdown(markdownToAdf(markdown))).toContain("**bold**");
    expect(adfToMarkdown(markdownToAdf(markdown))).toContain("- one");
  });

  test("converts markdown task lists into Jira task nodes", () => {
    const document = markdownToAdf("- [ ] first\n- [x] second");

    expect(document.content[0]?.type).toBe("taskList");
    expect(typeof document.content[0]?.attrs?.localId).toBe("string");
    expect(document.content[0]?.content?.[0]?.type).toBe("taskItem");
    expect(document.content[0]?.content?.[0]?.attrs?.state).toBe("TODO");
    expect(typeof document.content[0]?.content?.[0]?.attrs?.localId).toBe("string");
    expect(document.content[0]?.content?.[0]?.content?.[0]?.text).toBe("first");
    expect(document.content[0]?.content?.[1]?.attrs?.state).toBe("DONE");
    expect(document.content[0]?.content?.[1]?.content?.[0]?.text).toBe("second");
  });

  test("renders Jira task nodes back into markdown task lists", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { localId: "task-1", state: "TODO" },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first" }]
                }
              ]
            },
            {
              type: "taskItem",
              attrs: { localId: "task-2", state: "DONE" },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second" }]
                }
              ]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toContain("- [ ] first");
    expect(markdown).toContain("- [x] second");
  });

  test("renders Jira task nodes with inline content back into markdown task lists", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { localId: "task-1", state: "DONE" },
              content: [{ type: "text", text: "inline title" }]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toContain("- [x] inline title");
  });

  test("parses nested bullet and ordered lists into nested list nodes", () => {
    const markdown = [
      "- parent",
      "  - child bullet",
      "    1. deep ordered",
      "- sibling"
    ].join("\n");
    const document = markdownToAdf(markdown);

    const rootList = document.content[0];
    const parentItem = rootList?.content?.[0];
    const nestedBulletList = parentItem?.content?.[1];
    const nestedOrderedList = nestedBulletList?.content?.[0]?.content?.[1];

    expect(document.content.length).toBe(1);
    expect(rootList?.type).toBe("bulletList");
    expect(parentItem?.content?.[0]?.content?.[0]?.text).toBe("parent");
    expect(nestedBulletList?.type).toBe("bulletList");
    expect(nestedBulletList?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
      "child bullet"
    );
    expect(nestedOrderedList?.type).toBe("orderedList");
    expect(nestedOrderedList?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
      "deep ordered"
    );
    expect(rootList?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("sibling");
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("parses task lists nested under regular list items", () => {
    const markdown = [
      "- chores",
      "  - [ ] first task",
      "  - [x] second task"
    ].join("\n");
    const document = markdownToAdf(markdown);

    const rootList = document.content[0];
    const nestedTaskList = rootList?.content?.[0]?.content?.[1];

    expect(document.content.length).toBe(1);
    expect(rootList?.type).toBe("bulletList");
    expect(rootList?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("chores");
    expect(nestedTaskList?.type).toBe("taskList");
    expect(typeof nestedTaskList?.attrs?.localId).toBe("string");
    expect(nestedTaskList?.content?.[0]?.type).toBe("taskItem");
    expect(nestedTaskList?.content?.[0]?.attrs?.state).toBe("TODO");
    expect(typeof nestedTaskList?.content?.[0]?.attrs?.localId).toBe("string");
    expect(nestedTaskList?.content?.[0]?.content?.[0]?.text).toBe("first task");
    expect(nestedTaskList?.content?.[1]?.attrs?.state).toBe("DONE");
    expect(nestedTaskList?.content?.[1]?.content?.[0]?.text).toBe("second task");
  });

  test("parses tab-indented nested task items into sibling nested task lists", () => {
    const markdown = [
      "- [x] Some action item",
      "\t- [ ] Some other item",
      "\t- [ ] 2"
    ].join("\n");
    const document = markdownToAdf(markdown);

    const rootTaskList = document.content[0];
    const nestedTaskList = rootTaskList?.content?.[1];

    expect(document.content.length).toBe(1);
    expect(rootTaskList?.type).toBe("taskList");
    expect(rootTaskList?.content?.[0]?.type).toBe("taskItem");
    expect(rootTaskList?.content?.[0]?.attrs?.state).toBe("DONE");
    expect(rootTaskList?.content?.[0]?.content?.[0]?.text).toBe("Some action item");
    expect(nestedTaskList?.type).toBe("taskList");
    expect(nestedTaskList?.content?.[0]?.type).toBe("taskItem");
    expect(nestedTaskList?.content?.[0]?.attrs?.state).toBe("TODO");
    expect(nestedTaskList?.content?.[0]?.content?.[0]?.text).toBe("Some other item");
    expect(nestedTaskList?.content?.[1]?.type).toBe("taskItem");
    expect(nestedTaskList?.content?.[1]?.attrs?.state).toBe("TODO");
    expect(nestedTaskList?.content?.[1]?.content?.[0]?.text).toBe("2");
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("parses continuation paragraphs inside list items", () => {
    const document = markdownToAdf([
      "- first paragraph",
      "",
      "  second paragraph",
      "",
      "- sibling"
    ].join("\n"));

    const rootList = document.content[0];
    const firstItem = rootList?.content?.[0];

    expect(document.content.length).toBe(1);
    expect(rootList?.type).toBe("bulletList");
    expect(firstItem?.content?.[0]?.type).toBe("paragraph");
    expect(firstItem?.content?.[0]?.content?.[0]?.text).toBe("first paragraph");
    expect(firstItem?.content?.[1]?.type).toBe("paragraph");
    expect(firstItem?.content?.[1]?.content?.[0]?.text).toBe("second paragraph");
    expect(rootList?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("sibling");
  });

  test("parses horizontal rules as rule nodes and round-trips them", () => {
    const markdown = [
      "before",
      "",
      "---",
      "",
      "after"
    ].join("\n");
    const document = markdownToAdf(markdown);

    expect(document.content[0]?.type).toBe("paragraph");
    expect(document.content[1]?.type).toBe("rule");
    expect(document.content[2]?.type).toBe("paragraph");
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("converts stable markdown mentions into Jira mention nodes", () => {
    const document = markdownToAdf("Pair with @[Jane Doe](557058:abcd-1234)");
    const paragraph = document.content[0];
    const mentionNode = paragraph?.content?.[1];

    expect(mentionNode?.type).toBe("mention");
    expect(mentionNode?.attrs?.id).toBe("557058:abcd-1234");
    expect(mentionNode?.attrs?.text).toBe("@Jane Doe");
  });

  test("converts lookup markdown mentions into Jira mention nodes when resolved", () => {
    const document = markdownToAdf("Pair with @[jane@example.com]", {
      resolveMention: ({ identifier }) =>
        identifier === "jane@example.com"
          ? {
              accountId: "557058:abcd-1234",
              displayName: "Jane Doe"
            }
          : undefined
    });
    const paragraph = document.content[0];
    const mentionNode = paragraph?.content?.[1];

    expect(mentionNode?.type).toBe("mention");
    expect(mentionNode?.attrs?.id).toBe("557058:abcd-1234");
    expect(mentionNode?.attrs?.text).toBe("@Jane Doe");
  });

  test("renders Jira mention nodes back into stable markdown mention syntax", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Pair with " },
            {
              type: "mention",
              attrs: {
                id: "557058:abcd-1234",
                text: "@Jane Doe"
              }
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toContain("@[Jane Doe](557058:abcd-1234)");
  });

  test("renders Jira mention nodes back into name-only markdown when a resolver is provided", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: "557058:abcd-1234",
                text: "@Jane Doe"
              }
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    }, {
      resolveMention: () => "@[Jane Doe]"
    });

    expect(markdown).toContain("@[Jane Doe]");
    expect(markdown).not.toContain("(557058:abcd-1234)");
  });

  test("parses balanced-paren links without dropping trailing destination text", () => {
    const markdown = "[label](https://example.com/a_(b)/c_(d))";
    const document = markdownToAdf(markdown);
    const linkNode = document.content[0]?.content?.[0];

    expect(document.content[0]?.type).toBe("paragraph");
    expect(document.content[0]?.content?.length).toBe(1);
    expect(linkNode?.type).toBe("text");
    expect(linkNode?.text).toBe("label");
    expect(linkNode?.marks?.[0]?.type).toBe("link");
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe("https://example.com/a_(b)/c_(d)");
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("round-trips angle-bracket destinations with spaces for links and images", () => {
    const markdown = [
      "[Spec draft](<https://example.com/files/spec draft.pdf>)",
      "",
      "![Diagram](<https://example.com/images/diagram 1.png>)"
    ].join("\n");
    const document = markdownToAdf(markdown, {
      resolveImageBlock: ({ href, label }) => ({
        type: "mediaSingle",
        content: [
          {
            type: "media",
            attrs: {
              alt: label,
              type: "external",
              url: href
            }
          }
        ]
      })
    });

    expect(document.content[0]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe(
      "https://example.com/files/spec draft.pdf"
    );
    expect(document.content[1]?.type).toBe("mediaSingle");
    expect(document.content[1]?.content?.[0]?.type).toBe("media");
    expect(document.content[1]?.content?.[0]?.attrs?.url).toBe(
      "https://example.com/images/diagram 1.png"
    );
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("parses angle-bracket http and https autolinks and round-trips them", () => {
    const markdown = "Visit <https://example.com/docs> and <http://example.org/tasks>";
    const document = markdownToAdf(markdown);
    const paragraph = document.content[0];

    expect(paragraph?.type).toBe("paragraph");
    expect(paragraph?.content?.[0]?.text).toBe("Visit ");
    expect(paragraph?.content?.[1]?.text).toBe("https://example.com/docs");
    expect(paragraph?.content?.[1]?.marks?.[0]?.attrs?.href).toBe(
      "https://example.com/docs"
    );
    expect(paragraph?.content?.[2]?.text).toBe(" and ");
    expect(paragraph?.content?.[3]?.text).toBe("http://example.org/tasks");
    expect(paragraph?.content?.[3]?.marks?.[0]?.attrs?.href).toBe(
      "http://example.org/tasks"
    );
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("parses Jira browse autolinks into inline cards and round-trips them", () => {
    const markdown = "<https://bishopsoft.atlassian.net/browse/GRIP-1>";
    const document = markdownToAdf(markdown);
    const paragraph = document.content[0];

    expect(paragraph?.type).toBe("paragraph");
    expect(paragraph?.content?.[0]).toEqual({
      type: "inlineCard",
      attrs: {
        url: "https://bishopsoft.atlassian.net/browse/GRIP-1"
      }
    });
    expect(paragraph?.content?.[1]).toEqual({
      type: "text",
      text: " "
    });
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  test("converts markdown tables into Jira table nodes", () => {
    const document = markdownToAdf([
      "| Name | Status |",
      "| --- | --- |",
      "| API | Done |",
      "| CLI | In Progress |"
    ].join("\n"));

    expect(document.content[0]?.type).toBe("table");
    expect(document.content[0]?.attrs).toEqual({
      isNumberColumnEnabled: false
    });
    expect(document.content[0]?.content?.[0]?.type).toBe("tableRow");
    expect(document.content[0]?.content?.[0]?.content?.[0]?.type).toBe("tableHeader");
    expect(document.content[0]?.content?.[0]?.content?.[0]?.attrs).toEqual({});
    expect(document.content[0]?.content?.[1]?.content?.[0]?.type).toBe("tableCell");
    expect(document.content[0]?.content?.[1]?.content?.[0]?.attrs).toEqual({});
  });

  test("renders Jira table nodes back into markdown tables", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Name" }]
                    }
                  ]
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Status" }]
                    }
                  ]
                }
              ]
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "API" }]
                    }
                  ]
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Done" }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toContain("| Name | Status |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| API | Done |");
  });

  test("parses pipe-less tables and preserves escaped pipes on round-trip", () => {
    const document = markdownToAdf([
      "Name | Status",
      "--- | ---",
      "API\\|CLI | Done"
    ].join("\n"));

    expect(document.content[0]?.type).toBe("table");
    expect(document.content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
      "Name"
    );
    expect(document.content[0]?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
      "API|CLI"
    );
    expect(adfToMarkdown(document)).toBe([
      "| Name | Status |",
      "| --- | --- |",
      "| API\\|CLI | Done |"
    ].join("\n"));
  });

  test("renders nested ADF lists with two-space indentation per level", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }]
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child bullet" }]
                        },
                        {
                          type: "orderedList",
                          content: [
                            {
                              type: "listItem",
                              content: [
                                {
                                  type: "paragraph",
                                  content: [{ type: "text", text: "deep ordered" }]
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "taskList",
                  attrs: { localId: "task-list-1" },
                  content: [
                    {
                      type: "taskItem",
                      attrs: { localId: "task-1", state: "TODO" },
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child task" }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toBe([
      "- parent",
      "  - child bullet",
      "    1. deep ordered",
      "  - [ ] child task"
    ].join("\n"));
  });

  test("renders nested Jira task nodes with tab indentation", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "taskList",
          attrs: { localId: "task-list-1" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "task-1", state: "DONE" },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Some action item" }]
                }
              ]
            },
            {
              type: "taskList",
              attrs: { localId: "task-list-2" },
              content: [
                {
                  type: "taskItem",
                  attrs: { localId: "task-2", state: "TODO" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Some other item" }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toBe([
      "- [x] Some action item",
      "\t- [ ] Some other item"
    ].join("\n"));
  });

  test("renders Jira sibling task items with literal task markers as nested action items", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "taskList",
          attrs: { localId: "task-list-1" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "task-1", state: "DONE" },
              content: [{ type: "text", text: "Some action item" }]
            },
            {
              type: "taskItem",
              attrs: { localId: "task-2", state: "TODO" },
              content: [{ type: "text", text: "- [ ] Some other item" }]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toBe([
      "- [x] Some action item",
      "\t- [ ] Some other item"
    ].join("\n"));
  });

  test("renders attachment links into local markdown links", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "spec.pdf",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.atlassian.net/rest/api/3/attachment/content/10001"
                  }
                }
              ]
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    }, {
      resolveLinkHref: (href) =>
        href.includes("/attachment/content/10001")
          ? { href: ".attachments/ENG-123/spec.pdf", label: "spec.pdf" }
          : undefined
    });

    expect(markdown).toContain("[spec.pdf](.attachments/ENG-123/spec.pdf)");
  });

  test("renders media nodes into local markdown images", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: {
                alt: "diagram.png",
                id: "ignored-media-id"
              }
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    }, {
      resolveMediaNode: () => ({
        href: ".attachments/ENG-123/diagram.png",
        isImage: true,
        label: "diagram.png"
      })
    });

    expect(markdown).toContain("![diagram.png](.attachments/ENG-123/diagram.png)");
  });

  test("renders unresolved media as visible placeholders", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: {
                alt: "spec.pdf"
              }
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    });

    expect(markdown).toContain("[Attachment: spec.pdf]");
  });

  test("renders external media urls into markdown images", () => {
    const markdown = adfToMarkdown({
      content: [
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: {
                alt: "diagram.png",
                type: "external",
                url: "https://example.atlassian.net/rest/api/3/attachment/content/10002"
              }
            }
          ]
        }
      ],
      type: "doc",
      version: 1
    }, {
      resolveMediaNode: () => ({
        href: ".attachments/ENG-123/diagram.png",
        isImage: true,
        label: "diagram.png"
      })
    });

    expect(markdown).toContain("![diagram.png](.attachments/ENG-123/diagram.png)");
  });

  test("collects pulled mediaSingle blocks for round-trip reuse", () => {
    const block = {
      type: "mediaSingle",
      attrs: {
        layout: "center"
      },
      content: [
        {
          type: "media",
          attrs: {
            alt: "diagram.png",
            id: "media-id",
            type: "file"
          }
        }
      ]
    };

    const collected = collectMediaBlocks(
      {
        content: [block],
        type: "doc",
        version: 1
      },
      {
        resolveMediaNode: () => ({
          href: ".attachments/ENG-123/diagram.png",
          isImage: true,
          label: "diagram.png"
        })
      }
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]?.href).toBe(".attachments/ENG-123/diagram.png");
    expect(collected[0]?.block).toEqual(block);
  });

  test("converts local markdown attachment links into Jira urls on push", () => {
    const document = markdownToAdf(
      "See [spec.pdf](.attachments/ENG-123/spec.pdf)",
      {
        resolveLinkHref: ({ href }) =>
          href === ".attachments/ENG-123/spec.pdf"
            ? "https://example.atlassian.net/rest/api/3/attachment/content/10001"
            : undefined
      }
    );

    const paragraph = document.content[0];
    const textNode = paragraph?.content?.[1];

    expect(paragraph?.type).toBe("paragraph");
    expect(textNode?.type).toBe("text");
    expect(textNode?.marks?.[0]?.attrs?.href).toBe(
      "https://example.atlassian.net/rest/api/3/attachment/content/10001"
    );
  });

  test("converts local markdown attachment images into Jira urls on push", () => {
    const document = markdownToAdf(
      "![diagram.png](.attachments/ENG-123/diagram.png)",
      {
        resolveImageBlock: ({ href, label }) =>
          href === ".attachments/ENG-123/diagram.png"
            ? {
                type: "mediaSingle",
                attrs: {
                  layout: "center"
                },
                content: [
                  {
                    type: "media",
                    attrs: {
                      alt: label,
                      id: "pulled-media-id",
                      type: "file"
                    }
                  }
                ]
              }
            : undefined
      }
    );

    const mediaSingle = document.content[0];
    const mediaNode = mediaSingle?.content?.[0];

    expect(mediaSingle?.type).toBe("mediaSingle");
    expect(mediaSingle?.attrs?.layout).toBe("center");
    expect(mediaNode?.type).toBe("media");
    expect(mediaNode?.attrs?.type).toBe("file");
    expect(mediaNode?.attrs?.alt).toBe("diagram.png");
    expect(mediaNode?.attrs?.id).toBe("pulled-media-id");
  });
});

describe("buildCoreIssuePayload", () => {
  test("builds create payloads from frontmatter and markdown body", () => {
    const payload = buildCoreIssuePayload({
      body: "# Hello Jira\n\nShip it.",
      filePath: "/tmp/hello.md",
      frontmatter: {
        issueType: "Task",
        labels: ["docs"],
        project: "ENG",
        status: "In Progress",
        storyPoints: 3
      }
    });

    expect(payload.issueKey).toBeUndefined();
    expect(payload.fields.project).toEqual({ key: "ENG" });
    expect(payload.fields.issuetype).toEqual({ name: "Task" });
    expect(payload.fields.summary).toBe("Hello Jira");
    expect(payload.fields.labels).toEqual(["docs"]);
    expect(payload.fields.status).toBeUndefined();
    expect(payload.extraFrontmatter.storyPoints).toBe(3);
    expect(payload.extraFrontmatter.status).toBeUndefined();
    expect(payload.status).toBe("In Progress");
  });

  test("infers the project from an issues project folder", () => {
    const payload = buildCoreIssuePayload({
      body: "# Folder scoped issue",
      filePath: "/tmp/repo/issues/ops/folder-scoped.md",
      frontmatter: {
        issueType: "Task"
      }
    });

    expect(payload.projectKey).toBe("OPS");
    expect(payload.fields.project).toEqual({ key: "OPS" });
  });

  test("builds update payloads without project and issue type", () => {
    const payload = buildCoreIssuePayload({
      body: "Body",
      filePath: "/tmp/existing.md",
      frontmatter: {
        issue: "ENG-123",
        summary: "Existing issue"
      }
    });

    expect(payload.issueKey).toBe("ENG-123");
    expect(payload.fields.project).toBeUndefined();
    expect(payload.fields.issuetype).toBeUndefined();
    expect(payload.fields.summary).toBe("Existing issue");
  });

  test("keeps issue type metadata for updates without sending issuetype", () => {
    const payload = buildCoreIssuePayload({
      body: "Body",
      filePath: "/tmp/existing.md",
      frontmatter: {
        issue: "ENG-123",
        issueType: "Epic",
        summary: "Existing issue"
      }
    });

    expect(payload.issueKey).toBe("ENG-123");
    expect(payload.issueTypeName).toBe("Epic");
    expect(payload.fields.project).toBeUndefined();
    expect(payload.fields.issuetype).toBeUndefined();
  });

  test("drops raw issuetype fields on updates", () => {
    const payload = buildCoreIssuePayload({
      body: "Body",
      filePath: "/tmp/existing.md",
      frontmatter: {
        fields: {
          issuetype: { name: "Epic" },
          priority: { name: "High" }
        },
        issue: "ENG-123",
        summary: "Existing issue"
      }
    });

    expect(payload.issueKey).toBe("ENG-123");
    expect(payload.fields.issuetype).toBeUndefined();
    expect(payload.fields.priority).toEqual({ name: "High" });
  });

  test("treats a canonical filename without issue frontmatter as a create", () => {
    const payload = buildCoreIssuePayload({
      body: "Body",
      filePath: "/tmp/repo/issues/ENG/ENG-123 - Existing issue.md",
      frontmatter: {
        issueType: "Task",
        summary: "Existing issue"
      }
    });

    expect(payload.issueKey).toBeUndefined();
    expect(payload.fields.project).toEqual({ key: "ENG" });
    expect(payload.fields.issuetype).toEqual({ name: "Task" });
  });
});
