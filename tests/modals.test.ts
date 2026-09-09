import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { TaskService } from "../src/service.js";
import { MemoryVault } from "../src/testing/memoryVault.js";
import type { BoardConfig, TaskDocument } from "../src/types.js";

// Exercise real modal callbacks against the service, substituting only the Obsidian UI API.
class Element {
  children: Element[] = [];
  settings: Setting[] = [];
  text = "";
  createEl(_tag: string, options?: { text?: string }) {
    const child = new Element();
    child.text = options?.text ?? "";
    this.children.push(child);
    return child;
  }
  createDiv() {
    return this.createEl("div");
  }
  empty() {
    this.children = [];
    this.settings = [];
  }
  remove() {}
  allSettings(): Setting[] {
    return [...this.settings, ...this.children.flatMap((c) => c.allSettings())];
  }
}
class Component {
  value: unknown;
  label = "";
  changed: (value: any) => unknown = () => {};
  clicked: () => unknown = () => {};
  setValue(v: unknown) {
    this.value = v;
    return this;
  }
  onChange(fn: (value: any) => unknown) {
    this.changed = fn;
    return this;
  }
  onClick(fn: () => unknown) {
    this.clicked = fn;
    return this;
  }
  setButtonText(v: string) {
    this.label = v;
    return this;
  }
  setPlaceholder(_v: string) {
    return this;
  }
  setTooltip(_v: string) {
    return this;
  }
  setDesc(_v: string) {
    return this;
  }
  setDisabled(_v: boolean) {
    return this;
  }
  setCta() {
    return this;
  }
  setWarning() {
    return this;
  }
  addOption(_key: string, _label: string) {
    return this;
  }
  addOptions(_options: unknown) {
    return this;
  }
}
class Setting {
  name = "";
  components: Component[] = [];
  constructor(el: Element) {
    el.settings.push(this);
  }
  setName(v: string) {
    this.name = v;
    return this;
  }
  setDesc(_v: string) {
    return this;
  }
  add(fn: (component: Component) => unknown) {
    const c = new Component();
    this.components.push(c);
    fn(c);
    return this;
  }
  addText = this.add;
  addTextArea = this.add;
  addDropdown = this.add;
  addToggle = this.add;
  addButton = this.add;
}
class Modal {
  static opened: Modal[] = [];
  contentEl = new Element();
  closed = false;
  constructor(public app: unknown) {}
  onOpen() {}
  open() {
    Modal.opened.push(this);
    this.onOpen();
  }
  close() {
    this.closed = true;
  }
}
const notices: string[] = [];
const bundled = await build({
  entryPoints: ["src/obsidian/modals.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["obsidian"],
});
const module = { exports: {} };
const require = createRequire(import.meta.url);
runInNewContext(bundled.outputFiles[0]!.text, {
  module,
  exports: module.exports,
  require: (name: string) =>
    name === "obsidian"
      ? {
          Modal,
          Setting,
          Notice: class {
            constructor(text: string) {
              notices.push(text);
            }
          },
        }
      : require(name),
  structuredClone,
  Buffer,
  console,
});
const ui = module.exports as Record<string, new (...args: any[]) => Modal>;
const board: BoardConfig = {
  id: "board",
  name: "Project",
  projectId: "project",
  file: "Board.md",
  tasksFolder: "Tasks",
  autoConvertCards: false,
  columns: [{ id: "work", heading: "Work", typeId: "other", profile: "other" }],
};
const field = (modal: Modal, name: string, index = 0) => {
  const setting = modal.contentEl.allSettings().find((s) => s.name === name);
  assert.ok(setting, `Missing field ${name}`);
  return setting.components[index]!;
};
const click = async (modal: Modal, label: string) => {
  const button = modal.contentEl
    .allSettings()
    .flatMap((s) => s.components)
    .find((c) => c.label === label);
  assert.ok(button, `Missing button ${label}`);
  await button.clicked();
};

test("modal workflow creates and edits tasks and adds a new checkpoint", async () => {
  const vault = new MemoryVault({ "Board.md": "## Work\n\n" });
  const service = new TaskService(vault, [board]);
  let opened = "";
  const app = {
    workspace: {
      openLinkText: async (path: string) => {
        opened = path;
      },
    },
  };
  const create = new ui.TaskCreateModal!(app, service, [board]);
  create.open();
  field(create, "标题").changed("A human task");
  field(create, "目标").changed("Verify human controls");
  field(create, "验收条件").changed("The controls save correctly");
  await click(create, "创建并打开");
  assert.equal(create.closed, true, notices.join(";"));
  const task = await service.taskAtPath(opened);
  const edit = new ui.TaskEditorModal!(app, service, task, board);
  edit.open();
  field(edit, "标题").changed("A corrected human task");
  field(edit, "变更原因").changed("Correct the title");
  await click(edit, "保存修改");
  assert.equal(edit.closed, true, notices.join(";"));
  assert.equal(
    (await service.taskAtPath(opened)).title,
    "A corrected human task",
  );
  const list = new ui.CheckpointListModal!(
    app,
    service,
    await service.taskAtPath(opened),
  );
  list.open();
  await click(list, "新增可独立验收的子任务");
  const checkpoint = Modal.opened.at(-1)!;
  field(checkpoint, "标题").changed("Verify editor");
  field(checkpoint, "目标").changed("Create the record");
  field(checkpoint, "验收条件").changed("Record persists");
  await click(checkpoint, "保存子任务");
  assert.equal(checkpoint.closed, true, notices.join(";"));
  assert.equal((await service.taskAtPath(opened)).checkpoints.length, 1);
});

test("create modal handles boards with no columns and allows state-board type selection", async () => {
  const empty = new ui.TaskCreateModal!({}, {} as TaskService, [
    { ...board, columns: [] },
  ]);
  assert.doesNotThrow(() => empty.open());
  const stateBoard: BoardConfig = {
    ...board,
    columnMode: "state",
    taskTypes: [
      { id: "a", name: "A", profile: "other" },
      { id: "b", name: "B", profile: "bug" },
    ],
    columns: [{ ...board.columns[0]!, state: "active" }],
  };
  const vault = new MemoryVault({ "Board.md": "## Work\n\n" });
  const service = new TaskService(vault, [stateBoard]);
  let opened = "";
  const modal = new ui.TaskCreateModal!(
    {
      workspace: {
        openLinkText: async (p: string) => {
          opened = p;
        },
      },
    },
    service,
    [stateBoard],
  );
  modal.open();
  field(modal, "任务类型").changed("b");
  field(modal, "标题").changed("Selected type");
  field(modal, "目标").changed("Keep the selected type");
  field(modal, "验收条件").changed("Type is B");
  await click(modal, "创建并打开");
  assert.equal((await service.taskAtPath(opened)).typeId, "b");
});
