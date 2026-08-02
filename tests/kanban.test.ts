import assert from "node:assert/strict";
import test from "node:test";
import type { BoardConfig, VaultAdapter, VaultFileInfo } from "../src/types.js";
import {
  BoardRevisionConflictError,
  BoardService,
  createLinkedCard,
  parseBoard,
  updateLinkedCard
} from "../src/kanban/index.js";

const boardConfig: BoardConfig = {
  id: "board-1",
  name: "Project one",
  projectId: "project-1",
  file: "Boards/project.md",
  tasksFolder: "Tasks/project",
  defaultColumnId: "bug",
  autoConvertCards: true,
  columns: [
    { id: "bug", heading: "Bug", typeId: "bug", profile: "bug" },
    { id: "feature", heading: "Feature", typeId: "feature", profile: "feature" }
  ]
};

test("parseBoard reads frontmatter, H2 columns, and lossless top-level card blocks", () => {
  const source = [
    "---",
    "kanban-plugin: board",
    "taskdoc:",
    "  board_id: board-1",
    "---",
    "preamble stays here",
    "## Bug",
    "",
    "- [ ] [[Tasks/project/alpha|Alpha]] #tag",
    "  retained detail",
    "  - [x] nested checkbox",
    "",
    "unmanaged text",
    "```md",
    "## Not a column",
    "- [ ] [[Tasks/project/not-a-card]]",
    "```",
    "## Feature ###",
    "* [X] plain text first",
    "  continuation [[Tasks/project/beta|Beta]]",
    ""
  ].join("\r\n");

  const board = parseBoard(source, boardConfig);
  assert.equal(board.frontmatter?.data["kanban-plugin"], "board");
  assert.deepEqual(board.columns.map((column) => column.heading), ["Bug", "Feature"]);
  assert.equal(board.columns[0]?.cards.length, 1);
  assert.match(board.columns[0]?.cards[0]?.raw ?? "", /retained detail\r\n  - \[x\] nested checkbox/);
  assert.doesNotMatch(board.columns[0]?.cards[0]?.raw ?? "", /unmanaged text/);
  assert.equal(board.columns[0]?.cards[0]?.link?.documentPath, "Tasks/project/alpha");
  assert.equal(board.columns[1]?.cards[0]?.checked, true);
  assert.equal(board.columns[1]?.cards[0]?.link?.documentPath, "Tasks/project/beta");
  assert.match(board.revision, /^sha256:[a-f0-9]{64}$/);
});

