import { parse as parseYaml } from "yaml";
import type { BoardConfig, TaskState, VaultAdapter, VaultFileInfo } from "../types.js";
import {
  BoardNotFoundError,
  BrokenTaskLinkError
} from "./errors.js";
import { createLinkedCard, updateLinkedCard } from "./mutations.js";
import { parseBoard } from "./parser.js";
import { taskDocumentPath, taskPathIdentity } from "./paths.js";
import type {
  BoardCard,
  BoardCatalogEntry,
  BoardMutationResult,
  BoardQuery,
  BoardQueryResult,
  BoardSnapshot,
  BrokenIssue,
  CreateCardInput,
  DuplicateIssue,
  OrphanIssue,
  ReconcileCardReference,
  ReconcileReport,
  StatusMismatchIssue,
  TypeMismatchIssue,
  UpdateCardInput
} from "./types.js";

interface TaskProjection {
  path: string;
  title: string;
  taskId?: string;
  boardId?: string;
  columnId?: string;
  state?: TaskState;
}

export class BoardService {
  private boards: BoardConfig[];

  constructor(
    private readonly vault: VaultAdapter,
    boards: readonly BoardConfig[]
  ) {
    this.boards = [...boards];
    this.assertUniqueConfiguration(this.boards);
  }

  setBoards(boards: readonly BoardConfig[]): void {
    const next = [...boards];
    this.assertUniqueConfiguration(next);
    this.boards = next;
  }

  async snapshot(boardId: string): Promise<BoardSnapshot> {
    const config = this.requireBoard(boardId);
    const source = await this.vault.read(config.file);
    const board = parseBoard(source, config);
    return { config, board, hash: board.hash, revision: board.revision };
  }

  async catalog(boardId?: string): Promise<BoardCatalogEntry[]> {
    const configs = boardId ? [this.requireBoard(boardId)] : this.boards;
    return Promise.all(configs.map(async (config) => {
      const { board } = await this.snapshot(config.id);
      const mappedHeadings = new Set(config.columns.map((column) => column.heading));
      const unresolvedHeadings = board.columns
        .filter((column) => !column.id)
        .map((column) => column.heading);
      const columns = config.columns.map((configured) => {
        const parsed = board.columns.find((column) => column.heading === configured.heading);
        const cards = parsed?.cards ?? [];
        return {
          ...configured,
          resolved: parsed !== undefined,
          cardCount: cards.length,
          activeCount: cards.filter((card) => !card.checked).length,
          doneCount: cards.filter((card) => card.checked).length
        };
      });
      for (const column of board.columns) {
        if (!mappedHeadings.has(column.heading) && !unresolvedHeadings.includes(column.heading)) {
          unresolvedHeadings.push(column.heading);
        }
      }
      const entry: BoardCatalogEntry = {
        id: config.id,
        name: config.name,
        projectId: config.projectId,
        file: config.file,
        tasksFolder: config.tasksFolder,
        autoConvertCards: config.autoConvertCards,
        revision: board.revision,
        hash: board.hash,
        columns,
        unresolvedHeadings
      };
      if (config.defaultColumnId) entry.defaultColumnId = config.defaultColumnId;
      return entry;
    }));
  }

  async query(query: BoardQuery = {}): Promise<BoardQueryResult[]> {
    const configs = query.boardId ? [this.requireBoard(query.boardId)] : this.boards;
    const titleNeedle = query.title?.trim().toLocaleLowerCase();
    const pathNeedle = query.taskPath ? taskPathIdentity(query.taskPath) : undefined;
    const results: BoardQueryResult[] = [];

    for (const config of configs) {
      const { board } = await this.snapshot(config.id);
      for (const column of board.columns) {
        if (query.columnId && column.id !== query.columnId) continue;
        for (const card of column.cards) {
          const state = card.checked ? "done" : "active";
          if (query.state && state !== query.state) continue;
          const title = cardTitle(card);
          if (titleNeedle && !title.toLocaleLowerCase().includes(titleNeedle)) continue;
          if (pathNeedle && (!card.link || taskPathIdentity(card.link.documentPath) !== pathNeedle)) continue;
          const result: BoardQueryResult = {
            boardId: config.id,
            boardFile: config.file,
            columnHeading: column.heading,
            state,
            title,
            startOffset: card.startOffset,
            endOffset: card.endOffset
          };
          if (column.id) result.columnId = column.id;
          if (card.link) {
            result.taskPath = taskDocumentPath(card.link.documentPath);
            result.linkTarget = card.link.target;
          }
          results.push(result);
        }
      }
    }
    return results;
  }

