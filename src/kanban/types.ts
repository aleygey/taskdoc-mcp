import type {
  BoardColumnConfig,
  BoardConfig,
  TaskState,
  ValidationProfile,
} from "../types.js";

export interface BoardFrontmatter {
  data: Record<string, unknown>;
  raw: string;
  startOffset: number;
  endOffset: number;
}

export interface WikiLink {
  raw: string;
  target: string;
  documentPath: string;
  alias?: string;
  startOffset: number;
  endOffset: number;
}

export interface BoardCard {
  marker: "-" | "*" | "+";
  checked: boolean;
  text: string;
  raw: string;
  firstLine: string;
  continuation: string;
  startOffset: number;
  endOffset: number;
  firstLineEndOffset: number;
  columnHeading: string;
  columnId?: string;
  link?: WikiLink;
}

export interface BoardColumn {
  heading: string;
  headingRaw: string;
  startOffset: number;
  headingEndOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  id?: string;
  typeId?: string;
  profile?: ValidationProfile;
  cards: BoardCard[];
}

export interface ParsedBoard {
  source: string;
  eol: "\n" | "\r\n";
  frontmatter?: BoardFrontmatter;
  columns: BoardColumn[];
  archive?: BoardColumn;
  archiveStartOffset?: number;
  settingsStartOffset?: number;
  hash: string;
  revision: string;
}

export interface BoardSnapshot {
  config: BoardConfig;
  board: ParsedBoard;
  hash: string;
  revision: string;
}

export interface BoardColumnCatalogEntry extends BoardColumnConfig {
  resolved: boolean;
  cardCount: number;
  activeCount: number;
  doneCount: number;
}

export interface BoardCatalogEntry {
  id: string;
  name: string;
  projectId: string;
  file: string;
  tasksFolder: string;
  defaultColumnId?: string;
  autoConvertCards: boolean;
  revision: string;
  hash: string;
  columns: BoardColumnCatalogEntry[];
  unresolvedHeadings: string[];
}

export interface BoardQuery {
  boardId?: string;
  columnId?: string;
  state?: "active" | "done";
  title?: string;
  taskPath?: string;
}

export interface BoardQueryResult {
  boardId: string;
  boardFile: string;
  columnId?: string;
  columnHeading: string;
  state: "active" | "done";
  archived?: boolean;
  title: string;
  taskPath?: string;
  linkTarget?: string;
  startOffset: number;
  endOffset: number;
}

export interface CreateCardInput {
  boardId: string;
  columnId: string;
  taskPath: string;
  title: string;
  checked?: boolean;
  indentedLines?: string[];
  expectedRevision?: string;
  allowBrokenLink?: boolean;
}

export interface UpdateCardInput {
  boardId: string;
  taskPath: string;
  columnId?: string;
  checked?: boolean;
  title?: string;
  expectedRevision?: string;
  archived?: boolean;
}

export interface BoardMutationResult {
  boardId: string;
  boardFile: string;
  taskPath: string;
  columnId?: string;
  checked: boolean;
  hash: string;
  revision: string;
}

export interface ReconcileCardReference {
  boardId: string;
  boardFile: string;
  columnId?: string;
  columnHeading: string;
  taskPath?: string;
  title: string;
  startOffset: number;
}

export interface OrphanIssue {
  taskPath: string;
  taskId?: string;
  title: string;
}

export interface BrokenIssue {
  card: ReconcileCardReference;
  reason:
    | "unlinked"
    | "missing-document"
    | "unreadable-document"
    | "not-task-document";
}

export interface DuplicateIssue {
  taskPath: string;
  cards: ReconcileCardReference[];
}

export interface TypeMismatchIssue {
  taskPath: string;
  documentColumnId?: string;
  cardColumnId?: string;
  card: ReconcileCardReference;
}

export interface StatusMismatchIssue {
  taskPath: string;
  documentState: TaskState;
  cardChecked: boolean;
  card: ReconcileCardReference;
}

export interface ReconcileReport {
  boardId: string;
  boardFile: string;
  revision: string;
  hash: string;
  orphan: OrphanIssue[];
  broken: BrokenIssue[];
  duplicate: DuplicateIssue[];
  typeMismatch: TypeMismatchIssue[];
  statusMismatch: StatusMismatchIssue[];
  unresolvedColumns: string[];
  healthy: boolean;
}
