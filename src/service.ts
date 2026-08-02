import { VaultIoError } from "./types.js";
import type {
  BoardConfig,
  CheckpointCore,
  Evidence,
  ResumeCapsule,
  TaskDocSettings,
  TaskDocument,
  VaultAdapter,
} from "./types.js";
import {
  BoardCardNotFoundError,
  BoardColumnNotFoundError,
  BoardNotFoundError,
  BoardRevisionConflictError,
  BoardService,
  BrokenTaskLinkError,
  DuplicateBoardCardError,
  KanbanError,
} from "./kanban/index.js";
import {
  DocumentCodec,
  TaskDocError,
  canonicalJson,
  createBlockManifest,
  renderRichBlock,
  sha256,
  type DocumentMutationResult,
  type RichBlockInput,
  type ValidationOptions,
} from "./core/index.js";
import type {
  MutationResultMeta,
  TaskApi,
  TaskBlockPutOutput,
  TaskCardUpdateOutput,
  TaskCatalogOutput,
  TaskCheckpointCommitOutput,
  TaskCreateOutput,
  TaskFinalizeOutput,
  TaskHandoffOutput,
  TaskQueryOutput,
  TaskReadOutput,
  TaskResumeOutput,
} from "./mcp/api.js";
import { TaskApiError } from "./mcp/api.js";
import type {
  TaskBlockPutInput,
  TaskCardUpdateInput,
  TaskCatalogInput,
  TaskCheckpointCommitInput,
  TaskCreateInput,
  TaskFinalizeInput,
  TaskHandoffInput,
  TaskQueryInput,
  TaskReadInput,
  TaskResumeInput,
} from "./mcp/schemas.js";
import { IdempotencyStore, KeyedMutex } from "./util/concurrency.js";
import { newId } from "./util/id.js";

export interface TaskServiceOptions {
  validation?: ValidationOptions;
  now?: () => string;
  idFactory?: () => string;
}

interface LocatedTask {
  path: string;
  content: string;
  parsed: ReturnType<DocumentCodec["parse"]>;
}

interface TaskMutation {
  before: string;
  result: DocumentMutationResult;
}

type SettingsSource = TaskDocSettings | readonly BoardConfig[];

/**
 * Application service shared by the MCP gateway and the Obsidian plugin.
 * It deliberately owns all multi-file orchestration; the codec and board
 * service remain deterministic, single-document components.
 */
