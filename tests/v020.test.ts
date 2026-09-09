import assert from "node:assert/strict";
import test from "node:test";
import { TaskService } from "../src/service.js";
import { MemoryVault } from "../src/testing/memoryVault.js";
import {
  MemoryRuntimeStore,
  MutationStore,
  type RuntimeState,
} from "../src/persistence.js";
import {
  DocumentCodec,
  renderRichBlock,
  validateRichBlock,
} from "../src/core/index.js";
import {
  parseBoard,
  createLinkedCard,
  updateLinkedCard,
} from "../src/kanban/index.js";
import {
  taskCreateInputSchema,
  taskUpdateInputSchema,
} from "../src/mcp/schemas.js";
import {
  VaultIoError,
  type BoardConfig,
  type CheckpointCore,
  type TaskDocument,
} from "../src/types.js";
import { newId } from "../src/util/id.js";

const board: BoardConfig = {
  id: "board-test",
  name: "Project",
  projectId: "project",
  file: "Boards/project.md",
  tasksFolder: "Tasks/project",
  autoConvertCards: false,
  columns: [
    { id: "bug", heading: "Bug", typeId: "bug", profile: "other" },
    { id: "feature", heading: "Feature", typeId: "feature", profile: "other" },
  ],
};
const footer =
  '%% kanban:settings\n```json\n{"kanban-plugin":"board"}\n```\n%%\n';
const source =
  "---\nkanban-plugin: board\n---\n\n## Bug\n\n## Feature\n\n" + footer;
