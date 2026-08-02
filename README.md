# TaskDoc MCP

TaskDoc MCP is a desktop-only Obsidian plugin for Kanban-backed task checkpoint documents. It keeps long-term task records concise while preserving large tables, Mermaid diagrams, CP checklists, specifications, and test evidence as addressable rich blocks.

This repository is an early test release extracted from the Taskflow design in [`win-console`](https://github.com/aleygey/win-console).

## Alpha scope

- Register one or more Obsidian Kanban Markdown boards.
- Treat a board as a project, a column as a task type, and a linked card as a task.
- Create a linked task document and card through MCP.
- Commit validated checkpoint cores with fixed rendering.
- Store Markdown tables, Mermaid, domain checklists, configuration, specifications, and evidence as rich blocks up to 24,576 characters by default.
- Write a mutable handoff capsule and resume a task without loading its full history or rich block bodies.
- Move a card between type columns and synchronize its checkbox completion state.
- Run a token-authenticated Streamable HTTP MCP endpoint on `127.0.0.1`.
- Configure boards, MCP, document budgets, and diagnostics from the Obsidian plugin settings page.

PHA synchronization is intentionally unavailable in this alpha. The adapter/outbox boundary and settings placeholder are included, but a real implementation requires the concrete PHA task/comment API, especially comment update semantics.

## Requirements

- Obsidian Desktop 1.11.4 or newer.
- An Obsidian Kanban board represented as Markdown headings and checkbox cards.
- An MCP client that supports remote/Streamable HTTP servers.

Do not enable the old `win-console` Taskflow writer and TaskDoc MCP against the same files at the same time.

## Install from a release

1. Download `taskdoc-mcp-0.1.0-alpha.1.zip` from the GitHub Release.
2. Extract it to `<vault>/.obsidian/plugins/taskdoc-mcp/`.
3. Confirm that the folder directly contains `main.js`, `manifest.json`, and `styles.css`.
4. Enable **TaskDoc MCP** under Obsidian → Settings → Community plugins.
5. Open Obsidian → Settings → TaskDoc MCP.

The plugin is desktop-only because the MCP server uses the Node.js HTTP API.

## Configure a board

1. In **Boards**, choose **Add**.
2. Enter a vault-relative board file such as `Projects/win-console.md`.
3. Enter the task document folder, for example `Tasks/win-console`.
4. Choose **Scan headings**.
5. Give each discovered column a stable type ID and validation profile.

Task semantics are fixed:

| Obsidian object | TaskDoc meaning |
| --- | --- |
| Board | Project |
| H2 column | Task type |
| Linked checkbox card | Task |
| Checked card | Completed task |
| Task document H2 section | Checkpoint/subtask |

## Connect an MCP client

Use **Copy client config** on the settings page. The generated configuration contains the current endpoint and Bearer token. A representative OpenCode configuration is:

```json
{
  "mcp": {
    "taskdoc": {
      "type": "remote",
      "url": "http://127.0.0.1:27124/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer <generated-token>"
      }
    }
  }
}
```

The token is stored in Obsidian SecretStorage. Regenerating it invalidates all copied client configurations.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `task_catalog` | List configured boards and mapped type columns. |
| `task_query` | Query linked tasks by project, type, or state. |
| `task_resume` | Return a bounded resume packet without rich block bodies. |
| `task_read` | Read an outline, checkpoint, or paged rich block. |
| `task_create` | Create a task document and linked Kanban card. |
| `task_card_update` | Move a task to another type column or reopen it as active. |
| `task_checkpoint_commit` | Create or replace a structured checkpoint core. |
| `task_block_put` | Create or replace a typed rich content block. |
| `task_handoff` | Replace the mutable cross-session resume capsule. |
| `task_finalize` | Validate evidence, then complete or archive the task card. |

Writes use stable IDs, expected revisions, and request idempotency keys. Free-form append logs, session todo lists, and arbitrary frontmatter mutation are not exposed. The alpha idempotency-result cache lasts for the current plugin runtime; after reloading Obsidian, reread the task before retrying an uncertain write.

## Development

```powershell
npm.cmd install
npm.cmd run check
```

The production bundle is written to `main.js`.

## Known alpha limitations

- PHA remote synchronization is not active without its API specification.
- Direct manual edits inside plugin-managed checkpoint regions are detected as conflicts; import/reconciliation UI is intentionally conservative.
- The plugin understands the standard Markdown shape of Kanban boards. It does not depend on private runtime APIs from a Kanban fork.
- Automatic conversion of manually typed, unlinked cards is reserved but not enabled in this alpha; create tasks through MCP.
- A crash between rich-block asset and manifest writes can leave a detectable mismatch; there is no automatic mutation-journal repair yet.
- Obsidian must remain running for MCP access.
- The request-id result cache is not yet persisted across an Obsidian/plugin restart.

See [`TASKFLOW_VNEXT_DESIGN.md`](./TASKFLOW_VNEXT_DESIGN.md) for the complete design and acceptance criteria.