export class TaskService implements TaskApi {
  private boards: BoardConfig[];
  private boardService: BoardService;
  private codec: DocumentCodec;
  private readonly taskMutex = new KeyedMutex();
  private readonly requestMutex = new KeyedMutex();
  private readonly idempotency = new IdempotencyStore();
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly vault: VaultAdapter,
    settingsOrBoards: SettingsSource,
    options: TaskServiceOptions = {},
  ) {
    this.boards = [...boardsFrom(settingsOrBoards)];
    this.boardService = new BoardService(vault, this.boards);
    this.codec = new DocumentCodec(options.validation ?? validationFrom(settingsOrBoards));
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? newId;
  }

  setBoards(boards: readonly BoardConfig[]): void {
    this.boards = [...boards];
    this.boardService.setBoards(this.boards);
  }

  setSettings(settings: TaskDocSettings): void {
    this.setBoards(settings.boards);
    this.codec = new DocumentCodec(validationFrom(settings));
  }

  async catalog(_input: TaskCatalogInput): Promise<TaskCatalogOutput> {
    return this.guard(async () => {
      const entries = await this.boardService.catalog();
      return {
        boards: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          projectId: entry.projectId,
          file: entry.file,
          tasksFolder: entry.tasksFolder,
          autoConvertCards: entry.autoConvertCards,
          columns: entry.columns.map(({ id, heading, typeId, profile }) => ({ id, heading, typeId, profile })),
          ...(entry.defaultColumnId === undefined ? {} : { defaultColumnId: entry.defaultColumnId }),
          revision: boardRevisionNumber(entry.revision),
        })),
      };
    });
  }

  async query(input: TaskQueryInput): Promise<TaskQueryOutput> {
    return this.guard(async () => {
      const cards = await this.boardService.query({
        ...(input.board_id === undefined ? {} : { boardId: input.board_id }),
        ...(input.column_id === undefined ? {} : { columnId: input.column_id }),
        ...(input.query === undefined ? {} : { title: input.query }),
      });
      const tasks: TaskQueryOutput["tasks"] = [];
      for (const card of cards) {
        if (card.taskPath === undefined) continue;
        let task: TaskDocument;
        try {
          task = this.codec.parseTask(await this.vault.read(card.taskPath), card.taskPath);
        } catch (error) {
          if (error instanceof TaskDocError) throw error;
          throw new TaskApiError("IO_ERROR", "A linked task document could not be read", {
            action: "retry_same_request",
            retryable: true,
            details: { path: card.taskPath },
            cause: error,
          });
        }
        if (input.state !== undefined && task.state !== input.state) continue;
        tasks.push({
          task_id: task.taskId,
          board_id: task.boardId,
          column_id: task.columnId,
          title: task.title,
          state: task.state,
          path: task.path,
          revision: task.revision,
        });
      }
      tasks.sort((left, right) => left.path.localeCompare(right.path));
      const page = paginate(tasks, input.cursor, input.limit);
      return { tasks: page.items, ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) };
    });
  }

  async resume(input: TaskResumeInput): Promise<TaskResumeOutput> {
    return this.guard(async () => {
      const { parsed } = await this.findTask(input.task_id);
      const task = parsed.task;
      const active = task.checkpoints.filter((checkpoint) => checkpoint.status === "active" || checkpoint.status === "blocked");
      const completed = task.checkpoints
        .filter((checkpoint) => checkpoint.status !== "active" && checkpoint.status !== "blocked")
        .map((checkpoint) => ({
          id: checkpoint.id,
          title: checkpoint.title,
          status: checkpoint.status,
          revision: checkpoint.revision,
          ...(checkpoint.outcome?.summary === undefined ? {} : { outcome: checkpoint.outcome.summary }),
        }));
      const page = paginate(completed, input.cursor, input.completed_limit);
      return {
        task: {
          taskId: task.taskId,
          boardId: task.boardId,
          columnId: task.columnId,
          title: task.title,
          state: task.state,
          objective: task.objective,
          acceptance: task.acceptance,
          revision: task.revision,
        },
        active_checkpoints: active,
        completed_outline: page.items,
        ...(task.resume === undefined ? {} : { capsule: task.resume }),
        ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
      };
    });
  }

  async read(input: TaskReadInput): Promise<TaskReadOutput> {
    return this.guard(async () => {
      const { parsed } = await this.findTask(input.task_id);
      if (input.view === "outline") {
        const task = parsed.task;
        const checkpointOutlines = task.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          title: checkpoint.title,
          kind: checkpoint.kind,
          status: checkpoint.status,
          revision: checkpoint.revision,
          blocks: checkpoint.blocks,
          ...(checkpoint.outcome?.summary === undefined ? {} : { outcome: checkpoint.outcome.summary }),
        }));
        const page = paginate(checkpointOutlines, input.cursor, input.checkpoint_limit);
        return {
          view: "outline",
          task: {
            taskId: task.taskId,
            boardId: task.boardId,
            columnId: task.columnId,
            title: task.title,
            state: task.state,
            objective: task.objective,
            acceptance: task.acceptance,
            revision: task.revision,
            path: task.path,
            ...(task.finalOutcome === undefined ? {} : { finalOutcome: task.finalOutcome }),
            ...(task.remaining === undefined ? {} : { remaining: task.remaining }),
            checkpoints: page.items,
            ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
          },
        };
      }

      const checkpoint = parsed.task.checkpoints.find((candidate) => candidate.id === input.checkpoint_id);
      if (checkpoint === undefined) throw checkpointNotFound(input.checkpoint_id ?? "");
      if (input.view === "checkpoint") return { view: "checkpoint", checkpoint };

      const manifest = checkpoint.blocks.find((candidate) => candidate.id === input.block_id);
      if (manifest === undefined) {
        throw new TaskApiError("INVALID_INPUT", `Rich block not found: ${input.block_id ?? ""}`, {
          action: "reread",
        });
      }
      const source = await this.vault.read(manifest.path);
      if (sha256(source) !== manifest.contentHash) {
        throw new TaskApiError("DOCUMENT_CONFLICT", "Rich block content no longer matches its manifest", {
          action: "reread",
          details: { block_id: manifest.id, path: manifest.path },
        });
      }
      const page = paginateText(source, input.cursor, input.max_chars);
      return {
        view: "block",
        block: {
          manifest,
          content: page.content,
          ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
        },
      };
    });
  }

  async create(input: TaskCreateInput): Promise<TaskCreateOutput> {
    return this.mutation(input.request_id, input, "create", async () => {
      const board = this.requireBoard(input.board_id);
      this.requireColumn(board, input.column_id);
      const snapshot = await this.boardService.snapshot(board.id);
      if (
        input.expected_board_revision !== undefined &&
        input.expected_board_revision !== boardRevisionNumber(snapshot.revision)
      ) {
        throw versionConflict("Board revision changed", input.expected_board_revision, boardRevisionNumber(snapshot.revision));
      }

      const taskId = this.idFactory();
      const path = taskPath(board.tasksFolder, input.title, taskId);
      const timestamp = this.now();
      const task: TaskDocument = {
        schema: "checkpoint/v1",
        taskId,
        boardId: board.id,
        columnId: input.column_id,
        title: input.title,
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        objective: input.objective,
        acceptance: [...input.acceptance],
        checkpoints: [],
        path,
        revision: 1,
      };
      const content = this.codec.create(task);
      if (await this.vault.exists(path)) {
        throw new TaskApiError("DOCUMENT_CONFLICT", `Task path already exists: ${path}`, { action: "reread" });
      }
      await this.vault.create(path, content);
      try {
        await this.boardService.createCard({
          boardId: board.id,
          columnId: input.column_id,
          taskPath: path,
          title: task.title,
          expectedRevision: snapshot.revision,
        });
      } catch (error) {
        await this.rollbackCreatedFile(path, content);
        throw error;
      }
      const parsed = this.codec.parse(content, path);
      return { task: parsed.task, ...meta(parsed, false) };
    });
  }

  async cardUpdate(input: TaskCardUpdateInput): Promise<TaskCardUpdateOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () => this.taskMutex.run(input.task_id, async () => {
      const located = await this.findTask(input.task_id);
      const board = this.requireBoard(located.parsed.task.boardId);
      if (input.column_id !== undefined) this.requireColumn(board, input.column_id);
      const oldContent = located.content;
      const changed = await this.mutateTask(located.path, input.expected_revision, (task) => {
        const moved: TaskDocument = {
          ...task,
          ...(input.column_id === undefined ? {} : { columnId: input.column_id }),
          ...(input.state === undefined ? {} : { state: input.state }),
        };
        if (input.state === "active" && task.state !== "active") {
          const {
            resume: _resume,
            finalOutcome: _finalOutcome,
            finalEvidence: _finalEvidence,
            remaining: _remaining,
            ...reopened
          } = moved;
          return reopened;
        }
        return moved;
      });

      try {
        await this.boardService.updateCard({
          boardId: board.id,
          taskPath: located.path,
          ...(input.column_id === undefined ? {} : { columnId: input.column_id }),
          ...(input.state === undefined ? {} : { checked: input.state !== "active" }),
        });
      } catch (error) {
        if (!changed.result.noop) await this.rollbackChangedFile(located.path, changed.result.content, oldContent);
        throw error;
      }
      return { task: taskSummary(changed.result.task), ...meta(changed.result, changed.result.noop) };
    }));
  }

  async checkpointCommit(input: TaskCheckpointCommitInput): Promise<TaskCheckpointCommitOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () => this.taskMutex.run(input.task_id, async () => {
      const located = await this.findTask(input.task_id);
      const checkpointId = input.checkpoint_id ?? this.idFactory();
      const existing = located.parsed.task.checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
      if (existing === undefined && input.expected_revision !== 0) {
        throw versionConflict("New checkpoint revision must be 0", input.expected_revision, 0);
      }
      if (existing !== undefined && input.checkpoint_id === undefined) {
        throw new TaskApiError("DOCUMENT_CONFLICT", `Generated checkpoint ID already exists: ${checkpointId}`, {
          action: "retry_same_request",
          retryable: true,
        });
      }
      const checkpoint = checkpointFrom(input, checkpointId, existing);
      this.assertProfileAllows(located.parsed.task, checkpoint);
      let result: DocumentMutationResult | undefined;
      await this.vault.process(located.path, (current) => {
        result = existing === undefined
          ? this.codec.createCheckpoint(current, checkpoint, { path: located.path, updatedAt: this.now() })
          : this.codec.replaceCheckpoint(current, checkpoint, {
              path: located.path,
              expectedCheckpointRevision: input.expected_revision,
              updatedAt: this.now(),
            });
        return result.content;
      });
      const committed = requireMutation(result);
      const stored = committed.task.checkpoints.find((candidate) => candidate.id === checkpointId);
      if (stored === undefined) throw new Error("Committed checkpoint disappeared");
      return {
        task_id: input.task_id,
        checkpoint: stored,
        ...meta(committed, committed.noop),
      };
    }));
  }

  async blockPut(input: TaskBlockPutInput): Promise<TaskBlockPutOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () => this.taskMutex.run(input.task_id, async () => {
      const located = await this.findTask(input.task_id);
      const checkpoint = located.parsed.task.checkpoints.find((candidate) => candidate.id === input.checkpoint_id);
      if (checkpoint === undefined) throw checkpointNotFound(input.checkpoint_id);
      const blockId = input.block_id ?? this.idFactory();
      const existing = checkpoint.blocks.find((candidate) => candidate.id === blockId);
      if (existing === undefined && input.expected_revision !== 0) {
        throw versionConflict("New rich block revision must be 0", input.expected_revision, 0);
      }
      if (existing !== undefined && existing.revision !== input.expected_revision) {
        throw versionConflict("Rich block revision changed", input.expected_revision, existing.revision);
      }

      const path = existing?.path ?? blockPath(located.path, checkpoint.id, blockId);
      const base = richBlockFrom(input, blockId, path, existing?.revision ?? 1);
      const currentAsset = existing === undefined ? undefined : await this.vault.read(path);
      if (existing !== undefined && sha256(currentAsset ?? "") !== existing.contentHash) {
        throw new TaskApiError("DOCUMENT_CONFLICT", "Rich block was modified outside TaskDoc MCP", {
          action: "reread",
          details: { block_id: blockId, path },
        });
      }
      const same = existing !== undefined && currentAsset === renderRichBlock(base, this.codec.validationOptions);
      if (same) {
        return {
          task_id: input.task_id,
          checkpoint_id: checkpoint.id,
          block: existing,
          ...meta(located.parsed, true),
        };
      }

      const richBlock: RichBlockInput = {
        ...base,
        revision: existing === undefined ? 1 : existing.revision + 1,
      };
      const assetContent = renderRichBlock(richBlock, this.codec.validationOptions);
      let oldAsset: string | undefined;
      if (existing === undefined) {
        if (await this.vault.exists(path)) {
          throw new TaskApiError("DOCUMENT_CONFLICT", `Rich block path already exists: ${path}`, { action: "reread" });
        }
        await this.vault.create(path, assetContent);
      } else {
        await this.vault.process(path, (current) => {
          if (sha256(current) !== existing.contentHash) {
            throw new TaskApiError("DOCUMENT_CONFLICT", "Rich block changed before it could be replaced", {
              action: "reread",
              details: { block_id: blockId, path },
            });
          }
          oldAsset = current;
          return assetContent;
        });
      }

      let result: DocumentMutationResult | undefined;
      try {
        const manifest = createBlockManifest(richBlock, this.codec.validationOptions);
        await this.vault.process(located.path, (current) => {
          const latest = this.codec.parse(current, located.path);
          const latestCheckpoint = latest.task.checkpoints.find((candidate) => candidate.id === checkpoint.id);
          if (latestCheckpoint === undefined) throw checkpointNotFound(checkpoint.id);
          if (latestCheckpoint.revision !== checkpoint.revision) {
            throw versionConflict("Checkpoint changed while storing rich block", checkpoint.revision, latestCheckpoint.revision);
          }
          const latestBlock = latestCheckpoint.blocks.find((candidate) => candidate.id === blockId);
          if (existing === undefined && latestBlock !== undefined) {
            throw new TaskApiError("DOCUMENT_CONFLICT", `Rich block already exists: ${blockId}`, { action: "reread" });
          }
          if (existing !== undefined && (
            latestBlock === undefined ||
            latestBlock.revision !== existing.revision ||
            latestBlock.contentHash !== existing.contentHash
          )) {
            throw versionConflict("Rich block manifest changed", existing.revision, latestBlock?.revision ?? 0);
          }
          const blocks = existing === undefined
            ? [...latestCheckpoint.blocks, manifest]
            : latestCheckpoint.blocks.map((candidate) => candidate.id === blockId ? manifest : candidate);
          result = this.codec.replaceCheckpoint(current, { ...latestCheckpoint, blocks }, {
            path: located.path,
            expectedCheckpointRevision: latestCheckpoint.revision,
            updatedAt: this.now(),
          });
          return result.content;
        });
      } catch (error) {
        if (existing === undefined) await this.rollbackCreatedFile(path, assetContent);
        else if (oldAsset !== undefined) await this.rollbackChangedFile(path, assetContent, oldAsset);
        throw error;
      }
      const committed = requireMutation(result);
      const storedCheckpoint = committed.task.checkpoints.find((candidate) => candidate.id === checkpoint.id);
      const storedBlock = storedCheckpoint?.blocks.find((candidate) => candidate.id === blockId);
      if (storedBlock === undefined) throw new Error("Committed rich block disappeared");
      return {
        task_id: input.task_id,
        checkpoint_id: checkpoint.id,
        block: storedBlock,
        ...meta(committed, false),
      };
    }));
  }

  async handoff(input: TaskHandoffInput): Promise<TaskHandoffOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () => this.taskMutex.run(input.task_id, async () => {
      const located = await this.findTask(input.task_id);
      if (located.parsed.task.revision !== input.expected_revision) {
        throw versionConflict("Task revision changed", input.expected_revision, located.parsed.task.revision);
      }
      const capsule = resumeFrom(input);
      let result: DocumentMutationResult | undefined;
      await this.vault.process(located.path, (current) => {
        const parsed = this.codec.parse(current, located.path);
        if (parsed.task.revision !== input.expected_revision) {
          throw versionConflict("Task revision changed", input.expected_revision, parsed.task.revision);
        }
        result = this.codec.replaceResume(current, capsule, { path: located.path, updatedAt: this.now() });
        return result.content;
      });
      const committed = requireMutation(result);
      return { task_id: input.task_id, capsule, ...meta(committed, committed.noop) };
    }));
  }

  async finalize(input: TaskFinalizeInput): Promise<TaskFinalizeOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () => this.taskMutex.run(input.task_id, async () => {
      const located = await this.findTask(input.task_id);
      const oldContent = located.content;
      const evidence: Evidence[] = input.evidence.map((entry) => ({
        id: this.idFactory(),
        type: entry.type,
        statement: entry.statement,
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
      }));
      const changed = await this.mutateTask(located.path, input.expected_revision, (task) => {
        const { resume: _resume, ...withoutResume } = task;
        return {
          ...withoutResume,
          state: input.status,
          finalOutcome: input.final_outcome,
          finalEvidence: evidence,
          remaining: [...input.remaining],
        };
      });
      try {
        await this.boardService.updateCard({
          boardId: changed.result.task.boardId,
          taskPath: located.path,
          checked: true,
        });
      } catch (error) {
        if (!changed.result.noop) await this.rollbackChangedFile(located.path, changed.result.content, oldContent);
        throw error;
      }
      return { task: taskSummary(changed.result.task), ...meta(changed.result, changed.result.noop) };
    }));
  }

  private async mutateTask(
    path: string,
    expectedRevision: number,
    transform: (task: TaskDocument) => TaskDocument,
  ): Promise<TaskMutation> {
    let before = "";
    let result: DocumentMutationResult | undefined;
    await this.vault.process(path, (current) => {
      before = current;
      const parsed = this.codec.parse(current, path);
      if (parsed.task.revision !== expectedRevision) {
        throw versionConflict("Task revision changed", expectedRevision, parsed.task.revision);
      }
      const transformed = transform(parsed.task);
      if (canonicalJson(semanticTask(parsed.task)) === canonicalJson(semanticTask(transformed))) {
        result = { ...parsed, content: current, noop: true };
        return current;
      }
      const next: TaskDocument = {
        ...transformed,
        updatedAt: this.now(),
        revision: parsed.task.revision + 1,
      };
      const content = this.codec.create(next);
      result = { ...this.codec.parse(content, path), content, noop: false };
      return content;
    });
    return { before, result: requireMutation(result) };
  }

  private async findTask(taskId: string): Promise<LocatedTask> {
    if (this.boards.length === 0) {
      throw new TaskApiError("PLUGIN_CONFIG_REQUIRED", "Configure at least one task board", {
        action: "configure_plugin",
      });
    }
    const roots = [...new Set(this.boards.map((board) => board.tasksFolder))];
    const files = await this.vault.listMarkdownFiles(roots);
    const matches: LocatedTask[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await this.vault.read(file.path);
      } catch {
        continue;
      }
      try {
        const parsed = this.codec.parse(content, file.path);
        if (parsed.task.taskId === taskId) matches.push({ path: file.path, content, parsed });
      } catch (error) {
        if (error instanceof TaskDocError && error.code === "DOCUMENT_CONFLICT") {
          try {
            const parsed = this.codec.parse(content, file.path, { allowConflicts: true });
            if (parsed.task.taskId === taskId) throw error;
          } catch (inspectionError) {
            if (inspectionError === error) throw error;
          }
        }
      }
    }
    if (matches.length === 0) {
      throw new TaskApiError("TASK_NOT_FOUND", `Task not found: ${taskId}`, { action: "reread" });
    }
    if (matches.length > 1) {
      throw new TaskApiError("DOCUMENT_CONFLICT", `Task ID is duplicated: ${taskId}`, {
        action: "reread",
        details: { paths: matches.map((match) => match.path) },
      });
    }
    const match = matches[0];
    if (match === undefined) throw new Error("Task lookup invariant failed");
    return match;
  }

  private requireBoard(boardId: string): BoardConfig {
    const board = this.boards.find((candidate) => candidate.id === boardId);
    if (board === undefined) {
      throw new TaskApiError("INVALID_INPUT", `Unknown board: ${boardId}`, { action: "revise_input" });
    }
    return board;
  }

  private requireColumn(board: BoardConfig, columnId: string): void {
    if (!board.columns.some((column) => column.id === columnId)) {
      throw new TaskApiError("INVALID_INPUT", `Unknown column ${columnId} on board ${board.id}`, {
        action: "revise_input",
      });
    }
  }

  private assertProfileAllows(task: TaskDocument, checkpoint: CheckpointCore): void {
    if (checkpoint.status !== "done") return;
    const board = this.requireBoard(task.boardId);
    const profile = board.columns.find((column) => column.id === task.columnId)?.profile ?? "other";
    const evidenceTypes = new Set(checkpoint.outcome?.evidence.map((entry) => entry.type) ?? []);
    const verifiedEvidence = (...types: Evidence["type"][]): boolean => types.some((type) => evidenceTypes.has(type));
    let valid = true;
    let message = "";
    if (profile === "bug" && !verifiedEvidence("test", "observation")) {
      valid = false;
      message = "A completed bug checkpoint requires test or observation evidence";
    } else if (profile === "feature" && !verifiedEvidence("test", "observation", "user_acceptance")) {
      valid = false;
      message = "A completed feature checkpoint requires test, observation, or user acceptance evidence";
    } else if (profile === "research" && (
      !verifiedEvidence("source", "observation", "artifact") ||
      ((checkpoint.judgment?.facts?.length ?? 0) + (checkpoint.judgment?.decisions?.length ?? 0) === 0)
    )) {
      valid = false;
      message = "A completed research checkpoint requires a final judgment and source, observation, or artifact evidence";
    } else if (["migration", "configuration", "maintenance"].includes(profile) &&
      !verifiedEvidence("test", "observation", "artifact")) {
      valid = false;
      message = `A completed ${profile} checkpoint requires test, observation, or artifact evidence`;
    }
    if (!valid) {
      throw new TaskApiError("QUALITY_REJECTED", message, {
        action: "revise_input",
        issues: [{ path: "core.outcome.evidence", rule: `profile_${profile}`, message }],
      });
    }
  }

  private async rollbackCreatedFile(path: string, expectedContent: string): Promise<void> {
    try {
      if (!(await this.vault.exists(path))) return;
      if ((await this.vault.read(path)) !== expectedContent) return;
      const deletable = this.vault as VaultAdapter & { delete?: (target: string) => Promise<void> };
      if (typeof deletable.delete === "function") await deletable.delete(path);
    } catch {
      // Best effort only: preserve the original operation error.
    }
  }

  private async rollbackChangedFile(path: string, expectedCurrent: string, previous: string): Promise<void> {
    try {
      await this.vault.process(path, (current) => current === expectedCurrent ? previous : current);
    } catch {
      // Best effort only: preserve the original operation error.
    }
  }

  private async mutation<T>(
    requestId: string,
    payload: unknown,
    _key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.guard(() => this.requestMutex.run(requestId, () => this.idempotency.run(requestId, payload, operation)));
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

function checkpointFrom(
  input: TaskCheckpointCommitInput,
  id: string,
  existing: CheckpointCore | undefined,
): CheckpointCore {
  const core = input.core;
  const checkpoint: CheckpointCore = {
    id,
    revision: existing?.revision ?? 1,
    title: core.title,
    kind: core.kind,
    status: core.status,
    objective: {
      statement: core.objective.statement,
      acceptance: core.objective.acceptance.map((entry) => ({
        id: entry.id,
        statement: entry.statement,
        status: entry.status,
        ...(entry.evidence_refs === undefined ? {} : { evidenceRefs: [...entry.evidence_refs] }),
      })),
    },
    blocks: existing?.blocks ?? [],
  };
  if (core.judgment !== undefined) {
    checkpoint.judgment = {
      ...(core.judgment.facts === undefined ? {} : { facts: core.judgment.facts.map((entry) => ({ ...entry })) }),
      ...(core.judgment.decisions === undefined ? {} : { decisions: [...core.judgment.decisions] }),
      ...(core.judgment.constraints === undefined ? {} : {
        constraints: core.judgment.constraints.map((entry) => ({
          rejectedOption: entry.rejected_option,
          verifiedReason: entry.verified_reason,
          scope: entry.scope,
          impact: entry.impact,
          evidenceRefs: [...entry.evidence_refs],
          ...(entry.reconsider_when === undefined ? {} : { reconsiderWhen: entry.reconsider_when }),
        })),
      }),
    };
  }
  if (core.outcome !== undefined) {
    checkpoint.outcome = {
      summary: core.outcome.summary,
      evidence: core.outcome.evidence.map((entry) => ({
        id: entry.id,
        type: entry.type,
        statement: entry.statement,
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
      })),
      ...(core.outcome.residual_risks === undefined ? {} : { residualRisks: [...core.outcome.residual_risks] }),
    };
  }
  if (core.blocker !== undefined) checkpoint.blocker = core.blocker;
  if (core.unblock_condition !== undefined) checkpoint.unblockCondition = core.unblock_condition;
  if (core.cancellation !== undefined) checkpoint.cancellation = { ...core.cancellation };
  if (core.superseded_by !== undefined) checkpoint.supersededBy = core.superseded_by;
  return checkpoint;
}

function resumeFrom(input: TaskHandoffInput): ResumeCapsule {
  const capsule = input.capsule;
  const workspaceRef = capsule.workspace_ref === undefined ? undefined : {
    ...(capsule.workspace_ref.repo === undefined ? {} : { repo: capsule.workspace_ref.repo }),
    ...(capsule.workspace_ref.branch === undefined ? {} : { branch: capsule.workspace_ref.branch }),
    ...(capsule.workspace_ref.commit === undefined ? {} : { commit: capsule.workspace_ref.commit }),
  };
  return {
    focusCheckpointId: capsule.focus_checkpoint_id,
    basedOnRevision: capsule.based_on_revision,
    ...(capsule.last_verified === undefined ? {} : { lastVerified: capsule.last_verified }),
    nextAction: capsule.next_action,
    blockers: capsule.blockers.map((entry) => ({ statement: entry.statement, unblockWhen: entry.unblock_when })),
    openQuestions: [...capsule.open_questions],
    workingArtifacts: capsule.working_artifacts.map((entry) => ({ ...entry })),
    ...(workspaceRef === undefined ? {} : { workspaceRef }),
  };
}

function richBlockFrom(
  input: TaskBlockPutInput,
  id: string,
  path: string,
  revision: number,
): RichBlockInput {
  return {
    id,
    revision,
    kind: input.block.kind,
    title: input.block.title,
    summary: input.block.summary,
    supports: input.block.supports,
    content: input.block.content,
    path,
    ...(input.block.checklist_scope === undefined ? {} : { checklistScope: input.block.checklist_scope }),
    ...(input.block.source_uri === undefined ? {} : { sourceUri: input.block.source_uri }),
    ...(input.block.language === undefined ? {} : { language: input.block.language }),
  };
}

function validationFrom(source: SettingsSource): ValidationOptions {
  if (Array.isArray(source)) return {};
  const settings = source as TaskDocSettings;
  return {
    strictQuality: settings.strictQuality,
    coreCharLimit: settings.coreCharLimit,
    blockCharLimit: settings.blockCharLimit,
    totalBlockCharLimit: settings.totalBlockCharLimit,
    resumeCharLimit: settings.resumeCharLimit,
  };
}

function boardsFrom(source: SettingsSource): readonly BoardConfig[] {
  return Array.isArray(source) ? source : (source as TaskDocSettings).boards;
}

function taskPath(folder: string, title: string, taskId: string): string {
  const slug = title
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60) || "task";
  return `${folder.replace(/[\\/]+$/g, "")}/${slug}-${taskId}.md`;
}

