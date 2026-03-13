# jira-markdown

`jira-markdown` is a Bun-based CLI that syncs markdown files with Jira Cloud issues. You can start from local markdown and push it into Jira, start from Jira and pull issues onto disk, or run both directions with `sync`.

This project is Cloud-first. It works best with Jira Cloud authentication and field metadata. Bun `1.3.9` or newer is required at runtime, including when the CLI is installed from npm.

Examples below use the installed `jira-markdown` binary. If you are working from this repository, use the matching Bun scripts instead:

- `jira-markdown auth login` -> `bun run auth login`
- `jira-markdown push` -> `bun run push`
- `jira-markdown pull --project ENG` -> `bun run pull --project ENG`
- `jira-markdown sync --project ENG` -> `bun run sync --project ENG`

Replace `ENG` below with your Jira project key.

## Install

Install the published CLI globally:

```bash
npm install --global @jonbito/jira-markdown
```

The npm package name is scoped, but the installed command remains `jira-markdown`.

For local development in this repository:

```bash
bun install
```

## Quick start

Before you authenticate, gather:

- your Jira Cloud site root, for example `https://your-domain.atlassian.net`
- your Atlassian account email if you use basic auth
- an Atlassian API token for basic auth, or a bearer token if your Jira setup uses bearer auth

Authenticate once:

```bash
jira-markdown auth login
```

Optional: create or edit a config file. `config init` prompts for the issue storage directory and defaults to `issues`.

```bash
jira-markdown config init
jira-markdown config edit
```

`push`, `pull`, and `sync` will auto-create a starter config if it is missing. Relative `dir` values are evaluated from the current working directory for sync runs, so the default `dir: "issues"` writes under `./issues` in the workspace where you run the CLI.

Choose one starting point:

### Start from Jira

Use this when Jira already has the issues and you want local markdown copies first.

```bash
jira-markdown pull --project ENG --dry-run
jira-markdown pull --project ENG
jira-markdown pull --project ENG --jql 'statusCategory != Done'
```

When you do not already have local files under `<dir>/<PROJECT>/`, `pull` needs `--project`.
`--jql` adds an extra filter within each selected project; do not include `ORDER BY`.

### Start from local markdown

Use this when you want to draft a new Jira issue locally first.

Create a markdown file under `<dir>/<PROJECT>/`, for example `issues/ENG/draft-task.md`:

```md
---
issueType: Task
summary: Tighten sync error handling
labels:
  - docs
---

# Tighten sync error handling

- Improve API error logging
- Keep dry-run output readable
```

Minimum frontmatter for a new local issue:

- `issueType` is required.
- The Jira project comes from the folder path `<dir>/<PROJECT>/...`, or from `project:` if the file is elsewhere.
- `parent` is required when `issueType` is a Jira sub-task type.
- `summary` is optional if the first `# Heading` or filename is good enough.
- Omit `issue:` for new issues. Set `issue:` only when the file already maps to an existing Jira issue.

Preview and then create the issue:

```bash
jira-markdown push --dry-run
jira-markdown push
```

`push` writes the created Jira key back into frontmatter by default and renames the file into the canonical path `<dir>/<PROJECT>/<KEY> - <Summary>.md`.

### Ongoing sync

After you have local files and Jira auth configured, use `sync` for the normal workflow:

```bash
jira-markdown sync --project ENG --dry-run
jira-markdown sync --project ENG
jira-markdown sync --project ENG --jql 'assignee = currentUser()'
```

`sync --dry-run` previews both the outgoing Jira writes and the local file writes without changing Jira, local files, or sync history.
`sync --jql` affects only the pull phase after push and uses the same project-scoped filtering as `pull`.

The first non-dry-run `push`, `pull`, or `sync` automatically discovers missing issue-type field maps and learns user labels, then writes them into `<dir>/.jira-markdown.field-map.json` and `<dir>/.jira-markdown.user-map.json`.

## Authentication

Run the interactive login flow once:

```bash
jira-markdown auth login
```

Useful auth commands:

```bash
jira-markdown auth status
jira-markdown auth logout
```

You can also script login non-interactively:

```bash
jira-markdown auth login \
  --base-url https://your-domain.atlassian.net \
  --auth-mode basic \
  --email you@example.com \
  --token your-api-token
```

Authentication storage:

- On macOS, the CLI uses Keychain for the token by default and stores metadata in `~/Library/Application Support/jira-markdown/auth.json`.
- If keychain storage is unavailable, or you force it with `--storage file`, the token is stored in the same auth file with local file permissions.
- The base URL must be the Jira site root. Do not include a path.

## Config

Example `jira-markdown.config.json`:

```json
{
  "dir": "issues",
  "sync": {
    "createMissing": true,
    "updateExisting": true
  }
}
```

By default, the config file lives beside `auth.json` in the local user config directory. `jira-markdown.config.json` holds only hand-edited settings.