const code = (expected: string) => (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === expected;
const setup = (
  vault = new MemoryVault({ [board.file]: source }),
  persistence = new MemoryRuntimeStore(),
) => ({
  vault,
  persistence,
  service: new TaskService(vault, [board], { persistence }),
});
const create = (service: TaskService, title = "Example task") =>
  service.create(
    taskCreateInputSchema.parse({
      schema_version: 2,
      request_id: newId(),
      board_id: board.id,
      column_id: "bug",
      title,
      objective: "Deliver a verified result",
      acceptance: ["Windows works", "Linux works"],
    }),
  );
const cpCore = () => ({
  title: "Independent result",
  kind: "operation" as const,
  status: "active" as const,
  objective: {
    statement: "Verify a result",
    acceptance: [
      {
        id: "CP-AC",
        statement: "The check succeeds",
        status: "pending" as const,
      },
    ],
  },
});

test("real Kanban footer and archive survive create, move, archive and unarchive", () => {
  const initial = source.replace(
    footer,
    "***\n\n## Archive\n\n- [x] [[Tasks/project/old|Old]]\n\n" + footer,
  );
  const created = createLinkedCard(initial, board, {
    columnId: "feature",
    taskPath: "Tasks/project/new.md",
    title: "New [API] task",
  });
  assert.ok(created.indexOf("Tasks/project/new") < created.indexOf("***"));
  assert.deepEqual(
    parseBoard(created, board).columns.map((c) => c.heading),
    ["Bug", "Feature"],
  );
  assert.equal(parseBoard(created, board).archive?.cards.length, 1);
  const moved = updateLinkedCard(created, board, {
    taskPath: "Tasks/project/new.md",
    columnId: "bug",
  });
  assert.equal(
    parseBoard(moved, board).columns[0]?.cards[0]?.link?.alias,
    "New [API] task",
  );
  const archived = updateLinkedCard(moved, board, {
    taskPath: "Tasks/project/new.md",
    archived: true,
    checked: true,
  });
  assert.equal(parseBoard(archived, board).archive?.cards.length, 2);
  const restored = updateLinkedCard(archived, board, {
    taskPath: "Tasks/project/new.md",
    archived: false,
    columnId: "feature",
  });
  assert.equal(parseBoard(restored, board).columns[1]?.cards.length, 1);
  assert.ok(restored.endsWith(footer));
});

test("allowed titles round-trip and new documents use stable filenames", async () => {
  const { service, vault } = setup();
  for (const title of [
    "修复 [API] 错误",
    "修复 C# 编译错误",
    "A & B | integration",
  ]) {
    const created = await create(service, title);
    assert.equal(
      created.task.path,
      `${board.tasksFolder}/${created.task.taskId}.md`,
    );
    assert.equal(
      (await service.query({ query: title, limit: 20 })).tasks[0]?.title,
      title,
    );
    await service.cardUpdate({
      schema_version: 2,
      request_id: newId(),
      task_id: created.task.taskId,
      expected_revision: 1,
      column_id: "feature",
    });
  }
  assert.ok((await vault.read(board.file)).endsWith(footer));
});

test("bad and unmanaged cards are reported without hiding healthy tasks", async () => {
  const { service, vault } = setup();
  const task = await create(service);
  await vault.create("Tasks/project/plain.md", "# Ordinary note\n");
  await vault.write(
    board.file,
    (await vault.read(board.file)).replace(
      "## Bug",
      "## Bug\n\n- [ ] [[Tasks/project/missing|Missing]]\n- [ ] [[Tasks/project/plain|Plain]]",
    ),
  );
  const result = await service.query({ limit: 1 });
  assert.equal(result.tasks[0]?.task_id, task.task.taskId);
  assert.equal(result.diagnostics?.length, 2);
});

test("card changes are explicit conflicts, reconciliation requires a fresh preview", async () => {
  const { service, vault } = setup();
  const task = (await create(service)).task;
  await vault.write(
    board.file,
    updateLinkedCard(await vault.read(board.file), board, {
      taskPath: task.path,
      columnId: "feature",
      checked: true,
    }),
  );
  const result = await service.query({ column_id: "feature", limit: 20 });
  assert.equal(result.tasks[0]?.state, "active");
  assert.equal(result.tasks[0]?.card?.checked, true);
  assert.ok(result.diagnostics?.some((d) => d.code === "CARD_CONFLICT"));
  const adoption = await service.reconcile({
    task_id: task.taskId,
    mode: "preview",
    direction: "board_to_document",
  });
  assert.equal(adoption.can_apply, false);
  const plan = await service.reconcile({
    task_id: task.taskId,
    mode: "preview",
    direction: "document_to_board",
  });
  await vault.write(board.file, (await vault.read(board.file)) + "\n");
  await assert.rejects(
    () =>
      service.reconcile({
        task_id: task.taskId,
        mode: "apply",
        direction: "document_to_board",
        request_id: newId(),
        expected_revision: plan.document_revision,
        expected_board_revision: plan.board_revision,
      }),
    code("VERSION_CONFLICT"),
  );
  const fresh = await service.reconcile({
    task_id: task.taskId,
    mode: "preview",
    direction: "document_to_board",
  });
  await service.reconcile({
    task_id: task.taskId,
    mode: "apply",
    direction: "document_to_board",
    request_id: newId(),
    expected_revision: fresh.document_revision,
    expected_board_revision: fresh.board_revision,
  });
  assert.deepEqual((await service.query({ limit: 20 })).diagnostics, []);
});

test("simple tasks finish only after every criterion is covered, without checkpoints", async () => {
  const { service } = setup();
  const task = (await create(service)).task;
  const finish = {
    schema_version: 2 as const,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    status: "done" as const,
    final_outcome: "Both environments work",
    evidence: [
      {
        id: "E-test",
        type: "test" as const,
        statement: "Both environments passed the smoke test",
        ref: "smoke.log",
      },
    ],
    remaining: [],
  };
  await assert.rejects(
    () => service.finalize(finish),
    code("QUALITY_REJECTED"),
  );
  await assert.rejects(
    () =>
      service.finalize({
        ...finish,
        request_id: newId(),
        acceptance: [
          { id: "AC-1", status: "verified", evidence_refs: ["E-test"] },
        ],
      }),
    code("QUALITY_REJECTED"),
  );
  await assert.rejects(
    () =>
      service.finalize({
        ...finish,
        request_id: newId(),
        acceptance: [
          { id: "AC-1", status: "verified", evidence_refs: ["missing"] },
          { id: "AC-2", status: "waived" },
        ],
      }),
    code("QUALITY_REJECTED"),
  );
  const done = await service.finalize({
    ...finish,
    request_id: newId(),
    acceptance: [
      { id: "AC-1", status: "verified", evidence_refs: ["E-test"] },
      { id: "AC-2", status: "verified", evidence_refs: ["E-test"] },
    ],
  });
  assert.equal(done.task.state, "done");
  const read = await service.read({
    task_id: task.taskId,
    view: "outline",
    checkpoint_limit: 20,
    max_chars: 4096,
  });
  assert.equal(read.task?.checkpoints.length, 0);
});

test("scope and evidence amendments reset affected verification and preserve the task identity", async () => {
  const { service } = setup();
  const task = (await create(service)).task;
  const verified = await service.update(
    taskUpdateInputSchema.parse({
      schema_version: 2,
      request_id: newId(),
      task_id: task.taskId,
      expected_revision: 1,
      reason: "Record verified checks",
      evidence: [{ id: "E", type: "observation", statement: "Windows passed" }],
      assessments: [{ id: "AC-1", status: "verified", evidence_refs: ["E"] }],
    }),
  );
  const changed = await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: verified.document_revision,
    reason: "Expand supported scope",
    title: "New title",
    acceptance: [
      { id: "AC-1", statement: "Windows and ARM work" },
      { id: "AC-2", statement: "Linux works" },
    ],
  });
  assert.equal(changed.task.path, task.path);
  assert.equal(changed.task.acceptanceItems?.[0]?.status, "pending");
  assert.equal(
    changed.task.amendments?.at(-1)?.reason,
    "Expand supported scope",
  );
});