function blockPath(taskDocument: string, checkpointId: string, blockId: string): string {
  const withoutExtension = taskDocument.replace(/\.md$/i, "");
  return `${withoutExtension}.assets/${checkpointId}/${blockId}.md`;
}

function boardRevisionNumber(revision: string): number {
  const hex = revision.replace(/^sha256:/, "").slice(0, 12);
  return Number.parseInt(hex, 16);
}

function semanticTask(task: TaskDocument): unknown {
  const { revision: _revision, updatedAt: _updatedAt, ...semantic } = task;
  return semantic;
}

function taskSummary(task: TaskDocument): TaskCardUpdateOutput["task"] {
  return {
    taskId: task.taskId,
    boardId: task.boardId,
    columnId: task.columnId,
    title: task.title,
    state: task.state,
    path: task.path,
    revision: task.revision,
  };
}

function meta(
  parsed: Pick<ReturnType<DocumentCodec["parse"]>, "task" | "documentHash">,
  noop: boolean,
): MutationResultMeta {
  return {
    document_revision: parsed.task.revision,
    document_hash: parsed.documentHash,
    pha_sync: "unbound",
    ...(noop ? { noop: true } : {}),
  };
}

function requireMutation(value: DocumentMutationResult | undefined): DocumentMutationResult {
  if (value === undefined) throw new Error("Vault process did not execute its mutation callback");
  return value;
}