`dir` controls where project folders live. Generated field mappings live in `<dir>/.jira-markdown.field-map.json`, generated user labels live in `<dir>/.jira-markdown.user-map.json`, and sync metadata lives in `<dir>/.sync-history`.

Path resolution rules:

- Run the CLI from the workspace you want to sync. Relative `dir` values are evaluated from the current working directory during push, pull, and sync runs.
- The default `dir: "issues"` therefore targets `./issues` in that workspace.

Pull scope comes from `--project` and any local files already present under `<dir>/<PROJECT>/...`.
Use `--jql` to further narrow the pulled issues within each selected project, for example `--jql 'labels = docs'`.

If `EDITOR` is set, you can open the config file directly with:

```bash
jira-markdown config edit
```

Example generated field-map dotfile:

```json
{
  "ENG": {
    "Task": {
      "sprint": {
        "fieldId": "customfield_10020",
        "resolver": "sprintByName",
        "boardId": 12
      },
      "storyPoints": {
        "fieldId": "customfield_10016",
        "resolver": "number"
      },
      "audience": {
        "fieldId": "customfield_10010",
        "resolver": "optionArrayByName"
      }
    }
  }
}
```

Example generated user-map dotfile:

```json
{
  "Alice Example": {
    "accountId": "557058:abcd-1234",
    "aliases": ["alice@example.com"]
  }
}
```

If you want sprint-by-name mapping instead of sprint ids, inspect the board sprints and then edit `<dir>/.jira-markdown.field-map.json` to add a `boardId` on the generated sprint field entry.

You can inspect board sprints with:

```bash
jira-markdown sprints --board 12 --state active,future
```

## Conflict resolution

`jira-markdown` does not auto-merge concurrent local and Jira edits. When both the local markdown issue and the Jira issue changed since the last successful sync baseline, the CLI requires a resolution choice:

- `--on-conflict prompt` asks which side to keep for each conflicted issue when the command is running in a TTY.
- `--on-conflict keep-local` keeps the local markdown version and immediately updates Jira to match it.
- `--on-conflict keep-jira` keeps the Jira version and immediately rewrites the local markdown file to match it.
- `--on-conflict fail` aborts on the first conflict.

If you do not pass `--on-conflict`, the CLI defaults to `prompt` in an interactive terminal and `fail` otherwise.

The choice applies to the whole issue state, including attachments. `sync --dry-run`, `push --dry-run`, and `pull --dry-run` follow the same conflict mode but only report the action they would take.

## Attachments

Issue attachments live beside the markdown under the project folder. With the default `dir: "issues"` that looks like:

```text
issues/ENG/ENG-123 - Improve sync behavior.md
issues/ENG/.attachments/ENG-123/diagram.png
issues/ENG/.attachments/ENG-123/spec.pdf
```

For new local issues that do not have a Jira key yet, stage attachments under:

```text
issues/ENG/.attachments/_drafts/<markdown-file-name>/
```

When `push` creates the Jira issue, the CLI moves that draft attachment folder into the stable issue-key directory and uploads the files.

Attachment behavior:

- `push` uploads new attachments and replaces attachments that were previously synced by this CLI when the local file content changes.
- `push` rewrites local attachment markdown links like `[spec.pdf](.attachments/ENG-123/spec.pdf)` and image references like `![diagram.png](.attachments/ENG-123/diagram.png)` into Jira attachment URLs in the issue description.
- `pull` downloads Jira attachments into the canonical issue attachment folder.
- `pull` rewrites Jira description attachment references into local markdown links like `[spec.pdf](.attachments/ENG-123/spec.pdf)` or image embeds like `![diagram.png](.attachments/ENG-123/diagram.png)`.
- The tool does not prune deleted attachments on either side.
- If Jira already has an attachment with the same filename that is not tracked by `jira-markdown`, `push` stops and tells you to `pull` first or rename the local file.

## Minimum Jira permissions

The list below uses the Jira Cloud REST permission names Atlassian uses in its API docs. For the current `jira-markdown` feature set, the minimum access for `push`, `pull`, and `sync` is:

- Jira product access on the site.
- `Browse Projects` for every project the CLI will read or write.
- `Create Issues` if you want local markdown without an `issue:` key to create new Jira issues.
- `Edit Issues` if you want to update existing Jira issues from markdown.

Add these only when you use the matching feature:

- `Create attachments` to upload attachments during `push`.
- `Delete own attachments` or `Delete all attachments` if `push` needs to replace an attachment that was previously synced by this CLI.
- `Assign Issues` if you set `assignee:` in frontmatter. The target user must also be assignable in that project.
- `Transition Issues` if you set `status:` in frontmatter and want `push` to move the issue through the workflow.
- `Schedule Issues` if you write the sprint field. If you use `sprintByName` mappings or `jira-markdown sprints --board <id>`, the account also needs access to that Jira board.
- `Browse users and groups` if you want site-wide user discovery by display name or email for assignees or `@mentions`. Issue-scoped assignable-user checks can work with `Assign Issues` alone.