test("task handoff needs no checkpoint and stale work state is retained", async () => {
  const { service } = setup();
  const task = (await create(service)).task;
  const handoff = await service.handoff({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    capsule: {
      based_on_revision: 1,
      next_action: "Run the pending check",
      pending_checks: ["Configuration changed but restart is unverified"],
      blockers: [],
      open_questions: ["Does the Linux service require a restart?"],
      working_artifacts: [],
    },
  });
  await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: handoff.document_revision,
    reason: "Clarify target",
    objective: "Verify both target environments",
  });
  const resumed = await service.resume({
    task_id: task.taskId,
    completed_limit: 0,
  });
  assert.equal(resumed.handoff_status, "stale");
  assert.equal(resumed.capsule?.pendingChecks?.length, 1);
});

test("completed decisions and constraints remain in paged resume context", async () => {
  const { service } = setup();
  const task = (await create(service)).task;
  await service.checkpointCommit({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 0,
    trigger: "decision_finalized",
    core: {
      ...cpCore(),
      kind: "decision",
      status: "done",
      objective: {
        statement: "Choose the storage boundary",
        acceptance: [
          {
            id: "CP-AC",
            statement: "The boundary is verified",
            status: "verified",
            evidence_refs: ["E"],
          },
        ],
      },
      judgment: {
        decisions: ["Use Vault events", "Keep network data separate"],
        constraints: [
          {
            rejected_option: "Polling",
            verified_reason: "Polling repeated full reads",
            scope: "Task indexing",
            impact: "Use incremental events",
            evidence_refs: ["E"],
          },
        ],
      },
      outcome: {
        summary: "Storage boundary selected",
        evidence: [
          {
            id: "E",
            type: "test",
            statement: "Read counting verified the overhead",
          },
        ],
      },
    },
  });
  const first = await service.resume({
    task_id: task.taskId,
    completed_limit: 0,
    context_limit: 1,
  });
  assert.equal(first.context?.[0]?.kind, "constraint");
  assert.equal(first.context_complete, false);
  const second = await service.resume({
    task_id: task.taskId,
    completed_limit: 0,
    context_limit: 10,
    context_cursor: first.context_next_cursor,
  });
  assert.equal(second.context?.length, 2);
  assert.equal(second.context_complete, true);
});

