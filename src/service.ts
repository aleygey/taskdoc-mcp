import { isTerminal, VaultIoError } from "./types.js";
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
import { KeyedMutex } from "./util/concurrency.js";
import { newId } from "./util/id.js";
import { TaskIndex } from "./task-index.js";
import { MutationStore, type RuntimeStore } from "./persistence.js";
import {
  upgradeTask,
  assessAcceptance,
  durableContext,
  markResumeStale,
  replaceTaskEvidence,
} from "./core/task.js";
import { parseBoard } from "./kanban/parser.js";
import { taskPathIdentity } from "./kanban/paths.js";
import { validateTaskDocument } from "./core/validation.js";
import type { TaskUpdateInput, TaskReconcileInput } from "./mcp/schemas.js";
import type { TaskReconcileOutput } from "./mcp/api.js";

export interface TaskServiceOptions {
  persistence?: RuntimeStore;
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
  private readonly mutations: MutationStore;
  private readonly index: TaskIndex;
  private readonly vault: VaultAdapter;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    vault: VaultAdapter,
    settingsOrBoards: SettingsSource,
    options: TaskServiceOptions = {},
  ) {
    this.boards = structuredClone([...boardsFrom(settingsOrBoards)]);
    this.mutations = new MutationStore(vault, options.persistence, (path) =>
      this.index?.notify(path),
    );
    this.vault = this.mutations.vault;
    this.index = new TaskIndex(
      vault,
      this.boards.map((b) => b.tasksFolder),
    );
    this.boardService = new BoardService(this.vault, this.boards);
    this.codec = new DocumentCodec(
      options.validation ?? validationFrom(settingsOrBoards),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? newId;
  }

  setBoards(boards: readonly BoardConfig[]): void {
    this.boardService.setBoards(boards);
    this.boards = structuredClone([...boards]);
    this.index.reset(this.boards.map((b) => b.tasksFolder));
  }

  setSettings(settings: TaskDocSettings): void {
    this.setBoards(settings.boards);
    this.codec = new DocumentCodec(validationFrom(settings));
  }

  notifyFileChanged(path: string, previousPath?: string): void {
    this.index.notify(path, previousPath);
  }
  async pendingRecovery() {
    return this.mutations.pending();
  }
  async recoverPendingWrites(): Promise<void> {
    await this.mutations.recover();
    this.index.reset(this.boards.map((b) => b.tasksFolder));
  }
  async boardDiagnostics(boardId: string) {
    return this.boardService.reconcileReport(boardId);
  }
  async taskAtPath(path: string): Promise<TaskDocument> {
    return this.codec.parseTask(await this.vault.read(path), path);
  }

  async catalog(_input: TaskCatalogInput): Promise<TaskCatalogOutput> {
    return this.guard(async () => {
      const entries = await this.boardService.catalog();
      return {
        boards: entries.map((entry) => ({
          ...(this.boards.find((b) => b.id === entry.id) ?? {}),
          id: entry.id,
          name: entry.name,
          projectId: entry.projectId,
          file: entry.file,
          tasksFolder: entry.tasksFolder,
          autoConvertCards: entry.autoConvertCards,
          columns: entry.columns.map(
            ({ id, heading, typeId, profile, state }) => ({
              id,
              heading,
              typeId,
              profile,
              ...(state ? { state } : {}),
            }),
          ),
          ...(entry.defaultColumnId === undefined
            ? {}
            : { defaultColumnId: entry.defaultColumnId }),
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
      const diagnostics: NonNullable<TaskQueryOutput["diagnostics"]> = [];
      const seen = new Set<string>();
      for (const card of cards) {
        if (card.taskPath === undefined) {
          diagnostics.push({
            path: card.boardFile,
            code: "UNLINKED_CARD",
            message: card.title,
          });
          continue;
        }
        try {
          const task = this.codec.parseTask(
            await this.vault.read(card.taskPath),
            card.taskPath,
          );
          const mismatch =
            task.boardId !== card.boardId ||
            (!card.archived && task.columnId !== card.columnId) ||
            isTerminal(task.state) !== (card.state === "done") ||
            Boolean(task.archived) !== Boolean(card.archived);
          if (mismatch)
            diagnostics.push({
              path: task.path,
              code: "CARD_CONFLICT",
              message:
                "Card and task disagree. Preview task_reconcile before applying either source.",
            });
          if (seen.has(task.taskId)) {
            diagnostics.push({
              path: task.path,
              code: "DUPLICATE_CARD",
              message: "Task is linked more than once",
            });
            continue;
          }
          seen.add(task.taskId);
          if (input.state !== undefined && task.state !== input.state) continue;
          if (
            input.archived !== undefined &&
            Boolean(task.archived) !== input.archived
          )
            continue;
          tasks.push({
            task_id: task.taskId,
            board_id: task.boardId,
            column_id: task.columnId,
            title: task.title,
            state: task.state,
            path: task.path,
            revision: task.revision,
            archived: task.archived ?? false,
            ...(task.typeId ? { type_id: task.typeId } : {}),
            card: {
              ...(card.columnId ? { column_id: card.columnId } : {}),
              checked: card.state === "done",
              archived: card.archived ?? false,
            },
          });
        } catch (error) {
          const normalized = normalizeError(error);
          diagnostics.push({
            path: card.taskPath,
            code: normalized.code,
            message: normalized.message,
          });
        }
      }
      tasks.sort((left, right) => left.path.localeCompare(right.path));
      const page = paginate(tasks, input.cursor, input.limit, 28_000);
      return {
        tasks: page.items,
        diagnostics: diagnostics.slice(0, 50),
        diagnostics_total: diagnostics.length,
        diagnostics_truncated: diagnostics.length > 50,
        ...(page.nextCursor === undefined
          ? {}
          : { next_cursor: page.nextCursor }),
      };
    });
  }

  async resume(input: TaskResumeInput): Promise<TaskResumeOutput> {
    return this.guard(async () => {
      const { parsed } = await this.findTask(input.task_id);
      const task = parsed.task;
      const active = task.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "active" || checkpoint.status === "blocked",
      );
      const completed = task.checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.status !== "active" && checkpoint.status !== "blocked",
        )
        .map((checkpoint) => ({
          id: checkpoint.id,
          title: checkpoint.title,
          status: checkpoint.status,
          revision: checkpoint.revision,
          ...(checkpoint.outcome?.summary === undefined
            ? {}
            : { outcome: checkpoint.outcome.summary }),
        }));
      const page = paginate(completed, input.cursor, input.completed_limit);
      const context = paginate(
        durableContext(task),
        input.context_cursor,
        input.context_limit ?? 20,
        12_000,
      );
      const omitActive =
        Buffer.byteLength(JSON.stringify(active), "utf8") > 18_000;
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
        active_checkpoints: omitActive ? [] : active,
        ...(omitActive
          ? {
              active_checkpoint_details_omitted: true,
              active_checkpoint_outline: active.map(
                ({ id, title, status, revision }) => ({
                  id,
                  title,
                  status,
                  revision,
                }),
              ),
              next_action:
                "Read each active_checkpoint_outline ID with task_read view=checkpoint before continuing",
            }
          : {}),
        context: context.items,
        context_complete: context.nextCursor === undefined,
        ...(context.nextCursor
          ? { context_next_cursor: context.nextCursor }
          : {}),
        handoff_status: task.resume
          ? task.resume.stale
            ? "stale"
            : "current"
          : "missing",
        acceptance_items: upgradeTask(task).acceptanceItems ?? [],
        evidence: task.evidence ?? task.finalEvidence ?? [],
        completed_outline: page.items,
        ...(task.resume === undefined ? {} : { capsule: task.resume }),
        ...(page.nextCursor === undefined
          ? {}
          : { next_cursor: page.nextCursor }),
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
          ...(checkpoint.outcome?.summary === undefined
            ? {}
            : { outcome: checkpoint.outcome.summary }),
        }));
        const page = paginate(
          checkpointOutlines,
          input.cursor,
          input.checkpoint_limit,
        );
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
            ...(task.finalOutcome === undefined
              ? {}
              : { finalOutcome: task.finalOutcome }),
            ...(task.remaining === undefined
              ? {}
              : { remaining: task.remaining }),
            acceptanceItems: upgradeTask(task).acceptanceItems ?? [],
            evidence: task.evidence ?? task.finalEvidence ?? [],
            archived: task.archived ?? false,
            ...(task.typeId ? { typeId: task.typeId } : {}),
            ...(task.legacyAcceptanceReview
              ? { legacyAcceptanceReview: true }
              : {}),
            checkpoints: page.items,
            ...(page.nextCursor === undefined
              ? {}
              : { next_cursor: page.nextCursor }),
          },
        };
      }

      const checkpoint = parsed.task.checkpoints.find(
        (candidate) => candidate.id === input.checkpoint_id,
      );
      if (checkpoint === undefined)
        throw checkpointNotFound(input.checkpoint_id ?? "");
      if (input.view === "checkpoint")
        return { view: "checkpoint", checkpoint };

      const manifest = checkpoint.blocks.find(
        (candidate) => candidate.id === input.block_id,
      );
      if (manifest === undefined) {
        throw new TaskApiError(
          "INVALID_INPUT",
          `Rich block not found: ${input.block_id ?? ""}`,
          {
            action: "reread",
          },
        );
      }
      const source = await this.vault.read(manifest.path);
      if (sha256(source) !== manifest.contentHash) {
        throw new TaskApiError(
          "DOCUMENT_CONFLICT",
          "Rich block content no longer matches its manifest",
          {
            action: "reread",
            details: { block_id: manifest.id, path: manifest.path },
          },
        );
      }
      const page = paginateText(source, input.cursor, input.max_chars);
      return {
        view: "block",
        block: {
          manifest,
          content: page.content,
          ...(page.nextCursor === undefined
            ? {}
            : { next_cursor: page.nextCursor }),
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
        throw versionConflict(
          "Board revision changed",
          input.expected_board_revision,
          boardRevisionNumber(snapshot.revision),
        );
      }

      const taskId = this.idFactory();
      const path = taskPath(board.tasksFolder, input.title, taskId);
      const timestamp = this.now();
      const task: TaskDocument = {
        schema: "checkpoint/v2",
        taskId,
        boardId: board.id,
        columnId: input.column_id,
        title: input.title,
        state:
          input.state ??
          (board.columnMode === "state"
            ? (board.columns.find((c) => c.id === input.column_id)?.state ??
              "active")
            : "active"),
        archived: false,
        typeId:
          input.type_id ??
          (board.columnMode === "state"
            ? (board.taskTypes?.[0]?.id ?? "other")
            : board.columns.find((c) => c.id === input.column_id)!.typeId),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
        ...(input.unblock_condition === undefined
          ? {}
          : { unblockCondition: input.unblock_condition }),
        createdAt: timestamp,
        updatedAt: timestamp,
        objective: input.objective,
        acceptance: [...input.acceptance],
        acceptanceItems: input.acceptance.map((statement, i) => ({
          id: `AC-${i + 1}`,
          statement,
          status: "pending",
        })),
        evidence: [],
        checkpoints: [],
        path,
        revision: 1,
      };
      this.alignColumn(task, board);
      const content = this.codec.create(task);
      if (await this.vault.exists(path)) {
        throw new TaskApiError(
          "DOCUMENT_CONFLICT",
          `Task path already exists: ${path}`,
          { action: "reread" },
        );
      }
      await this.vault.create(path, content);
      try {
        await this.boardService.createCard({
          boardId: board.id,
          columnId: task.columnId,
          taskPath: path,
          title: task.title,
          expectedRevision: snapshot.revision,
        });
      } catch (error) {
        await this.rollbackCreatedFile(path, content);
        throw error;
      }
      const parsed = this.codec.parse(content, path);
      this.index.record(taskId, path);
      return { task: parsed.task, ...meta(parsed, false) };
    });
  }

  async cardUpdate(input: TaskCardUpdateInput): Promise<TaskCardUpdateOutput> {
    const result = await this.update({
      ...input,
      reason: input.state
        ? "Reopened from task_card_update"
        : "Card type changed",
    });
    return { ...result, task: taskSummary(result.task) };
  }

  async update(input: TaskUpdateInput): Promise<TaskCreateOutput> {
    return this.mutation(input.request_id, input, "update", async () => {
      const located = await this.findTask(input.task_id);
      const changed = await this.mutateTask(
        located.path,
        input.expected_revision,
        (current) => {
          const task = upgradeTask(current);
          if (
            isTerminal(task.state) &&
            input.state === undefined &&
            (input.objective !== undefined ||
              input.acceptance !== undefined ||
              input.assessments !== undefined ||
              input.evidence !== undefined)
          ) {
            throw new TaskApiError(
              "INVALID_INPUT",
              "Reopen the task before changing its acceptance or evidence",
              { action: "revise_input" },
            );
          }
          if (input.title !== undefined) task.title = input.title;
          if (input.objective !== undefined) task.objective = input.objective;
          if (input.acceptance !== undefined) {
            task.acceptanceItems = input.acceptance.map((item) => {
              const old = task.acceptanceItems?.find((a) => a.id === item.id);
              return old?.statement === item.statement
                ? old
                : { ...item, status: "pending" as const };
            });
            task.acceptance = task.acceptanceItems.map((a) => a.statement);
          }
          if (
            input.objective !== undefined &&
            input.objective !== current.objective
          ) {
            task.acceptanceItems = (task.acceptanceItems ?? []).map((a) => ({
              id: a.id,
              statement: a.statement,
              status: "pending",
            }));
          }
          if (input.state !== undefined) {
            if (isTerminal(task.state)) {
              delete task.finalOutcome;
              delete task.finalEvidence;
              delete task.remaining;
              delete task.legacyAcceptanceReview;
              task.acceptanceItems = (task.acceptanceItems ?? []).map((a) => ({
                id: a.id,
                statement: a.statement,
                status: "pending",
              }));
              task.archived = false;
            }
            task.state = input.state;
          }
          if (input.blocker !== undefined) task.blocker = input.blocker;
          if (input.unblock_condition !== undefined)
            task.unblockCondition = input.unblock_condition;
          if (task.state !== "blocked") {
            delete task.blocker;
            delete task.unblockCondition;
          }
          if (input.archived !== undefined) task.archived = input.archived;
          if (input.column_id !== undefined) task.columnId = input.column_id;
          if (input.type_id !== undefined) task.typeId = input.type_id;
          if (input.evidence !== undefined)
            replaceTaskEvidence(
              task,
              input.evidence.map((e) => ({
                id: e.id,
                type: e.type,
                statement: e.statement,
                ...(e.ref === undefined ? {} : { ref: e.ref }),
              })),
            );
          if (input.assessments) assessAcceptance(task, input.assessments);
          this.alignColumn(
            task,
            this.requireBoard(task.boardId),
            input.column_id !== undefined,
            input.state !== undefined,
          );
          markResumeStale(task, "任务范围、状态或验收已修改，请核对下一步");
          task.amendments = [
            ...(task.amendments ?? []),
            {
              at: this.now(),
              reason: input.reason,
              fields: Object.keys(input).filter(
                (k) =>
                  ![
                    "schema_version",
                    "request_id",
                    "task_id",
                    "expected_revision",
                    "reason",
                  ].includes(k),
              ),
            },
          ].slice(-20);
          return task;
        },
      );
      await this.syncCard(changed.result.task);
      return {
        task: changed.result.task,
        ...meta(changed.result, changed.result.noop),
      };
    });
  }

  async reconcile(input: TaskReconcileInput): Promise<TaskReconcileOutput> {
    const perform = async (): Promise<TaskReconcileOutput> => {
      const located = await this.findTask(input.task_id);
      const task = upgradeTask(located.parsed.task);
      const board = this.requireBoard(task.boardId);
      const snapshot = await this.boardService.snapshot(board.id);
      const revision = boardRevisionNumber(snapshot.revision);
      const cards = [
        ...snapshot.board.columns,
        ...(snapshot.board.archive ? [snapshot.board.archive] : []),
      ]
        .flatMap((column) =>
          column.cards.map((card) => ({
            card,
            archived: column === snapshot.board.archive,
          })),
        )
        .filter(
          ({ card }) =>
            card.link &&
            taskPathIdentity(card.link.documentPath) ===
              taskPathIdentity(task.path),
        );
      const changes: string[] = [];
      let canApply = cards.length <= 1;
      if (cards.length > 1)
        changes.push(
          "Duplicate linked cards must be resolved before reconciliation",
        );
      const linked = cards[0];
      if (!linked) {
        changes.push("Restore the missing linked card from the task document");
        if (input.direction === "board_to_document") canApply = false;
      } else if (input.direction === "document_to_board") {
        if (linked.card.columnId !== task.columnId && !linked.archived)
          changes.push(`Move card to ${task.columnId}`);
        if (linked.card.checked !== isTerminal(task.state))
          changes.push(`Set card checkbox to ${isTerminal(task.state)}`);
        if (linked.archived !== Boolean(task.archived))
          changes.push(`Set archive to ${Boolean(task.archived)}`);
        if (linked.card.link?.alias !== task.title)
          changes.push("Update card title from task document");
      } else {
        if (linked.archived && !isTerminal(task.state)) {
          changes.push("Complete or cancel the task before adopting archive");
          canApply = false;
        }
        if (linked.card.checked && !isTerminal(task.state)) {
          changes.push(
            "A checked card cannot bypass task acceptance; use task_finalize",
          );
          canApply = false;
        }
        if (!linked.archived && linked.card.columnId !== task.columnId)
          changes.push("Adopt the card's configured column");
        if (!linked.card.checked && isTerminal(task.state))
          changes.push("Reopen task as active");
        if (Boolean(task.archived) !== linked.archived)
          changes.push("Adopt card archive state");
        if (!linked.archived && !linked.card.columnId) {
          changes.push("Map the card column in settings first");
          canApply = false;
        }
      }
      if (input.mode === "apply") {
        if (!canApply)
          throw new TaskApiError("DOCUMENT_CONFLICT", changes.join("; "), {
            action: "revise_input",
          });
        if (
          input.expected_revision !== task.revision ||
          input.expected_board_revision !== revision
        )
          throw versionConflict(
            "Reconciliation preview is stale",
            input.expected_revision ?? 0,
            task.revision,
          );
        if (input.direction === "document_to_board") {
          if (!linked)
            await this.boardService.createCard({
              boardId: board.id,
              columnId: task.columnId,
              taskPath: task.path,
              title: task.title,
              checked: isTerminal(task.state),
              expectedRevision: snapshot.revision,
            });
          await this.syncCard(task, linked ? snapshot.revision : undefined);
        } else if (linked && changes.length) {
          const changed = await this.mutateTask(
            task.path,
            task.revision,
            (current) => {
              const next = upgradeTask(current);
              if (!linked.card.checked && isTerminal(next.state)) {
                next.state = "active";
                delete next.finalOutcome;
                delete next.finalEvidence;
                delete next.remaining;
                delete next.legacyAcceptanceReview;
                next.acceptanceItems = (next.acceptanceItems ?? []).map(
                  (a) => ({
                    id: a.id,
                    statement: a.statement,
                    status: "pending",
                  }),
                );
              }
              if (linked.card.columnId) next.columnId = linked.card.columnId;
              next.archived = linked.archived;
              this.alignColumn(next, board, !linked.archived);
              markResumeStale(next, "已采用看板变更，请复核接续点");
              return next;
            },
          );
          await this.syncCard(changed.result.task, snapshot.revision);
          task.revision = changed.result.task.revision;
        }
      }
      return {
        task_id: task.taskId,
        document_revision: task.revision,
        board_revision:
          input.mode === "apply"
            ? boardRevisionNumber(
                (await this.boardService.snapshot(board.id)).revision,
              )
            : revision,
        direction: input.direction,
        changes,
        can_apply: canApply,
        applied: input.mode === "apply",
      };
    };
    return input.mode === "apply"
      ? this.mutation(input.request_id ?? "", input, "reconcile", perform)
      : this.guard(perform);
  }

  async previewDocumentRecovery(path: string) {
    const content = await this.vault.read(path);
    const parsed = this.codec.parse(content, path, { allowConflicts: true });
    return {
      hash: sha256(content),
      task: parsed.task,
      conflicts: parsed.conflicts,
      content,
      recovered: this.codec.create(upgradeTask(parsed.task)),
    };
  }

  async restoreManagedDocument(
    path: string,
    expectedHash: string,
    requestId: string,
  ): Promise<string> {
    return this.mutation(
      requestId,
      { path, expectedHash },
      "restore",
      async () => {
        const preview = await this.previewDocumentRecovery(path);
        if (preview.hash !== expectedHash)
          throw new TaskApiError(
            "DOCUMENT_CONFLICT",
            "Document changed since preview",
            { action: "reread" },
          );
        const backup = `TaskDoc Backups/${preview.task.taskId}-${this.idFactory()}.txt`;
        await this.vault.create(backup, preview.content);
        await this.vault.process(path, (current) => {
          if (sha256(current) !== expectedHash)
            throw new TaskApiError(
              "DOCUMENT_CONFLICT",
              "Document changed since preview",
              { action: "reread" },
            );
          const task = upgradeTask(preview.task);
          task.revision++;
          task.updatedAt = this.now();
          markResumeStale(task, "受管文档已恢复，请检查备份中的人工修改");
          return this.codec.create(task);
        });
        this.index.notify(path);
        return backup;
      },
    );
  }

  async checkpointCommit(
    input: TaskCheckpointCommitInput,
  ): Promise<TaskCheckpointCommitOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () =>
      this.taskMutex.run(input.task_id, async () => {
        const located = await this.findTask(input.task_id);
        if (isTerminal(located.parsed.task.state))
          throw new TaskApiError(
            "INVALID_INPUT",
            "Reopen the task before changing completed evidence",
            { action: "revise_input" },
          );
        const checkpointId = input.checkpoint_id ?? this.idFactory();
        const existing = located.parsed.task.checkpoints.find(
          (checkpoint) => checkpoint.id === checkpointId,
        );
        if (existing === undefined && input.expected_revision !== 0) {
          throw versionConflict(
            "New checkpoint revision must be 0",
            input.expected_revision,
            0,
          );
        }
        if (existing !== undefined && input.checkpoint_id === undefined) {
          throw new TaskApiError(
            "DOCUMENT_CONFLICT",
            `Generated checkpoint ID already exists: ${checkpointId}`,
            {
              action: "retry_same_request",
              retryable: true,
            },
          );
        }
        const checkpoint = checkpointFrom(input, checkpointId, existing);
        this.assertProfileAllows(located.parsed.task, checkpoint);
        let result: DocumentMutationResult | undefined;
        await this.vault.process(located.path, (current) => {
          result =
            existing === undefined
              ? this.codec.createCheckpoint(current, checkpoint, {
                  path: located.path,
                  updatedAt: this.now(),
                })
              : this.codec.replaceCheckpoint(current, checkpoint, {
                  path: located.path,
                  expectedCheckpointRevision: input.expected_revision,
                  updatedAt: this.now(),
                });
          return result.content;
        });
        const committed = requireMutation(result);
        const stored = committed.task.checkpoints.find(
          (candidate) => candidate.id === checkpointId,
        );
        if (stored === undefined)
          throw new Error("Committed checkpoint disappeared");
        return {
          task_id: input.task_id,
          checkpoint: stored,
          ...meta(committed, committed.noop),
        };
      }),
    );
  }

  async blockPut(input: TaskBlockPutInput): Promise<TaskBlockPutOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () =>
      this.taskMutex.run(input.task_id, async () => {
        const located = await this.findTask(input.task_id);
        if (isTerminal(located.parsed.task.state))
          throw new TaskApiError(
            "INVALID_INPUT",
            "Reopen the task before changing completed evidence",
            { action: "revise_input" },
          );
        const checkpoint = located.parsed.task.checkpoints.find(
          (candidate) => candidate.id === input.checkpoint_id,
        );
        if (checkpoint === undefined)
          throw checkpointNotFound(input.checkpoint_id);
        const blockId = input.block_id ?? this.idFactory();
        const existing = checkpoint.blocks.find(
          (candidate) => candidate.id === blockId,
        );
        if (existing === undefined && input.expected_revision !== 0) {
          throw versionConflict(
            "New rich block revision must be 0",
            input.expected_revision,
            0,
          );
        }
        if (
          existing !== undefined &&
          existing.revision !== input.expected_revision
        ) {
          throw versionConflict(
            "Rich block revision changed",
            input.expected_revision,
            existing.revision,
          );
        }

        const path =
          existing?.path ?? blockPath(located.path, checkpoint.id, blockId);
        const base = richBlockFrom(
          input,
          blockId,
          path,
          existing?.revision ?? 1,
        );
        const currentAsset =
          existing === undefined ? undefined : await this.vault.read(path);
        if (
          existing !== undefined &&
          sha256(currentAsset ?? "") !== existing.contentHash
        ) {
          throw new TaskApiError(
            "DOCUMENT_CONFLICT",
            "Rich block was modified outside TaskDoc MCP",
            {
              action: "reread",
              details: { block_id: blockId, path },
            },
          );
        }
        const same =
          existing !== undefined &&
          currentAsset === renderRichBlock(base, this.codec.validationOptions);
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
        const assetContent = renderRichBlock(
          richBlock,
          this.codec.validationOptions,
        );
        let oldAsset: string | undefined;
        if (existing === undefined) {
          if (await this.vault.exists(path)) {
            throw new TaskApiError(
              "DOCUMENT_CONFLICT",
              `Rich block path already exists: ${path}`,
              { action: "reread" },
            );
          }
          await this.vault.create(path, assetContent);
        } else {
          await this.vault.process(path, (current) => {
            if (sha256(current) !== existing.contentHash) {
              throw new TaskApiError(
                "DOCUMENT_CONFLICT",
                "Rich block changed before it could be replaced",
                {
                  action: "reread",
                  details: { block_id: blockId, path },
                },
              );
            }
            oldAsset = current;
            return assetContent;
          });
        }

        let result: DocumentMutationResult | undefined;
        try {
          const manifest = createBlockManifest(
            richBlock,
            this.codec.validationOptions,
          );
          await this.vault.process(located.path, (current) => {
            const latest = this.codec.parse(current, located.path);
            const latestCheckpoint = latest.task.checkpoints.find(
              (candidate) => candidate.id === checkpoint.id,
            );
            if (latestCheckpoint === undefined)
              throw checkpointNotFound(checkpoint.id);
            if (latestCheckpoint.revision !== checkpoint.revision) {
              throw versionConflict(
                "Checkpoint changed while storing rich block",
                checkpoint.revision,
                latestCheckpoint.revision,
              );
            }
            const latestBlock = latestCheckpoint.blocks.find(
              (candidate) => candidate.id === blockId,
            );
            if (existing === undefined && latestBlock !== undefined) {
              throw new TaskApiError(
                "DOCUMENT_CONFLICT",
                `Rich block already exists: ${blockId}`,
                { action: "reread" },
              );
            }
            if (
              existing !== undefined &&
              (latestBlock === undefined ||
                latestBlock.revision !== existing.revision ||
                latestBlock.contentHash !== existing.contentHash)
            ) {
              throw versionConflict(
                "Rich block manifest changed",
                existing.revision,
                latestBlock?.revision ?? 0,
              );
            }
            const blocks =
              existing === undefined
                ? [...latestCheckpoint.blocks, manifest]
                : latestCheckpoint.blocks.map((candidate) =>
                    candidate.id === blockId ? manifest : candidate,
                  );
            result = this.codec.replaceCheckpoint(
              current,
              { ...latestCheckpoint, blocks },
              {
                path: located.path,
                expectedCheckpointRevision: latestCheckpoint.revision,
                updatedAt: this.now(),
              },
            );
            return result.content;
          });
        } catch (error) {
          if (existing === undefined)
            await this.rollbackCreatedFile(path, assetContent);
          else if (oldAsset !== undefined)
            await this.rollbackChangedFile(path, assetContent, oldAsset);
          throw error;
        }
        const committed = requireMutation(result);
        const storedCheckpoint = committed.task.checkpoints.find(
          (candidate) => candidate.id === checkpoint.id,
        );
        const storedBlock = storedCheckpoint?.blocks.find(
          (candidate) => candidate.id === blockId,
        );
        if (storedBlock === undefined)
          throw new Error("Committed rich block disappeared");
        return {
          task_id: input.task_id,
          checkpoint_id: checkpoint.id,
          block: storedBlock,
          ...meta(committed, false),
        };
      }),
    );
  }

  async handoff(input: TaskHandoffInput): Promise<TaskHandoffOutput> {
    return this.mutation(input.request_id, input, input.task_id, async () =>
      this.taskMutex.run(input.task_id, async () => {
        const located = await this.findTask(input.task_id);
        if (located.parsed.task.revision !== input.expected_revision) {
          throw versionConflict(
            "Task revision changed",
            input.expected_revision,
            located.parsed.task.revision,
          );
        }
        const capsule = resumeFrom(input);
        const basis = capsule.focusCheckpointId
          ? located.parsed.task.checkpoints.find(
              (c) => c.id === capsule.focusCheckpointId,
            )?.revision
          : located.parsed.task.revision;
        if (basis !== capsule.basedOnRevision)
          throw versionConflict(
            "Handoff basis changed",
            capsule.basedOnRevision,
            basis ?? 0,
          );
        let result: DocumentMutationResult | undefined;
        await this.vault.process(located.path, (current) => {
          const parsed = this.codec.parse(current, located.path);
          if (parsed.task.revision !== input.expected_revision) {
            throw versionConflict(
              "Task revision changed",
              input.expected_revision,
              parsed.task.revision,
            );
          }
          result = this.codec.replaceResume(current, capsule, {
            path: located.path,
            updatedAt: this.now(),
          });
          return result.content;
        });
        const committed = requireMutation(result);
        return {
          task_id: input.task_id,
          capsule,
          ...meta(committed, committed.noop),
        };
      }),
    );
  }

  async finalize(input: TaskFinalizeInput): Promise<TaskFinalizeOutput> {
    return this.mutation(input.request_id, input, "finalize", async () => {
      const located = await this.findTask(input.task_id);
      const changed = await this.mutateTask(
        located.path,
        input.expected_revision,
        (current) => {
          const task = upgradeTask(current);
          delete task.resume;
          delete task.blocker;
          delete task.unblockCondition;
          delete task.legacyAcceptanceReview;
          task.state = input.status === "archived" ? "cancelled" : input.status;
          task.archived = input.archived ?? input.status === "archived";
          task.finalOutcome = input.final_outcome;
          task.remaining = [...input.remaining];
          const evidence = input.evidence.map((e, i) => ({
            id: e.id ?? `E-${i + 1}`,
            type: e.type,
            statement: e.statement,
            ...(e.ref === undefined ? {} : { ref: e.ref }),
          }));
          if (evidence.length) replaceTaskEvidence(task, evidence);
          task.finalEvidence = task.evidence ?? [];
          if (input.acceptance) assessAcceptance(task, input.acceptance);
          if (task.state === "cancelled") {
            task.checkpoints = task.checkpoints.map((cp) =>
              cp.status === "active" || cp.status === "blocked"
                ? {
                    id: cp.id,
                    revision: cp.revision + 1,
                    title: cp.title,
                    kind: cp.kind,
                    status: "cancelled" as const,
                    objective: cp.objective,
                    blocks: cp.blocks,
                    ...(cp.judgment ? { judgment: cp.judgment } : {}),
                    ...(cp.outcome ? { outcome: cp.outcome } : {}),
                    cancellation: {
                      reason: input.final_outcome,
                      disposition: "已有记录和资料保留，任务已取消",
                    },
                  }
                : cp,
            );
            task.acceptanceItems = (task.acceptanceItems ?? []).map((a) => ({
              id: a.id,
              statement: a.statement,
              status: "pending",
            }));
          }
          this.alignColumn(task, this.requireBoard(task.boardId));
          this.assertTaskEvidenceProfile(task);
          return task;
        },
      );
      await this.syncCard(changed.result.task);
      return {
        task: taskSummary(changed.result.task),
        ...meta(changed.result, changed.result.noop),
      };
    });
  }

  private alignColumn(
    task: TaskDocument,
    board: BoardConfig,
    columnChanged = false,
    stateChanged = false,
  ): void {
    this.requireColumn(board, task.columnId);
    const column = board.columns.find((c) => c.id === task.columnId)!;
    if (board.columnMode === "state") {
      if (columnChanged && column.state && !stateChanged) {
        if (isTerminal(column.state) && !isTerminal(task.state))
          throw new TaskApiError(
            "QUALITY_REJECTED",
            "Use task_finalize to enter a terminal state",
            { action: "revise_input" },
          );
        task.state = column.state;
      }
      const target = board.columns.find((c) => c.state === task.state);
      if (!target)
        throw new TaskApiError(
          "PLUGIN_CONFIG_REQUIRED",
          `No column maps to state ${task.state}`,
          { action: "configure_plugin" },
        );
      task.columnId = target.id;
      const types = board.taskTypes?.length
        ? board.taskTypes
        : [{ id: "other", name: "Other", profile: "other" }];
      if (!types.some((t) => t.id === task.typeId))
        throw new TaskApiError(
          "INVALID_INPUT",
          `Unknown task type: ${task.typeId}`,
          { action: "revise_input" },
        );
    } else {
      if (task.typeId && task.typeId !== column.typeId && !columnChanged) {
        const target = board.columns.find((c) => c.typeId === task.typeId);
        if (!target)
          throw new TaskApiError(
            "INVALID_INPUT",
            `Unknown task type: ${task.typeId}`,
            { action: "revise_input" },
          );
        task.columnId = target.id;
      } else task.typeId = column.typeId;
    }
    if (task.state !== "blocked") {
      delete task.blocker;
      delete task.unblockCondition;
    }
  }

  private async syncCard(
    task: TaskDocument,
    expectedRevision?: string,
  ): Promise<void> {
    await this.boardService.updateCard({
      boardId: task.boardId,
      taskPath: task.path,
      columnId: task.columnId,
      title: task.title,
      checked: isTerminal(task.state),
      archived: task.archived ?? false,
      ...(expectedRevision ? { expectedRevision } : {}),
    });
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
        throw versionConflict(
          "Task revision changed",
          expectedRevision,
          parsed.task.revision,
        );
      }
      const transformed = transform(parsed.task);
      if (
        canonicalJson(semanticTask(parsed.task)) ===
        canonicalJson(semanticTask(transformed))
      ) {
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
    if (!this.boards.length)
      throw new TaskApiError(
        "PLUGIN_CONFIG_REQUIRED",
        "Configure at least one task board",
        { action: "configure_plugin" },
      );
    const paths = await this.index.find(taskId);
    if (paths.length === 0)
      throw new TaskApiError("TASK_NOT_FOUND", `Task not found: ${taskId}`, {
        action: "reread",
      });
    if (paths.length > 1)
      throw new TaskApiError(
        "DOCUMENT_CONFLICT",
        `Task ID is duplicated: ${taskId}`,
        { action: "reread", details: { paths } },
      );
    const path = paths[0]!;
    const content = await this.vault.read(path);
    const parsed = this.codec.parse(content, path);
    if (parsed.task.taskId !== taskId) {
      this.index.notify(path);
      throw new TaskApiError(
        "DOCUMENT_CONFLICT",
        "Task identity changed; reread",
        { action: "reread" },
      );
    }
    return { path, content, parsed };
  }

  private requireBoard(boardId: string): BoardConfig {
    const board = this.boards.find((candidate) => candidate.id === boardId);
    if (board === undefined) {
      throw new TaskApiError("INVALID_INPUT", `Unknown board: ${boardId}`, {
        action: "revise_input",
      });
    }
    return board;
  }

  private requireColumn(board: BoardConfig, columnId: string): void {
    if (!board.columns.some((column) => column.id === columnId)) {
      throw new TaskApiError(
        "INVALID_INPUT",
        `Unknown column ${columnId} on board ${board.id}`,
        {
          action: "revise_input",
        },
      );
    }
  }

  private assertTaskEvidenceProfile(task: TaskDocument): void {
    if (task.state !== "done") return;
    const board = this.requireBoard(task.boardId);
    const profile =
      board.columnMode === "state"
        ? (board.taskTypes?.find((t) => t.id === task.typeId)?.profile ??
          "other")
        : (board.columns.find((c) => c.id === task.columnId)?.profile ??
          "other");
    const allowed: Partial<Record<string, Evidence["type"][]>> = {
      bug: ["test", "observation"],
      feature: ["test", "observation", "user_acceptance"],
      research: ["source", "observation", "artifact"],
      migration: ["test", "observation", "artifact"],
      configuration: ["test", "observation", "artifact"],
      maintenance: ["test", "observation", "artifact"],
    };
    const types = allowed[profile];
    if (!types) return;
    const evidence = new Map((task.evidence ?? []).map((e) => [e.id, e]));
    for (const cp of task.checkpoints) {
      if (cp.status === "cancelled" || cp.status === "superseded") continue;
      for (const entry of cp.outcome?.evidence ?? [])
        evidence.set(`${cp.id}/${entry.id}`, entry);
    }
    for (const item of task.acceptanceItems ?? []) {
      if (
        item.status === "verified" &&
        !item.evidenceRefs?.some((ref) =>
          types.includes(evidence.get(ref)?.type as Evidence["type"]),
        )
      ) {
        throw new TaskApiError(
          "QUALITY_REJECTED",
          `${profile} acceptance ${item.id} requires linked ${types.join(" or ")} evidence`,
          { action: "revise_input" },
        );
      }
    }
  }

  private assertProfileAllows(
    task: TaskDocument,
    checkpoint: CheckpointCore,
  ): void {
    if (checkpoint.status !== "done") return;
    const board = this.requireBoard(task.boardId);
    const profile =
      board.columnMode === "state"
        ? (board.taskTypes?.find((t) => t.id === task.typeId)?.profile ??
          "other")
        : (board.columns.find((column) => column.id === task.columnId)
            ?.profile ?? "other");
    const evidenceTypes = new Set(
      checkpoint.outcome?.evidence.map((entry) => entry.type) ?? [],
    );
    const verifiedEvidence = (...types: Evidence["type"][]): boolean =>
      types.some((type) => evidenceTypes.has(type));
    let valid = true;
    let message = "";
    if (profile === "bug" && !verifiedEvidence("test", "observation")) {
      valid = false;
      message =
        "A completed bug checkpoint requires test or observation evidence";
    } else if (
      profile === "feature" &&
      !verifiedEvidence("test", "observation", "user_acceptance")
    ) {
      valid = false;
      message =
        "A completed feature checkpoint requires test, observation, or user acceptance evidence";
    } else if (
      profile === "research" &&
      (!verifiedEvidence("source", "observation", "artifact") ||
        (checkpoint.judgment?.facts?.length ?? 0) +
          (checkpoint.judgment?.decisions?.length ?? 0) ===
          0)
    ) {
      valid = false;
      message =
        "A completed research checkpoint requires a final judgment and source, observation, or artifact evidence";
    } else if (
      ["migration", "configuration", "maintenance"].includes(profile) &&
      !verifiedEvidence("test", "observation", "artifact")
    ) {
      valid = false;
      message = `A completed ${profile} checkpoint requires test, observation, or artifact evidence`;
    }
    if (!valid) {
      throw new TaskApiError("QUALITY_REJECTED", message, {
        action: "revise_input",
        issues: [
          {
            path: "core.outcome.evidence",
            rule: `profile_${profile}`,
            message,
          },
        ],
      });
    }
  }

  private async rollbackCreatedFile(
    path: string,
    expectedContent: string,
  ): Promise<void> {
    try {
      if (!(await this.vault.exists(path))) return;
      if ((await this.vault.read(path)) !== expectedContent) return;
      const deletable = this.vault as VaultAdapter & {
        delete?: (target: string) => Promise<void>;
      };
      if (typeof deletable.delete === "function") await deletable.delete(path);
    } catch {
      // Best effort only: preserve the original operation error.
    }
  }

  private async rollbackChangedFile(
    path: string,
    expectedCurrent: string,
    previous: string,
  ): Promise<void> {
    try {
      await this.vault.process(path, (current) =>
        current === expectedCurrent ? previous : current,
      );
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
    return this.guard(() => this.mutations.run(requestId, payload, operation));
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
        ...(entry.evidence_refs === undefined
          ? {}
          : { evidenceRefs: [...entry.evidence_refs] }),
        ...(entry.waiver_reason === undefined
          ? {}
          : { waiverReason: entry.waiver_reason }),
      })),
    },
    blocks: existing?.blocks ?? [],
  };
  if (core.judgment !== undefined) {
    checkpoint.judgment = {
      ...(core.judgment.facts === undefined
        ? {}
        : { facts: core.judgment.facts.map((entry) => ({ ...entry })) }),
      ...(core.judgment.decisions === undefined
        ? {}
        : { decisions: [...core.judgment.decisions] }),
      ...(core.judgment.constraints === undefined
        ? {}
        : {
            constraints: core.judgment.constraints.map((entry) => ({
              rejectedOption: entry.rejected_option,
              verifiedReason: entry.verified_reason,
              scope: entry.scope,
              impact: entry.impact,
              evidenceRefs: [...entry.evidence_refs],
              ...(entry.reconsider_when === undefined
                ? {}
                : { reconsiderWhen: entry.reconsider_when }),
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
      ...(core.outcome.residual_risks === undefined
        ? {}
        : { residualRisks: [...core.outcome.residual_risks] }),
    };
  }
  if (core.blocker !== undefined) checkpoint.blocker = core.blocker;
  if (core.unblock_condition !== undefined)
    checkpoint.unblockCondition = core.unblock_condition;
  if (core.cancellation !== undefined)
    checkpoint.cancellation = { ...core.cancellation };
  if (core.superseded_by !== undefined)
    checkpoint.supersededBy = core.superseded_by;
  return checkpoint;
}

function resumeFrom(input: TaskHandoffInput): ResumeCapsule {
  const capsule = input.capsule;
  const workspaceRef =
    capsule.workspace_ref === undefined
      ? undefined
      : {
          ...(capsule.workspace_ref.repo === undefined
            ? {}
            : { repo: capsule.workspace_ref.repo }),
          ...(capsule.workspace_ref.branch === undefined
            ? {}
            : { branch: capsule.workspace_ref.branch }),
          ...(capsule.workspace_ref.commit === undefined
            ? {}
            : { commit: capsule.workspace_ref.commit }),
        };
  return {
    ...(capsule.focus_checkpoint_id === undefined
      ? {}
      : { focusCheckpointId: capsule.focus_checkpoint_id }),
    ...(capsule.pending_checks === undefined
      ? {}
      : { pendingChecks: [...capsule.pending_checks] }),
    stale: false,
    basedOnRevision: capsule.based_on_revision,
    ...(capsule.last_verified === undefined
      ? {}
      : { lastVerified: capsule.last_verified }),
    nextAction: capsule.next_action,
    blockers: capsule.blockers.map((entry) => ({
      statement: entry.statement,
      unblockWhen: entry.unblock_when,
    })),
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
    ...(input.block.checklist_scope === undefined
      ? {}
      : { checklistScope: input.block.checklist_scope }),
    ...(input.block.source_uri === undefined
      ? {}
      : { sourceUri: input.block.source_uri }),
    ...(input.block.language === undefined
      ? {}
      : { language: input.block.language }),
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

function taskPath(folder: string, _title: string, taskId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId))
    throw new TaskApiError(
      "INVALID_INPUT",
      "Generated task ID is not path-safe",
      { action: "revise_input" },
    );
  return `${folder.replace(/[\\/]+$/g, "")}/${taskId}.md`;
}

function blockPath(
  taskDocument: string,
  checkpointId: string,
  blockId: string,
): string {
  if (![checkpointId, blockId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)))
    throw new TaskApiError(
      "INVALID_INPUT",
      "Checkpoint/block IDs must be path-safe",
      { action: "revise_input" },
    );
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
    archived: task.archived ?? false,
    ...(task.typeId ? { typeId: task.typeId } : {}),
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
    warnings: validateTaskDocument(parsed.task, {
      strictQuality: false,
    }).warnings.map(({ path, rule, message }) => ({ path, rule, message })),
    ...(noop ? { noop: true } : {}),
  };
}

function requireMutation(
  value: DocumentMutationResult | undefined,
): DocumentMutationResult {
  if (value === undefined)
    throw new Error("Vault process did not execute its mutation callback");
  return value;
}

function versionConflict(
  message: string,
  expected: number,
  actual: number,
): TaskApiError {
  return new TaskApiError("VERSION_CONFLICT", message, {
    action: "reread",
    details: { expected_revision: expected, actual_revision: actual },
  });
}

function checkpointNotFound(id: string): TaskApiError {
  return new TaskApiError(
    "CHECKPOINT_NOT_FOUND",
    `Checkpoint not found: ${id}`,
    { action: "reread" },
  );
}

function normalizeError(error: unknown): TaskApiError {
  if (error instanceof TaskApiError) return error;
  if (error instanceof TaskDocError) {
    const action =
      error.code === "VERSION_CONFLICT" || error.code === "DOCUMENT_CONFLICT"
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
      ...(error.issues === undefined
        ? {}
        : {
            issues: error.issues.map(({ path, rule, message }) => ({
              path,
              rule,
              message,
            })),
          }),
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
      cause: error,
    });
  }
  if (error instanceof BoardRevisionConflictError) {
    return new TaskApiError("VERSION_CONFLICT", error.message, {
      action: "reread",
      details: {
        expected_revision: error.expected,
        actual_revision: error.actual,
      },
      cause: error,
    });
  }
  if (
    error instanceof BoardNotFoundError ||
    error instanceof BoardColumnNotFoundError
  ) {
    return new TaskApiError("INVALID_INPUT", error.message, {
      action: "revise_input",
      cause: error,
    });
  }
  if (
    error instanceof BoardCardNotFoundError ||
    error instanceof BrokenTaskLinkError
  ) {
    return new TaskApiError("TASK_NOT_FOUND", error.message, {
      action: "reread",
      cause: error,
    });
  }
  if (error instanceof DuplicateBoardCardError) {
    return new TaskApiError("DOCUMENT_CONFLICT", error.message, {
      action: "reread",
      cause: error,
    });
  }
  if (
    error instanceof Error &&
    error.message.startsWith("IDEMPOTENCY_CONFLICT:")
  ) {
    return new TaskApiError(
      "IDEMPOTENCY_CONFLICT",
      error.message.replace(/^IDEMPOTENCY_CONFLICT:\s*/, ""),
      {
        action: "revise_input",
        cause: error,
      },
    );
  }
  if (error instanceof KanbanError) {
    return new TaskApiError("IO_ERROR", error.message, {
      action: "retry_same_request",
      retryable: true,
      cause: error,
    });
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

function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
  maxBytes = 24_000,
): { items: T[]; nextCursor?: string } {
  const offset = parseCursor(cursor);
  if (limit === 0) return { items: [] };
  if (offset > items.length)
    throw new TaskApiError("INVALID_INPUT", "Cursor is beyond the result", {
      action: "revise_input",
    });
  const page: T[] = [];
  let bytes = 2;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (page.length && bytes + size > maxBytes) break;
    page.push(item);
    bytes += size;
  }
  const next = offset + page.length;
  return {
    items: page,
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

function paginateText(
  content: string,
  cursor: string | undefined,
  limit: number,
): { content: string; nextCursor?: string } {
  const chars = Array.from(content);
  const offset = parseCursor(cursor);
  if (offset > chars.length) {
    throw new TaskApiError("INVALID_INPUT", "Cursor is beyond the rich block", {
      action: "revise_input",
    });
  }
  const page = chars.slice(offset, offset + limit).join("");
  const next = offset + Array.from(page).length;
  return {
    content: page,
    ...(next < chars.length ? { nextCursor: String(next) } : {}),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new TaskApiError("INVALID_INPUT", "Cursor is invalid", {
      action: "revise_input",
    });
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new TaskApiError(
      "INVALID_INPUT",
      "Cursor is outside the supported range",
      { action: "revise_input" },
    );
  }
  return value;
}