  async createCard(input: CreateCardInput): Promise<BoardMutationResult> {
    const config = this.requireBoard(input.boardId);
    const documentPath = taskDocumentPath(input.taskPath);
    if (!input.allowBrokenLink && !(await this.vault.exists(documentPath))) {
      throw new BrokenTaskLinkError(documentPath);
    }

    let nextSource = "";
    await this.vault.process(config.file, (current) => {
      const pureInput = {
        columnId: input.columnId,
        taskPath: documentPath,
        title: input.title
      };
      const checked = input.checked;
      const indentedLines = input.indentedLines;
      const expectedRevision = input.expectedRevision;
      nextSource = createLinkedCard(current, config, {
        ...pureInput,
        ...(checked === undefined ? {} : { checked }),
        ...(indentedLines === undefined ? {} : { indentedLines }),
        ...(expectedRevision === undefined ? {} : { expectedRevision })
      });
      return nextSource;
    });
    return this.mutationResult(config, documentPath, nextSource);
  }

  async updateCard(input: UpdateCardInput): Promise<BoardMutationResult> {
    const config = this.requireBoard(input.boardId);
    const documentPath = taskDocumentPath(input.taskPath);
    let nextSource = "";
    await this.vault.process(config.file, (current) => {
      nextSource = updateLinkedCard(current, config, {
        taskPath: documentPath,
        ...(input.columnId === undefined ? {} : { columnId: input.columnId }),
        ...(input.checked === undefined ? {} : { checked: input.checked }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision })
      });
      return nextSource;
    });
    return this.mutationResult(config, documentPath, nextSource);
  }

  async reconcileReport(boardId: string): Promise<ReconcileReport> {
    const config = this.requireBoard(boardId);
    const { board } = await this.snapshot(boardId);
    const broken: BrokenIssue[] = [];
    const duplicate: DuplicateIssue[] = [];
    const typeMismatch: TypeMismatchIssue[] = [];
    const statusMismatch: StatusMismatchIssue[] = [];
    const cardGroups = new Map<string, ReconcileCardReference[]>();
    const linkedTaskPaths = new Set<string>();

    for (const column of board.columns) {
      for (const card of column.cards) {
        const reference = cardReference(config, card, column.id, column.heading);
        if (!card.link) {
          broken.push({ card: reference, reason: "unlinked" });
          continue;
        }
        const documentPath = taskDocumentPath(card.link.documentPath);
        const identity = taskPathIdentity(documentPath);
        linkedTaskPaths.add(identity);
        const group = cardGroups.get(identity) ?? [];
        group.push(reference);
        cardGroups.set(identity, group);

        if (!(await this.vault.exists(documentPath))) {
          broken.push({ card: reference, reason: "missing-document" });
          continue;
        }

        let projection: TaskProjection;
        try {
          projection = parseTaskProjection(documentPath, await this.vault.read(documentPath));
        } catch {
          broken.push({ card: reference, reason: "unreadable-document" });
          continue;
        }
        if (!projection.taskId) {
          broken.push({ card: reference, reason: "not-task-document" });
          continue;
        }
        if (projection.columnId !== column.id) {
          const issue: TypeMismatchIssue = {
            taskPath: documentPath,
            card: reference
          };
          if (column.id) issue.cardColumnId = column.id;
          if (projection.columnId) issue.documentColumnId = projection.columnId;
          typeMismatch.push(issue);
        }
        if (projection.state === "active" && card.checked) {
          statusMismatch.push({
            taskPath: documentPath,
            documentState: projection.state,
            cardChecked: card.checked,
            card: reference
          });
        } else if (projection.state === "done" && !card.checked) {
          statusMismatch.push({
            taskPath: documentPath,
            documentState: projection.state,
            cardChecked: card.checked,
            card: reference
          });
        }
      }
    }

    for (const cards of cardGroups.values()) {
      if (cards.length > 1) {
        const taskPath = cards[0]?.taskPath;
        if (taskPath) duplicate.push({ taskPath, cards });
      }
    }

    const orphan = await this.findOrphans(config, linkedTaskPaths);
    const configuredHeadings = new Set(config.columns.map((column) => column.heading));
    const unresolvedColumns = board.columns
      .filter((column) => !column.id)
      .map((column) => column.heading);
    for (const configured of config.columns) {
      if (!board.columns.some((column) => column.heading === configured.heading)) {
        unresolvedColumns.push(configured.heading);
      }
    }
    for (const column of board.columns) {
      if (!configuredHeadings.has(column.heading) && !unresolvedColumns.includes(column.heading)) {
        unresolvedColumns.push(column.heading);
      }
    }

    return {
      boardId,
      boardFile: config.file,
      revision: board.revision,
      hash: board.hash,
      orphan,
      broken,
      duplicate,
      typeMismatch,
      statusMismatch,
      unresolvedColumns,
      healthy:
        orphan.length === 0 &&
        broken.length === 0 &&
        duplicate.length === 0 &&
        typeMismatch.length === 0 &&
        statusMismatch.length === 0 &&
        unresolvedColumns.length === 0
    };
  }

  private async findOrphans(config: BoardConfig, linkedTaskPaths: Set<string>): Promise<OrphanIssue[]> {
    let files: VaultFileInfo[];
    try {
      files = await this.vault.listMarkdownFiles([config.tasksFolder]);
    } catch {
      return [];
    }
    const issues: OrphanIssue[] = [];
    for (const file of files) {
      let projection: TaskProjection;
      try {
        projection = parseTaskProjection(file.path, await this.vault.read(file.path));
      } catch {
        continue;
      }
      if (projection.boardId !== config.id || linkedTaskPaths.has(taskPathIdentity(file.path))) continue;
      const issue: OrphanIssue = { taskPath: file.path, title: projection.title };
      if (projection.taskId) issue.taskId = projection.taskId;
      issues.push(issue);
    }
    return issues;
  }

  private mutationResult(config: BoardConfig, taskPath: string, source: string): BoardMutationResult {
    const board = parseBoard(source, config);
    const identity = taskPathIdentity(taskPath);
    const card = board.columns
      .flatMap((column) => column.cards)
      .find((candidate) => candidate.link && taskPathIdentity(candidate.link.documentPath) === identity);
    const result: BoardMutationResult = {
      boardId: config.id,
      boardFile: config.file,
      taskPath,
      checked: card?.checked ?? false,
      hash: board.hash,
      revision: board.revision
    };
    if (card?.columnId) result.columnId = card.columnId;
    return result;
  }

  private requireBoard(boardId: string): BoardConfig {
    const board = this.boards.find((candidate) => candidate.id === boardId);
    if (!board) throw new BoardNotFoundError(boardId);
    return board;
  }

  private assertUniqueConfiguration(boards: readonly BoardConfig[]): void {
    const boardIds = new Set<string>();
    const boardFiles = new Set<string>();
    for (const board of boards) {
      if (boardIds.has(board.id)) throw new Error(`Duplicate board id: ${board.id}`);
      if (boardFiles.has(board.file)) throw new Error(`Board file is configured twice: ${board.file}`);
      boardIds.add(board.id);
      boardFiles.add(board.file);
      const columnIds = new Set<string>();
      const headings = new Set<string>();
      for (const column of board.columns) {
        if (columnIds.has(column.id)) throw new Error(`Duplicate column id in ${board.id}: ${column.id}`);
        if (headings.has(column.heading)) throw new Error(`Duplicate column heading in ${board.id}: ${column.heading}`);
        columnIds.add(column.id);
        headings.add(column.heading);
      }
    }
  }
}