function versionConflict(message: string, expected: number, actual: number): TaskApiError {
  return new TaskApiError("VERSION_CONFLICT", message, {
    action: "reread",
    details: { expected_revision: expected, actual_revision: actual },
  });
}

function checkpointNotFound(id: string): TaskApiError {
  return new TaskApiError("CHECKPOINT_NOT_FOUND", `Checkpoint not found: ${id}`, { action: "reread" });
}

function normalizeError(error: unknown): TaskApiError {
  if (error instanceof TaskApiError) return error;
  if (error instanceof TaskDocError) {
    const action = error.code === "VERSION_CONFLICT" || error.code === "DOCUMENT_CONFLICT"
      ? "reread"
      : error.code === "QUALITY_REJECTED" || error.code === "INVALID_INPUT"
        ? "revise_input"
        : error.code === "PLUGIN_CONFIG_REQUIRED"
          ? "configure_plugin"
          : error.code === "IO_BUSY"
            ? "retry_same_request"
            : "none";
    return new TaskApiError(error.code, error.message, {
      action,
      retryable: error.code === "IO_BUSY",
      ...(error.issues === undefined ? {} : {
        issues: error.issues.map(({ path, rule, message }) => ({ path, rule, message })),
      }),
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
      cause: error,
    });
  }
  if (error instanceof BoardRevisionConflictError) {
    return new TaskApiError("VERSION_CONFLICT", error.message, {
      action: "reread",
      details: { expected_revision: error.expected, actual_revision: error.actual },
      cause: error,
    });
  }
  if (error instanceof BoardNotFoundError || error instanceof BoardColumnNotFoundError) {
    return new TaskApiError("INVALID_INPUT", error.message, { action: "revise_input", cause: error });
  }
  if (error instanceof BoardCardNotFoundError || error instanceof BrokenTaskLinkError) {
    return new TaskApiError("TASK_NOT_FOUND", error.message, { action: "reread", cause: error });
  }
  if (error instanceof DuplicateBoardCardError) {
    return new TaskApiError("DOCUMENT_CONFLICT", error.message, { action: "reread", cause: error });
  }
  if (error instanceof Error && error.message.startsWith("IDEMPOTENCY_CONFLICT:")) {
    return new TaskApiError("IDEMPOTENCY_CONFLICT", error.message.replace(/^IDEMPOTENCY_CONFLICT:\s*/, ""), {
      action: "revise_input",
      cause: error,
    });
  }
  if (error instanceof KanbanError) {
    return new TaskApiError("IO_ERROR", error.message, { action: "retry_same_request", retryable: true, cause: error });
  }
  if (error instanceof VaultIoError) {
    return new TaskApiError(error.code, error.message, {
      action: error.retryable ? "retry_same_request" : "reread",
      retryable: error.retryable,
      details: { operation: error.operation },
      cause: error,
    });
  }
  return new TaskApiError("INTERNAL_ERROR", "Internal task service error", {
    action: "none",
    retryable: false,
    cause: error,
  });
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor?: string } {
  const offset = parseCursor(cursor);
  if (limit === 0) return { items: [] };
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { items: page, ...(next < items.length ? { nextCursor: String(next) } : {}) };
}

function paginateText(content: string, cursor: string | undefined, limit: number): { content: string; nextCursor?: string } {
  const chars = Array.from(content);
  const offset = parseCursor(cursor);
  if (offset > chars.length) {
    throw new TaskApiError("INVALID_INPUT", "Cursor is beyond the rich block", { action: "revise_input" });
  }
  const page = chars.slice(offset, offset + limit).join("");
  const next = offset + Array.from(page).length;
  return { content: page, ...(next < chars.length ? { nextCursor: String(next) } : {}) };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new TaskApiError("INVALID_INPUT", "Cursor is invalid", { action: "revise_input" });
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new TaskApiError("INVALID_INPUT", "Cursor is outside the supported range", { action: "revise_input" });
  }
  return value;
}