test("cancel, archive and reopen are separate and preserve existing task work", async () => {
  const { service, vault } = setup();
  const task = (await create(service)).task;
  const cp = await service.checkpointCommit({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 0,
    trigger: "subtask_started",
    core: cpCore(),
  });
  const cancelled = await service.finalize({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: cp.document_revision,
    status: "cancelled",
    final_outcome: "Scope was withdrawn; retain existing records",
    evidence: [],
    remaining: [],
  });
  assert.equal(cancelled.task.archived, false);
  const archived = await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: cancelled.document_revision,
    reason: "Hide stopped work",
    archived: true,
  });
  assert.equal(archived.task.state, "cancelled");
  assert.equal(
    parseBoard(await vault.read(board.file), board).archive?.cards.length,
    1,
  );
  assert.equal(
    (await service.query({ archived: true, limit: 20 })).tasks.length,
    1,
  );
  const reopened = await service.cardUpdate({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: archived.document_revision,
    state: "active",
  });
  assert.equal(reopened.task.state, "active");
  assert.equal(reopened.task.archived, false);
  assert.equal(
    parseBoard(await vault.read(board.file), board).columns[0]?.cards.length,
    1,
  );
});

test("state columns move with progress while task types remain independent", async () => {
  const stateBoard: BoardConfig = {
    ...board,
    columnMode: "state",
    taskTypes: [{ id: "bug", name: "Bug", profile: "other" }],
    columns: [
      {
        id: "todo",
        heading: "Todo",
        typeId: "unused",
        profile: "other",
        state: "planned",
      },
      {
        id: "doing",
        heading: "Doing",
        typeId: "unused",
        profile: "other",
        state: "active",
      },
      {
        id: "done",
        heading: "Done",
        typeId: "unused",
        profile: "other",
        state: "done",
      },
    ],
  };
  const vault = new MemoryVault({
    [board.file]: "## Todo\n\n## Doing\n\n## Done\n\n" + footer,
  });
  const service = new TaskService(vault, [stateBoard]);
  assert.equal(
    (await service.catalog({})).boards[0]?.columns[0]?.state,
    "planned",
  );
  const task = (
    await service.create({
      schema_version: 2,
      request_id: newId(),
      board_id: board.id,
      column_id: "todo",
      title: "State board task",
      objective: "Verify state mapping",
      acceptance: ["State mapping works"],
      type_id: "bug",
    })
  ).task;
  assert.equal(task.state, "planned");
  const active = await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    reason: "Begin work",
    state: "active",
  });
  assert.equal(active.task.columnId, "doing");
  assert.equal(active.task.typeId, "bug");
  await assert.rejects(
    () =>
      service.cardUpdate({
        schema_version: 2,
        request_id: newId(),
        task_id: task.taskId,
        expected_revision: active.document_revision,
        column_id: "done",
      }),
    code("QUALITY_REJECTED"),
  );
});

test("task index skips assets, performs single-file lookups, tracks rename and preserves EBUSY", async () => {
  class CountingVault extends MemoryVault {
    reads: string[] = [];
    busy = "";
    override async read(path: string) {
      this.reads.push(path);
      if (path === this.busy)
        throw new VaultIoError(
          "read",
          path,
          Object.assign(new Error("busy"), { code: "EBUSY" }),
        );
      return super.read(path);
    }
  }
  const vault = new CountingVault({ [board.file]: source });
  const { service } = setup(vault);
  const task = (await create(service)).task;
  await vault.create(
    "Tasks/project/old.assets/cp/block.md",
    renderRichBlock({
      id: "block",
      revision: 1,
      kind: "technical_spec",
      title: "Spec",
      summary: "Spec",
      supports: "objective",
      path: "Tasks/project/old.assets/cp/block.md",
      content: "x".repeat(24000),
    }),
  );
  await service.resume({ task_id: task.taskId, completed_limit: 0 });
  assert.ok(!vault.reads.some((p) => p.includes(".assets/")));
  vault.reads = [];
  await service.resume({ task_id: task.taskId, completed_limit: 0 });
  assert.deepEqual(vault.reads, [task.path]);
  const renamed = "Tasks/project/renamed.md";
  await vault.create(renamed, await vault.read(task.path));
  await vault.delete(task.path);
  service.notifyFileChanged(renamed, task.path);
  assert.equal(
    (await service.resume({ task_id: task.taskId, completed_limit: 0 })).task
      .taskId,
    task.taskId,
  );
  vault.busy = renamed;
  await assert.rejects(
    () => service.resume({ task_id: task.taskId, completed_limit: 0 }),
    code("IO_BUSY"),
  );
});