function cardReference(
  config: BoardConfig,
  card: BoardCard,
  columnId: string | undefined,
  columnHeading: string
): ReconcileCardReference {
  const reference: ReconcileCardReference = {
    boardId: config.id,
    boardFile: config.file,
    columnHeading,
    title: cardTitle(card),
    startOffset: card.startOffset
  };
  if (columnId) reference.columnId = columnId;
  if (card.link) reference.taskPath = taskDocumentPath(card.link.documentPath);
  return reference;
}

function cardTitle(card: BoardCard): string {
  return card.link?.alias || card.text || "Untitled card";
}

function parseTaskProjection(path: string, source: string): TaskProjection {
  const frontmatterMatch = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
  const value: unknown = frontmatterMatch?.[1] ? parseYaml(frontmatterMatch[1]) : {};
  const root = isRecord(value) ? value : {};
  const nested = isRecord(root.taskdoc)
    ? root.taskdoc
    : isRecord(root.taskflow)
      ? root.taskflow
      : {};
  const read = (snake: string, camel: string): unknown =>
    root[snake] ?? root[camel] ?? nested[snake] ?? nested[camel];
  const stateValue = read("state", "state");
  const state = stateValue === "active" || stateValue === "done" || stateValue === "archived"
    ? stateValue
    : undefined;
  const h1 = /^#(?!#)\s+(.+?)\s*$/m.exec(frontmatterMatch ? source.slice(frontmatterMatch[0].length) : source)?.[1];
  const projection: TaskProjection = {
    path,
    title: h1?.replace(/\s+#+\s*$/, "").trim() || path.replace(/^.*\//, "").replace(/\.md$/i, "")
  };
  const taskId = read("task_id", "taskId");
  const boardId = read("board_id", "boardId");
  const columnId = read("column_id", "columnId");
  if (typeof taskId === "string" && taskId) projection.taskId = taskId;
  if (typeof boardId === "string" && boardId) projection.boardId = boardId;
  if (typeof columnId === "string" && columnId) projection.columnId = columnId;
  if (state) projection.state = state;
  return projection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
