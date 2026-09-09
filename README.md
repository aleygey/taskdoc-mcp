# TaskDoc MCP 0.2.0

An Obsidian desktop plugin for task documents, acceptance evidence and resumable AI work. Kanban is the task entry point; Markdown stores the task's structured record. The plugin embeds a Streamable HTTP MCP server and provides human editing commands.

[中文说明](README.zh-CN.md) · [Release notes](RELEASE_NOTES.md) · [Migration](docs/MIGRATION-0.2.0.md) · [Design](docs/DESIGN-0.2.0.md)

## Install

Copy `main.js`, `manifest.json` and `styles.css` from the release ZIP into `<vault>/.obsidian/plugins/taskdoc-mcp/`, then enable the plugin. Requires desktop Obsidian 1.11.4 or later. Preserve existing `data.json`, `runtime.json` and SecretStorage credentials when upgrading.

Register an existing Markdown Kanban board in settings, provide vault-relative paths, then scan its H2 headings. Use the command palette to create a task, edit its scope or checkpoints, accept/cancel it, reconcile its card, or inspect diagnostics. The UI and tool descriptions are in Chinese.

For AI access, enable MCP and copy the generated client configuration. The default endpoint is `http://127.0.0.1:27124/mcp`, authenticated by a Bearer token. Configurable remote binding uses HTTP: restrict access to trusted networks and use TLS/VPN across untrusted networks. [Network setup](docs/NETWORK.zh-CN.md).

## What's different in 0.2.0

- **Checkpoints are optional.** A simple task can be created and completed without artificial subtasks.
- **Acceptance is explicit.** Every task criterion has a stable ID and is pending, verified with evidence references, or waived with a reason. Completion requires full coverage and no unfinished checkpoints. Evidence types follow the task profile.
- **Type, progress and archive are distinct.** Task states are planned, active, blocked, done and cancelled. Archive moves a terminal card to the Kanban Archive section. Boards can organize columns by type or by execution state, with separate task types in state mode.
- **Resumption preserves knowledge.** Effective decisions and constraints from completed checkpoints remain available with provenance and pagination. Relevant edits mark the existing handoff stale while preserving pending checks.
- **Humans can correct the record.** Task and checkpoint editors share the service validation. Changed scope/evidence invalidates affected verification. Card reconciliation requires a fresh preview; document recovery backs up manual text before rebuilding.
- **Writes survive retries and interruption.** A private persistent request ledger prevents duplicate execution across reloads. A write journal supports conditional rollback and stops if later human edits would be overwritten.

The system validates references and declared evidence, not the real-world truth of test results. Waivers must record a reason. Reopening resets task acceptance to pending.

## MCP surface

| Read | Write |
| --- | --- |
| `task_catalog` — boards, types and state mappings | `task_create` — task and linked card |
| `task_query` — document state, card state, diagnostics | `task_update` — scope, evidence, type, state, archive |
| `task_resume` — handoff, acceptance, effective context | `task_card_update` — compatibility move/reopen entry |
| `task_read` — outline, checkpoint, paged block | `task_checkpoint_commit` — replace checkpoint core |
| `task_reconcile` preview | `task_block_put`, `task_handoff`, `task_finalize`, `task_reconcile` apply |

Use `schema_version: 2` for new writes. Version 1 request shapes remain accepted, but completion now requires explicit criterion coverage. Reuse the exact `request_id` and payload for retries. Use the latest document or object revision as required by the tool schema; new checkpoints/blocks use revision zero.

Task evidence references use the evidence ID. Checkpoint evidence references use `checkpoint_id/evidence_id`. `task_finalize` accepts criterion assessments, a final outcome and evidence; `status: "cancelled"` records cancellation separately from `archived: true`.

Always read all `task_resume` context pages until `context_complete` is true. If active details were omitted for size, read each returned checkpoint ID before continuing. Tool output is capped at 64 KiB; large successful mutations return a compact receipt with `committed` and `result_omitted`, so clients must reread instead of repeating a creation.

Query failures are isolated per linked card. Up to 50 diagnostic entries are returned, with total/truncation metadata. Explicit reconciliation compares document and board revisions. Terminal state cannot be inferred solely from a manually checked card.

## Storage and compatibility

New documents use `checkpoint/v2`, stable UUID filenames and readable card aliases. Existing TaskDoc v1 documents are read without rewriting and upgraded on mutation. Previously completed v1 records retain their historical state but are flagged for acceptance review; migration never invents verification. See [migration details](docs/MIGRATION-0.2.0.md).

The persistent request ledger retains the most recent 1,000 full results and older request fingerprints. An old retry returns `IDEMPOTENCY_EXPIRED` rather than executing again. Interrupted transactions block writes until recovered in diagnostics. The journal and ledger live in plugin-private `runtime.json`; don't delete this file to bypass a recovery conflict.

Supports H2 columns, top-level checkbox cards, full vault-relative wikilinks, the Kanban settings footer and the standard Archive section. Code/comment examples are ignored. Short ambiguous links, automatic conversion of arbitrary notes and legacy win-console migration are outside this release. PHA integration remains an interface placeholder.

The journal coordinates one plugin instance, not multiple writers on shared storage. Avoid concurrent writers across computers. User-editable managed text is protected by hashes; recovery preserves the current file in `TaskDoc Backups/*.txt` and does not automatically import arbitrary prose.

## Development

```sh
npm ci
npm run check
npm run package:release
```

Use Node.js 22 or 24. Packaging writes `release/taskdoc-mcp-0.2.0.zip`. Tests cover domain workflows, actual MCP HTTP clients, request persistence, recovery and modal callbacks with an Obsidian UI substitute. Real Obsidian/Kanban visual behavior and cross-platform filesystem semantics still require testing in a separate vault.
