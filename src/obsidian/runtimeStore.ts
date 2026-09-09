import { FileSystemAdapter, type App } from "obsidian";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { RuntimeState, RuntimeStore } from "../persistence.js";

/** Plugin-private data, never a task note. Atomic replacement preserves the last committed journal. */
export class ObsidianRuntimeStore implements RuntimeStore {
  private file: string;
  constructor(app: App, pluginId: string) {
    if (!(app.vault.adapter instanceof FileSystemAdapter))
      throw new Error("TaskDoc requires a desktop filesystem vault");
    const root = path.resolve(app.vault.adapter.getBasePath());
    this.file = path.resolve(
      root,
      app.vault.configDir,
      "plugins",
      pluginId,
      "runtime.json",
    );
    if (!this.file.startsWith(root + path.sep))
      throw new Error("Plugin runtime path must remain inside the vault");
  }
  async load(): Promise<RuntimeState | undefined> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as RuntimeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        "TaskDoc runtime data could not be read. Preserve runtime.json and restore its backup before writing tasks.",
        { cause: error },
      );
    }
  }
  async save(state: RuntimeState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.file);
  }
}