test("legitimate YAML and uncertainty are accepted without losing hard structural validation", () => {
  assert.equal(
    validateRichBlock({
      id: "code",
      revision: 1,
      kind: "code_or_config",
      language: "yaml",
      title: "Config",
      summary: "Database config",
      supports: "objective",
      path: "Tasks/config.md",
      content: "user: postgres\nhost: localhost",
    }).valid,
    true,
  );
  assert.equal(
    validateRichBlock({
      id: "table",
      revision: 1,
      kind: "data_table",
      title: "Broken table",
      summary: "Invalid data",
      supports: "objective",
      path: "Tasks/table.md",
      content: "not a table",
    }).valid,
    false,
  );
});

test("persisted request identity survives restart and concurrent retries", async () => {
  const { service, vault, persistence } = setup();
  const input = taskCreateInputSchema.parse({
    schema_version: 2,
    request_id: "same-request-key",
    board_id: board.id,
    column_id: "bug",
    title: "Idempotent create",
    objective: "Only one document",
    acceptance: ["One document"],
  });
  const [first, retry] = await Promise.all([
    service.create(input),
    service.create(input),
  ]);
  assert.deepEqual(first, retry);
  const nextSession = new TaskService(vault, [board], { persistence });
  assert.deepEqual(await nextSession.create(input), first);
  assert.equal(
    Object.keys(vault.snapshot()).filter((p) => p.startsWith(board.tasksFolder))
      .length,
    1,
  );
});

test("evicted results cannot execute again and prototype-like request IDs are safe", async () => {
  const vault = new MemoryVault(),
    store = new MemoryRuntimeStore(),
    coordinator = new MutationStore(vault, store);
  let count = 0;
  for (let i = 0; i <= 1000; i++)
    await coordinator.run(`operation-${i}`, { i }, async () => ++count);
  await assert.rejects(
    () =>
      new MutationStore(vault, store).run(
        "operation-0",
        { i: 0 },
        async () => ++count,
      ),
    code("IDEMPOTENCY_EXPIRED"),
  );
  assert.equal(count, 1001);
  assert.equal(
    await coordinator.run("__proto__", {}, async () => "safe"),
    "safe",
  );
});

test("interrupted multi-file writes recover conditionally and never overwrite later human edits", async () => {
  const vault = new MemoryVault({
      "task.md": "after",
      "board.md": "before-board",
    }),
    store = new MemoryRuntimeStore();
  const state: RuntimeState = {
    version: 1,
    requests: {},
    journal: {
      requestId: "interrupted",
      files: [
        { path: "task.md", before: "before", after: "after" },
        { path: "board.md", before: "before-board", after: "after-board" },
      ],
    },
  };
  await store.save(state);
  const coordinator = new MutationStore(vault, store);
  await assert.rejects(
    () => coordinator.run("new-request", {}, async () => 1),
    code("RECOVERY_REQUIRED"),
  );
  await coordinator.recover();
  assert.equal(await vault.read("task.md"), "before");
  assert.equal(await coordinator.pending(), undefined);
  await store.save(state);
  await vault.write("task.md", "human changes");
  const afterHuman = new MutationStore(vault, store);
  await assert.rejects(() => afterHuman.recover(), code("RECOVERY_REQUIRED"));
  assert.equal(await vault.read("task.md"), "human changes");
});