test("pure mutations insert, move, and check cards without reserializing unrelated board text", () => {
  const source = [
    "---",
    "kanban-plugin: board",
    "---",
    "intro",
    "## Bug",
    "",
    "keep before",
    "",
    "## Feature",
    "",
    "keep after",
    ""
  ].join("\n");

  const created = createLinkedCard(source, boardConfig, {
    columnId: "bug",
    taskPath: "Tasks/project/alpha.md",
    title: "Alpha",
    indentedLines: ["detail", "  already indented"]
  });
  assert.match(created, /## Bug[\s\S]*- \[ \] \[\[Tasks\/project\/alpha\|Alpha\]\]\n  detail\n  already indented/);
  assert.match(created, /intro/);
  assert.match(created, /keep before/);
  assert.match(created, /keep after/);

  const moved = updateLinkedCard(created, boardConfig, {
    taskPath: "tasks/project/ALPHA",
    columnId: "feature",
    checked: true,
    title: "Alpha renamed"
  });
  const parsed = parseBoard(moved, boardConfig);
  assert.equal(parsed.columns[0]?.cards.length, 0);
  assert.equal(parsed.columns[1]?.cards.length, 1);
  assert.equal(parsed.columns[1]?.cards[0]?.checked, true);
  assert.equal(parsed.columns[1]?.cards[0]?.link?.alias, "Alpha renamed");
  assert.match(parsed.columns[1]?.cards[0]?.raw ?? "", /  detail\n  already indented/);
  assert.match(moved, /keep before/);
  assert.match(moved, /keep after/);

  assert.throws(
    () => updateLinkedCard(moved, boardConfig, {
      taskPath: "Tasks/project/alpha",
      checked: false,
      expectedRevision: "sha256:stale"
    }),
    BoardRevisionConflictError
  );
});

test("BoardService exposes catalog/query, revisioned mutations, and read-only reconciliation", async () => {
  const board = [
    "---",
    "kanban-plugin: board",
    "---",
    "## Bug",
    "- [ ] [[Tasks/project/good|Good]]",
    "- [ ] [[Tasks/project/missing|Missing]]",
    "- [ ] Unlinked draft",
    "## Feature",
    "- [ ] [[Tasks/project/good|Good duplicate]]",
    "- [ ] [[Tasks/project/type|Wrong type]]",
    "- [x] [[Tasks/project/status|Wrong status]]",
    ""
  ].join("\n");
  const vault = new MemoryVault({
    [boardConfig.file]: board,
    "Tasks/project/good.md": taskDocument("good", "bug", "active", "Good"),
    "Tasks/project/type.md": taskDocument("type", "bug", "active", "Wrong type"),
    "Tasks/project/status.md": taskDocument("status", "feature", "active", "Wrong status"),
    "Tasks/project/orphan.md": taskDocument("orphan", "bug", "active", "Orphan")
  });
  const service = new BoardService(vault, [boardConfig]);

  const catalog = await service.catalog();
  assert.equal(catalog[0]?.columns[0]?.cardCount, 3);
  assert.equal(catalog[0]?.columns[1]?.doneCount, 1);
  const query = await service.query({ boardId: "board-1", columnId: "feature", state: "active" });
  assert.deepEqual(query.map((card) => card.title), ["Good duplicate", "Wrong type"]);

  const report = await service.reconcileReport("board-1");
  assert.deepEqual(report.orphan.map((issue) => issue.taskPath), ["Tasks/project/orphan.md"]);
  assert.equal(report.broken.filter((issue) => issue.reason === "missing-document").length, 1);
  assert.equal(report.broken.filter((issue) => issue.reason === "unlinked").length, 1);
  assert.equal(report.duplicate.length, 1);
  assert.ok(report.typeMismatch.some((issue) => issue.taskPath === "Tasks/project/type.md"));
  assert.ok(report.statusMismatch.some((issue) => issue.taskPath === "Tasks/project/status.md"));
  assert.equal(report.healthy, false);
  assert.equal(await vault.read(boardConfig.file), board, "reconcileReport must stay read-only");

  const created = await service.createCard({
    boardId: "board-1",
    columnId: "bug",
    taskPath: "Tasks/project/orphan.md",
    title: "Orphan"
  });
  assert.match(created.revision, /^sha256:/);
  const updated = await service.updateCard({
    boardId: "board-1",
    taskPath: "Tasks/project/orphan.md",
    columnId: "feature",
    checked: true,
    expectedRevision: created.revision
  });
  assert.equal(updated.columnId, "feature");
  assert.equal(updated.checked, true);
});

function taskDocument(taskId: string, columnId: string, state: "active" | "done", title: string): string {
  return [
    "---",
    "task_schema: checkpoint/v1",
    `task_id: ${taskId}`,
    "board_id: board-1",
    `column_id: ${columnId}`,
    `state: ${state}`,
    "---",
    `# ${title}`,
    ""
  ].join("\n");
}

class MemoryVault implements VaultAdapter {
  private readonly files = new Map<string, string>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing: ${path}`);
    return value;
  }

  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`Exists: ${path}`);
    this.files.set(path, content);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async process(path: string, update: (current: string) => string): Promise<void> {
    this.files.set(path, update(await this.read(path)));
  }

  async listMarkdownFiles(roots: string[]): Promise<VaultFileInfo[]> {
    return [...this.files.keys()]
      .filter((path) => path.toLocaleLowerCase().endsWith(".md"))
      .filter((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)))
      .map((path) => ({ path, basename: path.replace(/^.*\//, "").replace(/\.md$/i, "") }));
  }

  async ensureFolder(_path: string): Promise<void> {}
}
