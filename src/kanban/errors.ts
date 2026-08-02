export class KanbanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KanbanError";
  }
}

export class BoardNotFoundError extends KanbanError {
  constructor(boardId: string) {
    super(`Unknown board: ${boardId}`);
    this.name = "BoardNotFoundError";
  }
}

export class BoardColumnNotFoundError extends KanbanError {
  constructor(boardId: string, columnId: string) {
    super(`Board ${boardId} has no configured column ${columnId}`);
    this.name = "BoardColumnNotFoundError";
  }
}

export class BoardRevisionConflictError extends KanbanError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Board revision conflict: expected ${expected}, found ${actual}`);
    this.name = "BoardRevisionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class BoardCardNotFoundError extends KanbanError {
  constructor(taskPath: string) {
    super(`No card links to task document ${taskPath}`);
    this.name = "BoardCardNotFoundError";
  }
}

export class DuplicateBoardCardError extends KanbanError {
  constructor(taskPath: string) {
    super(`More than one card links to task document ${taskPath}`);
    this.name = "DuplicateBoardCardError";
  }
}

export class BrokenTaskLinkError extends KanbanError {
  constructor(taskPath: string) {
    super(`Task document does not exist: ${taskPath}`);
    this.name = "BrokenTaskLinkError";
  }
}