test("v1 migration preserves legacy completion without inventing verification or waiver", async () => {
  const codec = new DocumentCodec();
  const cp: CheckpointCore = {
    id: "legacy-cp",
    revision: 1,
    title: "Legacy operation",
    kind: "operation",
    status: "done",
    objective: {
      statement: "Complete the old check",
      acceptance: [
        { id: "a", statement: "The check passed", status: "verified" },
      ],
    },
    outcome: {
      summary: "Old check passed",
      evidence: [{ id: "e", type: "test", statement: "Old test passed" }],
    },
    blocks: [],
  };
  const task: TaskDocument = {
    schema: "checkpoint/v1",
    taskId: "legacy-task",
    boardId: board.id,
    columnId: "bug",
    title: "Legacy task",
    state: "done",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    objective: "Old objective",
    acceptance: ["Old requirement"],
    finalOutcome: "Old completion",
    finalEvidence: [{ id: "e", type: "test", statement: "Old test passed" }],
    checkpoints: [cp],
    path: "Tasks/project/legacy.md",
    revision: 1,
  };
  const original = codec.create(task),
    vault = new MemoryVault({
      [board.file]: source.replace(
        "## Bug",
        "## Bug\n\n- [x] [[Tasks/project/legacy|Legacy task]]",
      ),
      [task.path]: original,
    });
  const service = new TaskService(vault, [board]);
  await service.resume({ task_id: task.taskId, completed_limit: 20 });
  assert.equal(await vault.read(task.path), original);
  const updated = await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    reason: "Clarify title",
    title: "Legacy renamed",
  });
  assert.equal(updated.task.schema, "checkpoint/v2");
  assert.equal(updated.task.state, "done");
  assert.equal(updated.task.legacyAcceptanceReview, true);
  assert.equal(updated.task.acceptanceItems?.[0]?.status, "pending");
});

test("manual-content recovery requires a preview and preserves the original in a separate backup", async () => {
  const { service, vault } = setup();
  const task = (await create(service)).task;
  const manual =
    (await vault.read(task.path)) + "\nHuman correction retained for review\n";
  await vault.write(task.path, manual);
  const preview = await service.previewDocumentRecovery(task.path);
  assert.ok(preview.conflicts.length);
  const backup = await service.restoreManagedDocument(
    task.path,
    preview.hash,
    newId(),
  );
  assert.equal(await vault.read(backup), manual);
  assert.equal(
    (await service.resume({ task_id: task.taskId, completed_limit: 0 })).task
      .revision,
    2,
  );
});

test("malformed unrelated YAML does not break identity lookup", async () => {
  const { service, vault } = setup();
  const task = (await create(service)).task;
  await vault.create(
    "Tasks/project/unrelated.md",
    "---\nbroken: [\n---\nOrdinary note",
  );
  const restarted = new TaskService(vault, [board]);
  assert.equal(
    (await restarted.resume({ task_id: task.taskId, completed_limit: 0 })).task
      .taskId,
    task.taskId,
  );
});

test("simple bug task requires verification evidence linked to each criterion", async () => {
  const bugBoard = {
    ...board,
    columns: board.columns.map((c) => ({ ...c, profile: "bug" as const })),
  };
  const vault = new MemoryVault({ [board.file]: source });
  const service = new TaskService(vault, [bugBoard]);
  const task = (await create(service)).task;
  const input = {
    schema_version: 2 as const,
    task_id: task.taskId,
    expected_revision: 1,
    status: "done" as const,
    final_outcome: "Checks completed",
    remaining: [],
    acceptance: [
      { id: "AC-1", status: "verified" as const, evidence_refs: ["E"] },
      { id: "AC-2", status: "verified" as const, evidence_refs: ["E"] },
    ],
  };
  await assert.rejects(
    () =>
      service.finalize({
        ...input,
        request_id: newId(),
        evidence: [
          { id: "E", type: "artifact", statement: "The patch exists" },
        ],
      }),
    code("QUALITY_REJECTED"),
  );
  const done = await service.finalize({
    ...input,
    request_id: newId(),
    evidence: [
      { id: "E", type: "test", statement: "Both reproduction tests passed" },
    ],
  });
  const reopened = await service.update({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: done.document_revision,
    reason: "Regression was reported",
    state: "active",
  });
  assert.ok(
    reopened.task.acceptanceItems?.every((a) => a.status === "pending"),
  );
});

