import assert from "node:assert/strict";
import test from "node:test";
import type { CheckpointCore, TaskDocument } from "../src/types";
import {
  DocumentCodec,
  TaskDocError,
  createBlockManifest,
  createStableId,
  renderRichBlock,
  sha256,
  validateCheckpoint,
  validateRichBlock,
  validateTaskDocument
} from "../src/core/index";

const activeCheckpoint = (): CheckpointCore => ({
  id: "checkpoint-sync",
  revision: 1,
  title: "验证 PHA comment 更新",
  kind: "implementation",
  status: "active",
  objective: {
    statement: "同一 section 的更新覆盖原有 PHA comment",
    acceptance: [
      { id: "AC-1", statement: "连续更新保持同一 comment ID", status: "pending" }
    ]
  },
  judgment: {
    facts: [{ fact: "PHA comment ID 与 section ID 一对一绑定", relevance: "避免按标题匹配产生重复 comment" }],
    decisions: ["使用 revision 与 content hash 检查条件更新"]
  },
  blocks: []
});

const taskDocument = (): TaskDocument => ({
  schema: "checkpoint/v1",
  taskId: "task-plugin",
  boardId: "board-main",
  columnId: "column-feature",
  title: "将 Taskflow 拆为 Obsidian 插件",
  state: "active",
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
  objective: "任务文档能力脱离 win-console 独立运行",
  acceptance: ["插件可独立启停并在设置页完成配置"],
  resume: {
    focusCheckpointId: "checkpoint-sync",
    basedOnRevision: 1,
    lastVerified: "section ID 已稳定写入 marker",
    nextAction: "验证远端 comment 条件更新接口",
    blockers: [],
    openQuestions: ["PHA 是否提供原地更新 comment 的接口"],
    workingArtifacts: [
      { path: "src/pha/adapter.ts", purpose: "PHA 条件更新适配", state: "editing" }
    ]
  },
  checkpoints: [activeCheckpoint()],
  path: "Tasks/task-plugin.md",
  revision: 1
});