Notes:

- `pull` and `sync` can only read issues and attachments that the account can already see, including any Jira issue-level security restrictions.
- `push` and `pull` call Jira field metadata endpoints to validate fields and generate mappings, but they do not require Jira admin or project admin permissions.

## Markdown shape

Pulled issues land in canonical paths like `<dir>/ENG/ENG-123 - Tighten sync error handling.md`.

Example issue file:

```md
---
issue: ENG-123
issueType: Task
summary: Tighten sync error handling
status: In Progress
labels:
  - automation
  - docs
sprint: Sprint 42
storyPoints: 3
---

# Tighten sync error handling

- Improve API error logging
- Keep dry-run output readable
```

Reserved top-level frontmatter keys:

- `issue` or `issueKey`
- `project`
- `issueType` or `issuetype`
- `summary`
- `description`
- `labels`
- `assignee`
- `parent`
- `status`
- `fields`

Everything else is treated as candidate Jira field input and resolved through `<dir>/.jira-markdown.field-map.json`, direct field ids, or exact Jira field-name matches.

Common Jira field shapes supported at the top level:

- `status: In Progress`
- `priority: High`
- `components: ["API", "UI"]`
- `versions: ["2026.03"]`
- `fixVersions: ["2026.03"]`
- mapped single-option custom fields as a string, for example `customerTier: Gold`
- mapped multi-select custom fields as a string array, for example `audience: ["Customer", "Internal"]`

For metadata-backed option, component, version, and priority fields, `push` resolves the human-friendly names through Jira create/edit metadata and sends the corresponding Jira ids. `pull` writes those values back into top-level frontmatter using the mapped key for custom fields and the canonical field name for common system fields.

When a file uses `sprint: Sprint 42`, the `sprintByName` resolver looks up the sprint on the configured board and sends the numeric sprint id Jira expects.

`parent` follows Jira Cloud's modern hierarchy model:

- For sub-task issue types, `parent` is required on create and must resolve to an issue in the same project.
- For non-subtask issue types, `parent` is passed through when Jira exposes the modern parent field for that create or edit operation.
- `jira-markdown` does not support legacy `Epic Link` or `Parent Link` fields.

`fields` is the escape hatch for raw Jira payloads:

```yaml
---
summary: Create from raw fields
fields:
  customfield_12345:
    value: Important
---
```

## Commands

- `jira-markdown auth login`
- `jira-markdown auth status`
- `jira-markdown auth logout`
- `jira-markdown config init`
- `jira-markdown config edit`
- `jira-markdown inspect adf GRIP-2`
- `jira-markdown push`
- `jira-markdown push --dry-run`
- `jira-markdown pull --project ENG`
- `jira-markdown pull --project ENG --dry-run`
- `jira-markdown sync --project ENG`
- `jira-markdown sync --project ENG --dry-run`
- `jira-markdown sprints --board 12 --state active,future`

## Resources

Official Atlassian references for writing `--jql` filters:

- Use advanced search with JQL: https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/
- JQL fields reference: https://support.atlassian.com/jira-service-management-cloud/docs/jql-fields/
- JQL operators reference: https://support.atlassian.com/jira-service-management-cloud/docs/jql-operators/
- Retrieve child and linked work items of an epic in Jira Cloud: https://support.atlassian.com/jira/kb/retrieve-all-child-and-linked-work-items-of-an-epic-in-jira-cloud/

## Release

GitHub Actions publishes to npm when a tag matching `v<package.json version>` is pushed. Before using the publish workflow, add an `NPM_TOKEN` repository secret with publish access to the target package.

Example release flow:

```bash
npm version patch
git push origin --follow-tags
```

## Notes

- The CLI stores per-file, per-issue, and per-attachment sync metadata in `<dir>/.sync-history` so unchanged markdown, Jira issues, and attachments can be skipped on later runs.
- `pull` writes Jira issues into `<dir>/<PROJECT>/<KEY> - <Summary>.md`.
- `push` renames local files into that same canonical shape after create or update.
- `sync` is a convenience wrapper that runs `push` and then `pull`.
- The markdown-to-ADF adapter handles headings, paragraphs, lists, task lists, tables, blockquotes, links, mentions, bold, italic, and inline code. If your content needs panels or richer Atlassian-specific nodes, extend [src/adf.ts](/Users/arch/src/jira-markdown/src/adf.ts).
- Mention syntax:
  `@[alice@example.com]` does a Jira user lookup during `push`.
  `@[Alice Example]` uses `<dir>/.jira-markdown.user-map.json` first and then Jira search during `push`, and is what `pull` writes back when a display name is available.
  `@[Alice Example](557058:abcd-1234)` remains supported as the explicit stable form.
- `<dir>/.jira-markdown.user-map.json` is generated automatically during successful `push`, `pull`, and `sync` runs so pulled `assignee` values and mentions can use real names instead of raw account IDs.
- Newly created issues are written back into frontmatter by default through the `issue` field.