test("archive diagnostics and state catalog reflect configured semantics", async () => {
  const { service } = setup();
  const task = (await create(service)).task;
  await service.finalize({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    status: "cancelled",
    archived: true,
    final_outcome: "Work cancelled",
    evidence: [],
    remaining: [],
  });
  assert.equal((await service.boardDiagnostics(board.id)).orphan.length, 0);
  assert.equal((await service.boardDiagnostics(board.id)).healthy, true);
});

test("code examples and hidden comments cannot create cards or truncate a board", () => {
  const input =
    "## Bug\n\n````md\n```\n%% kanban:settings\n## Fake\n- [ ] [[fake]]\n````\n\n<!--\n## Hidden\n- [ ] [[hidden]]\n-->\n\n## Feature\n\n" +
    footer;
  const parsed = parseBoard(input, board);
  assert.deepEqual(
    parsed.columns.map((c) => c.heading),
    ["Bug", "Feature"],
  );
  assert.equal(parsed.columns.flatMap((c) => c.cards).length, 0);
  const created = createLinkedCard(input, board, {
    columnId: "feature",
    taskPath: "Tasks/project/new.md",
    title: "A task",
  });
  assert.ok(created.endsWith(footer));
  assert.equal(parseBoard(created, board).columns[1]?.cards.length, 1);
});

test("a board write failure rolls back the changed task and preserves retryability", async () => {
  class FailingBoardVault extends MemoryVault {
    fail = false;
    override async process(path: string, fn: (current: string) => string) {
      if (this.fail && path === board.file)
        throw new VaultIoError(
          "process",
          path,
          Object.assign(new Error("locked"), { code: "EBUSY" }),
        );
      return super.process(path, fn);
    }
  }
  const vault = new FailingBoardVault({ [board.file]: source });
  const { service, persistence } = setup(vault);
  const task = (await create(service)).task;
  const before = await vault.read(task.path);
  vault.fail = true;
  const input = {
    schema_version: 2 as const,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    reason: "Change the title",
    title: "Renamed task",
  };
  await assert.rejects(() => service.update(input), code("IO_BUSY"));
  assert.equal(await vault.read(task.path), before);
  assert.equal((await persistence.load())?.journal, undefined);
  vault.fail = false;
  assert.equal((await service.update(input)).task.title, "Renamed task");
});

test("new checkpoints invalidate task handoffs and stale recovery previews are refused", async () => {
  const { service, vault } = setup();
  const task = (await create(service)).task;
  const handoff = await service.handoff({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 1,
    capsule: {
      based_on_revision: 1,
      next_action: "Start work",
      blockers: [],
      open_questions: [],
      working_artifacts: [],
    },
  });
  await service.checkpointCommit({
    schema_version: 2,
    request_id: newId(),
    task_id: task.taskId,
    expected_revision: 0,
    trigger: "subtask_started",
    core: cpCore(),
  });
  assert.equal(
    (await service.resume({ task_id: task.taskId, completed_limit: 0 }))
      .handoff_status,
    "stale",
  );
  const preview = await service.previewDocumentRecovery(task.path);
  await vault.write(
    task.path,
    (await vault.read(task.path)) + "\nHuman update\n",
  );
  await assert.rejects(
    () => service.restoreManagedDocument(task.path, preview.hash, newId()),
    code("DOCUMENT_CONFLICT"),
  );
  assert.ok((await vault.read(task.path)).endsWith("Human update\n"));
  assert.ok(handoff.document_revision > 1);
});