test("sha256 and UUID helpers return stable formats", () => {
  assert.equal(sha256("taskdoc"), sha256("taskdoc"));
  assert.match(sha256("taskdoc"), /^[a-f0-9]{64}$/);
  assert.match(createStableId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("DocumentCodec creates and parses fixed Markdown with resume and checkpoint markers", () => {
  const codec = new DocumentCodec();
  const task = taskDocument();
  const markdown = codec.create(task);

  assert.match(markdown, /^---\ntask_schema: checkpoint\/v1/m);
  assert.match(markdown, /<!-- taskdoc-checkpoint:v1:[A-Za-z0-9_-]+ -->/);
  assert.match(markdown, /> \[!taskdoc-resume\] 当前接续点/);

  const parsed = codec.parse(markdown);
  assert.deepEqual(parsed.task, task);
  assert.equal(parsed.conflicts.length, 0);
  assert.equal(parsed.documentHash, parsed.storedDocumentHash);
});

test("DocumentCodec replaces a checkpoint, increments revisions, and clears a terminal resume", () => {
  const codec = new DocumentCodec();
  const source = codec.create(taskDocument());
  const parsed = codec.parse(source);
  const done: CheckpointCore = {
    ...activeCheckpoint(),
    status: "done",
    objective: {
      ...activeCheckpoint().objective,
      acceptance: [
        { id: "AC-1", statement: "连续更新保持同一 comment ID", status: "verified", evidenceRefs: ["E-1"] }
      ]
    },
    outcome: {
      summary: "连续 revision 已原地更新同一 PHA comment",
      evidence: [{ id: "E-1", type: "test", statement: "连续更新 10 次只产生一个 comment ID" }]
    }
  };

  const mutation = codec.replaceCheckpoint(source, done, {
    expectedDocumentHash: parsed.documentHash,
    expectedCheckpointRevision: 1,
    updatedAt: "2026-08-02T13:00:00.000Z"
  });
  assert.equal(mutation.noop, false);
  assert.equal(mutation.task.revision, 2);
  assert.equal(mutation.task.checkpoints[0]?.revision, 2);
  assert.equal(mutation.task.checkpoints[0]?.status, "done");
  assert.equal(mutation.task.resume, undefined);
  assert.notEqual(mutation.documentHash, parsed.documentHash);
});

test("DocumentCodec invalidates a handoff whenever its focused checkpoint changes", () => {
  const codec = new DocumentCodec();
  const source = codec.create(taskDocument());
  const replacement: CheckpointCore = {
    ...activeCheckpoint(),
    judgment: {
      ...activeCheckpoint().judgment,
      decisions: ["更新后的决定必须重新生成下一动作"]
    }
  };
  const mutation = codec.replaceCheckpoint(source, replacement, { expectedCheckpointRevision: 1 });
  assert.equal(mutation.task.checkpoints[0]?.revision, 2);
  assert.equal(mutation.task.resume, undefined);
});

test("DocumentCodec reads existing documents independently of stricter current write policy", () => {
  const task = { ...taskDocument(), objective: "可能需要根据验证结果调整插件边界" };
  const permissive = new DocumentCodec({ strictQuality: false, coreCharLimit: 10_000 });
  const markdown = permissive.create(task);
  const strict = new DocumentCodec({ strictQuality: true, coreCharLimit: 500 });
  assert.equal(strict.parse(markdown).task.taskId, task.taskId);
  assert.throws(
    () => strict.create(task),
    (error: unknown) => error instanceof TaskDocError && error.code === "QUALITY_REJECTED"
  );
});

test("DocumentCodec round-trips task final evidence and durable remaining items", () => {
  const codec = new DocumentCodec();
  const { resume: _resume, ...base } = taskDocument();
  const checkpoint: CheckpointCore = {
    ...activeCheckpoint(),
    status: "done",
    objective: {
      ...activeCheckpoint().objective,
      acceptance: [{ id: "AC-1", statement: "连续更新保持同一 comment ID", status: "verified", evidenceRefs: ["E-1"] }]
    },
    outcome: {
      summary: "PHA comment 原地更新已验证",
      evidence: [{ id: "E-1", type: "test", statement: "连续更新保持同一 comment ID" }]
    }
  };
  const task: TaskDocument = {
    ...base,
    state: "done",
    finalOutcome: "TaskDoc 插件核心链路已完成",
    finalEvidence: [{ id: "TE-1", type: "test", statement: "核心回归测试全部通过" }],
    remaining: ["PHA 双向同步留待独立阶段"],
    checkpoints: [checkpoint]
  };
  const parsed = codec.parse(codec.create(task));
  assert.deepEqual(parsed.task.finalEvidence, task.finalEvidence);
  assert.deepEqual(parsed.task.remaining, task.remaining);
});

test("DocumentCodec detects manual edits before replacement", () => {
  const codec = new DocumentCodec();
  const markdown = codec.create(taskDocument());
  const edited = markdown.replace("同一 section 的更新覆盖原有 PHA comment", "人工改写的目标");
  assert.throws(
    () => codec.parse(edited),
    (error: unknown) => error instanceof TaskDocError && error.code === "DOCUMENT_CONFLICT"
  );
  const inspected = codec.parse(edited, undefined, { allowConflicts: true });
  assert.ok(inspected.conflicts.some((entry) => entry.scope === "checkpoint"));
});

test("done checkpoint without concrete evidence is rejected", () => {
  const checkpoint: CheckpointCore = {
    ...activeCheckpoint(),
    status: "done",
    objective: {
      ...activeCheckpoint().objective,
      acceptance: [{ id: "AC-1", statement: "连续更新保持同一 comment ID", status: "verified" }]
    },
    outcome: { summary: "同步已完成", evidence: [] }
  };
  const validation = validateCheckpoint(checkpoint);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.rule === "done_evidence"));
});

test("durable constraint requires complete fields and a resolvable evidence reference", () => {
  const checkpoint: CheckpointCore = {
    ...activeCheckpoint(),
    judgment: {
      constraints: [{
        rejectedOption: "递归目录 watcher",
        verifiedReason: "大 vault 会触发文件句柄上限",
        scope: "Windows 与 WSL 跨界目录",
        impact: "外部写入改由启动扫描补偿",
        evidenceRefs: ["E-1"],
        reconsiderWhen: "监听进程统一到 Windows 原生环境"
      }]
    },
    outcome: {
      summary: "跨界 watcher 的部署约束已确认",
      evidence: [{ id: "E-1", type: "observation", statement: "二万文件场景稳定复现句柄上限" }]
    }
  };
  assert.equal(validateCheckpoint(checkpoint).valid, true);

  const invalid: CheckpointCore = {
    ...checkpoint,
    judgment: {
      constraints: [{
        rejectedOption: "递归目录 watcher",
        verifiedReason: "大 vault 会触发文件句柄上限",
        scope: "Windows 与 WSL 跨界目录",
        impact: "外部写入改由启动扫描补偿",
        evidenceRefs: []
      }]
    }
  };
  assert.ok(validateCheckpoint(invalid).errors.some((entry) => entry.rule === "constraint_evidence"));
});

test("rich blocks enforce typed content and render a bounded artifact", () => {
  const block = {
    id: "block-matrix",
    revision: 1,
    kind: "data_table" as const,
    title: "PHA 同步验收矩阵",
    summary: "覆盖本地、远端和离线恢复",
    supports: "outcome" as const,
    path: "Task.assets/CP-01/matrix.md",
    content: "| 场景 | 状态 |\n| --- | --- |\n| 本地更新 | 通过 |"
  };
  assert.equal(validateRichBlock(block).valid, true);
  assert.match(renderRichBlock(block), /taskdoc_block: rich\/v1/);
  const manifest = createBlockManifest(block);
  assert.equal(manifest.chars, Array.from(block.content).length);
  assert.match(manifest.contentHash, /^[a-f0-9]{64}$/);

  const defaultBoundary = {
    ...block,
    kind: "technical_spec" as const,
    content: "x".repeat(24_576)
  };
  assert.equal(validateRichBlock(defaultBoundary).valid, true);
  assert.equal(validateRichBlock({ ...defaultBoundary, content: `${defaultBoundary.content}x` }).valid, false);
});

test("active tasks and checkpoint states reject terminal-only fields", () => {
  const task: TaskDocument = {
    ...taskDocument(),
    finalOutcome: "旧的终态结果不应留在 reopened task"
  };
  assert.ok(validateTaskDocument(task).errors.some((entry) => entry.rule === "terminal_fields"));
  assert.ok(validateCheckpoint({ ...activeCheckpoint(), blocker: "stale blocker" }).errors.some((entry) => entry.rule === "state_field"));
});
