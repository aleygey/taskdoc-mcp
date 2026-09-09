import assert from "node:assert/strict";
import test from "node:test";
import { VaultIoError, type BoardConfig } from "../src/types.js";
import { TaskApiError } from "../src/mcp/api.js";
import { TaskService } from "../src/service.js";
import { MemoryVault } from "../src/testing/memoryVault.js";

const board: BoardConfig = {
  id: "board-project",
  name: "Project",
  projectId: "project",
  file: "Projects/project.md",
  tasksFolder: "Tasks/project",
  defaultColumnId: "analysis",
  autoConvertCards: false,
  columns: [
    {
      id: "analysis",
      heading: "Analysis",
      typeId: "analysis",
      profile: "research",
    },
    {
      id: "implementation",
      heading: "Implementation",
      typeId: "implementation",
      profile: "feature",
    },
  ],
};

const boardMarkdown = [
  "---",
  "kanban-plugin: board",
  "---",
  "# Project",
  "",
  "## Analysis",
  "",
  "## Implementation",
  "",
].join("\n");

test("TaskService runs create → checkpoint → block → handoff → resume → finalize across sessions", async () => {
  const vault = new MemoryVault({ [board.file]: boardMarkdown });
  const ids = idSequence([
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003",
    "40000000-0000-4000-8000-000000000004",
  ]);
  const service = new TaskService(vault, [board], {
    idFactory: ids,
    now: () => "2026-08-02T12:00:00.000Z",
  });

  const catalog = await service.catalog({});
  assert.equal(catalog.boards[0]?.columns.length, 2);
  assert.equal(typeof catalog.boards[0]?.revision, "number");

  const created = await service.create({
    schema_version: 1,
    request_id: "request-create-0001",
    board_id: board.id,
    column_id: "analysis",
    title: "验证跨会话任务服务",
    objective: "验证结构化任务能够跨会话恢复并完成",
    acceptance: ["新服务实例能从任务目录恢复接续点"],
  });
  assert.equal(created.document_revision, 1);
  assert.equal(created.pha_sync, "unbound");
  assert.match(created.task.taskId, /^[0-9a-f-]{36}$/);
  assert.equal(await vault.exists(created.task.path), true);
  assert.match(
    await vault.read(board.file),
    new RegExp(
      `\\[\\[${escapeRegExp(created.task.path.replace(/\.md$/, ""))}\\|验证跨会话任务服务\\]\\]`,
    ),
  );

  const queried = await service.query({
    board_id: board.id,
    column_id: "analysis",
    state: "active",
    query: "跨会话",
    limit: 20,
  });
  assert.deepEqual(
    queried.tasks.map((task) => task.task_id),
    [created.task.taskId],
  );

  const moved = await service.cardUpdate({
    schema_version: 1,
    request_id: "request-card-update-0001",
    task_id: created.task.taskId,
    expected_revision: created.document_revision,
    column_id: "implementation",
  });
  assert.equal(moved.task.columnId, "implementation");
  assert.equal(moved.document_revision, 2);

  const checkpointInput = {
    schema_version: 1 as const,
    request_id: "request-checkpoint-0001",
    task_id: created.task.taskId,
    expected_revision: 0,
    trigger: "subtask_started" as const,
    core: {
      title: "实现跨会话恢复",
      kind: "implementation" as const,
      status: "active" as const,
      objective: {
        statement: "实现任务的持久 checkpoint 与接续卡",
        acceptance: [
          {
            id: "AC-1",
            statement: "新实例可读取接续信息",
            status: "pending" as const,
          },
        ],
      },
      judgment: {
        decisions: ["任务身份和 checkpoint 身份使用稳定 UUID"],
      },
    },
  };
  const checkpoint = await service.checkpointCommit(checkpointInput);
  assert.equal(checkpoint.checkpoint.revision, 1);
  assert.equal(checkpoint.document_revision, 3);

  const repeated = await service.checkpointCommit(checkpointInput);
  assert.deepEqual(
    repeated,
    checkpoint,
    "same request_id and payload must return the first result",
  );
  await assert.rejects(
    () =>
      service.checkpointCommit({
        ...checkpointInput,
        core: { ...checkpointInput.core, title: "复用请求键但改变内容" },
      }),
    (error: unknown) =>
      error instanceof TaskApiError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  const block = await service.blockPut({
    schema_version: 1,
    request_id: "request-block-0001",
    task_id: created.task.taskId,
    checkpoint_id: checkpoint.checkpoint.id,
    expected_revision: 0,
    block: {
      kind: "mermaid",
      title: "接续数据流",
      summary: "展示 checkpoint、handoff 与新会话之间的持久化关系",
      supports: "judgment",
      content:
        "flowchart LR\n  CP[Checkpoint] --> H[Handoff]\n  H --> S[New session]",
    },
  });
  assert.equal(block.block.revision, 1);
  assert.match(block.block.path, /\.assets\//);
  assert.match(block.block.contentHash, /^[a-f0-9]{64}$/);
  const originalBlockAsset = await vault.read(block.block.path);
  assert.match(originalBlockAsset, /```mermaid/);
  await vault.write(block.block.path, `${originalBlockAsset}\nmanual edit\n`);
  await assert.rejects(
    () =>
      service.read({
        task_id: created.task.taskId,
        view: "block",
        checkpoint_id: checkpoint.checkpoint.id,
        block_id: block.block.id,
        checkpoint_limit: 20,
        max_chars: 4096,
      }),
    (error: unknown) =>
      error instanceof TaskApiError && error.code === "DOCUMENT_CONFLICT",
  );
  await assert.rejects(
    () =>
      service.blockPut({
        schema_version: 1,
        request_id: "request-block-conflict",
        task_id: created.task.taskId,
        checkpoint_id: checkpoint.checkpoint.id,
        block_id: block.block.id,
        expected_revision: 1,
        block: {
          kind: "mermaid",
          title: "接续数据流",
          summary: "展示 checkpoint、handoff 与新会话之间的持久化关系",
          supports: "judgment",
          content: "flowchart LR\n  CP[Checkpoint] --> S[Session]",
        },
      }),
    (error: unknown) =>
      error instanceof TaskApiError && error.code === "DOCUMENT_CONFLICT",
  );
  await vault.write(block.block.path, originalBlockAsset);

  const handedOff = await service.handoff({
    schema_version: 1,
    request_id: "request-handoff-0001",
    task_id: created.task.taskId,
    expected_revision: block.document_revision,
    capsule: {
      focus_checkpoint_id: checkpoint.checkpoint.id,
      based_on_revision: 2,
      last_verified: "任务文档和 Mermaid block 已持久化",
      next_action: "验证新服务实例读取接续卡",
      blockers: [],
      open_questions: [],
      working_artifacts: [
        { path: created.task.path, purpose: "任务事实源", state: "verified" },
      ],
    },
  });
  assert.equal(handedOff.document_revision, 5);

  // A fresh service has no in-memory task index or idempotency history. It must
  // find the task by scanning the configured managed task folder.
  const nextSession = new TaskService(vault, [board], {
    idFactory: ids,
    now: () => "2026-08-02T12:01:00.000Z",
  });
  const resumed = await nextSession.resume({
    task_id: created.task.taskId,
    completed_limit: 20,
  });
  assert.equal(resumed.capsule?.nextAction, "验证新服务实例读取接续卡");
  assert.deepEqual(resumed.task.acceptance, [
    "新服务实例能从任务目录恢复接续点",
  ]);
  assert.equal(resumed.active_checkpoints[0]?.blocks[0]?.id, block.block.id);

  const outline = await nextSession.read({
    task_id: created.task.taskId,
    view: "outline",
    checkpoint_limit: 20,
    max_chars: 4096,
  });
  assert.equal(outline.task?.revision, 5);
  const checkpointView = await nextSession.read({
    task_id: created.task.taskId,
    view: "checkpoint",
    checkpoint_id: checkpoint.checkpoint.id,
    checkpoint_limit: 20,
    max_chars: 4096,
  });
  assert.equal(checkpointView.checkpoint?.title, "实现跨会话恢复");
  const blockView = await nextSession.read({
    task_id: created.task.taskId,
    view: "block",
    checkpoint_id: checkpoint.checkpoint.id,
    block_id: block.block.id,
    checkpoint_limit: 20,
    max_chars: 4096,
  });
  assert.match(blockView.block?.content ?? "", /flowchart LR/);

  const completedCheckpoint = await nextSession.checkpointCommit({
    schema_version: 1,
    request_id: "request-checkpoint-0002",
    task_id: created.task.taskId,
    checkpoint_id: checkpoint.checkpoint.id,
    expected_revision: 2,
    trigger: "result_verified",
    core: {
      title: "实现跨会话恢复",
      kind: "implementation",
      status: "done",
      objective: {
        statement: "实现任务的持久 checkpoint 与接续卡",
        acceptance: [
          {
            id: "AC-1",
            statement: "新实例可读取接续信息",
            status: "verified",
            evidence_refs: ["E-1"],
          },
        ],
      },
      judgment: { decisions: ["任务身份和 checkpoint 身份使用稳定 UUID"] },
      outcome: {
        summary:
          "新服务实例已从任务目录恢复 checkpoint、block manifest 和接续卡",
        evidence: [
          { id: "E-1", type: "test", statement: "跨实例端到端读取断言通过" },
        ],
      },
    },
  });
  assert.equal(completedCheckpoint.checkpoint.revision, 3);
  assert.equal(completedCheckpoint.document_revision, 6);

  const noCompletedHistory = await nextSession.resume({
    task_id: created.task.taskId,
    completed_limit: 0,
  });
  assert.deepEqual(noCompletedHistory.completed_outline, []);
  assert.equal(noCompletedHistory.next_cursor, undefined);

  const finalized = await nextSession.finalize({
    schema_version: 1,
    request_id: "request-finalize-0001",
    task_id: created.task.taskId,
    expected_revision: completedCheckpoint.document_revision,
    status: "done",
    final_outcome: "结构化任务可跨服务实例恢复并完成",
    acceptance: [{ id: "AC-1", status: "verified", evidence_refs: ["E-1"] }],
    evidence: [{ type: "test", statement: "完整服务流程测试通过" }],
    remaining: [],
  });
  assert.equal(finalized.task.state, "done");
  assert.equal(finalized.document_revision, 7);
  const finalResume = await nextSession.resume({
    task_id: created.task.taskId,
    completed_limit: 20,
  });
  assert.equal(finalResume.capsule, undefined);
  const finalBoard = await vault.read(board.file);
  assert.match(finalBoard, /## Implementation[\s\S]*- \[x\]/);

  const done = await nextSession.query({
    board_id: board.id,
    state: "done",
    limit: 20,
  });
  assert.deepEqual(
    done.tasks.map((task) => task.task_id),
    [created.task.taskId],
  );

  const reopened = await nextSession.cardUpdate({
    schema_version: 1,
    request_id: "request-reopen-0001",
    task_id: created.task.taskId,
    expected_revision: finalized.document_revision,
    state: "active",
  });
  assert.equal(reopened.task.state, "active");
  const reopenedOutline = await nextSession.read({
    task_id: created.task.taskId,
    view: "outline",
    checkpoint_limit: 20,
    max_chars: 4096,
  });
  assert.equal(reopenedOutline.task?.finalOutcome, undefined);
  assert.match(await vault.read(board.file), /## Implementation[\s\S]*- \[ \]/);
});

test("finalize requires covered acceptance and column profiles enforce evidence", async () => {
  const vault = new MemoryVault({ [board.file]: boardMarkdown });
  const service = new TaskService(vault, [board], {
    idFactory: idSequence([
      "60000000-0000-4000-8000-000000000006",
      "70000000-0000-4000-8000-000000000007",
      "80000000-0000-4000-8000-000000000008",
    ]),
    now: () => "2026-08-02T12:00:00.000Z",
  });
  const created = await service.create({
    schema_version: 1,
    request_id: "request-lifecycle-create",
    board_id: board.id,
    column_id: "analysis",
    title: "验证终态门槛",
    objective: "确保任务完成前存在可追溯 checkpoint",
    acceptance: ["至少一个 checkpoint 提供最终证据"],
  });
  await assert.rejects(
    () =>
      service.finalize({
        schema_version: 1,
        request_id: "request-lifecycle-finalize",
        task_id: created.task.taskId,
        expected_revision: 1,
        status: "done",
        final_outcome: "不应直接完成",
        evidence: [{ type: "test", statement: "仅有任务级测试描述" }],
        remaining: [],
      }),
    (error: unknown) =>
      error instanceof TaskApiError && error.code === "QUALITY_REJECTED",
  );
  await assert.rejects(
    () =>
      service.checkpointCommit({
        schema_version: 1,
        request_id: "request-profile-checkpoint",
        task_id: created.task.taskId,
        expected_revision: 0,
        trigger: "result_verified",
        core: {
          title: "形成调研结论",
          kind: "implementation",
          status: "done",
          objective: {
            statement: "形成带来源的调研结论",
            acceptance: [
              {
                id: "AC-1",
                statement: "结论具有来源证据",
                status: "verified",
                evidence_refs: ["E-1"],
              },
            ],
          },
          judgment: { decisions: ["选择可验证的方案"] },
          outcome: {
            summary: "只有测试证据，不满足 research profile",
            evidence: [
              { id: "E-1", type: "test", statement: "本地单元测试通过" },
            ],
          },
        },
      }),
    (error: unknown) =>
      error instanceof TaskApiError && error.code === "QUALITY_REJECTED",
  );
});

test("create rolls its document back when the card cannot be inserted", async () => {
  const badBoard = { ...board, file: "Projects/broken.md" };
  const vault = new MemoryVault({
    [badBoard.file]: "## A heading that is not configured\n",
  });
  const service = new TaskService(vault, [badBoard], {
    idFactory: () => "50000000-0000-4000-8000-000000000005",
    now: () => "2026-08-02T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      service.create({
        schema_version: 1,
        request_id: "request-create-failure",
        board_id: badBoard.id,
        column_id: "analysis",
        title: "应当回滚的任务",
        objective: "确认跨文件创建失败不会留下孤立任务文档",
        acceptance: ["任务文档被删除"],
      }),
    TaskApiError,
  );
  const taskFiles = await vault.listMarkdownFiles([badBoard.tasksFolder]);
  assert.deepEqual(taskFiles, []);
});

test("typed Vault busy failures remain safely retryable", async () => {
  class BusyVault extends MemoryVault {
    override async read(path: string): Promise<string> {
      throw new VaultIoError("read", path, { code: "EBUSY" });
    }
  }
  const service = new TaskService(
    new BusyVault({ [board.file]: boardMarkdown }),
    [board],
  );
  await assert.rejects(
    () => service.catalog({}),
    (error: unknown) =>
      error instanceof TaskApiError &&
      error.code === "IO_BUSY" &&
      error.retryable &&
      error.action === "retry_same_request",
  );
});

function idSequence(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Test ID sequence exhausted");
    index += 1;
    return value;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
