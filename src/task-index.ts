import { parse } from "yaml";
import type { VaultAdapter } from "./types.js";
import { KeyedMutex } from "./util/concurrency.js";

/** Index identity only. Always read the selected file again before returning or mutating it. */
export class TaskIndex {
  private paths = new Map<string, Set<string>>();
  private identities = new Map<string, string>();
  private dirty = new Set<string>();
  private failures = new Map<string, unknown>();
  private initialized = false;
  private mutex = new KeyedMutex();
  constructor(
    private vault: VaultAdapter,
    private roots: string[],
  ) {}

  reset(roots: string[]): void {
    this.roots = roots;
    this.initialized = false;
    this.paths.clear();
    this.identities.clear();
    this.dirty.clear();
    this.failures.clear();
  }

  notify(path: string, previousPath?: string): void {
    if (previousPath) {
      this.remove(previousPath);
      this.failures.delete(previousPath);
    }
    if (this.includes(path)) this.dirty.add(path);
  }

  record(id: string, path: string): void {
    this.remove(path);
    this.identities.set(path, id);
    const matches = this.paths.get(id) ?? new Set<string>();
    matches.add(path);
    this.paths.set(id, matches);
    this.failures.delete(path);
    this.dirty.delete(path);
  }

  async find(id: string): Promise<string[]> {
    await this.mutex.run("index", async () => {
      if (!this.initialized) {
        for (const file of await this.vault.listMarkdownFiles(this.roots))
          if (this.includes(file.path)) this.dirty.add(file.path);
        this.initialized = true;
      }
      for (const path of new Set([...this.dirty, ...this.failures.keys()])) {
        this.dirty.delete(path);
        try {
          if (!(await this.vault.exists(path))) {
            this.remove(path);
            this.failures.delete(path);
            continue;
          }
          const content = await this.vault.read(path);
          const yaml = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
          let metadata: unknown;
          try {
            metadata = yaml === undefined ? undefined : parse(yaml);
          } catch {
            // A malformed ordinary note must not make every healthy task inaccessible.
            // Keep a recognizable task identity so opening that task reports its parse error.
            const candidate = yaml?.match(
              /^task_id:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m,
            )?.[1];
            metadata = candidate ? { task_id: candidate } : undefined;
          }
          this.remove(path);
          if (
            metadata &&
            typeof metadata === "object" &&
            "task_id" in metadata &&
            typeof metadata.task_id === "string"
          )
            this.record(metadata.task_id, path);
          this.failures.delete(path);
        } catch (error) {
          this.failures.set(path, error);
        }
      }
    });
    const matches = [...(this.paths.get(id) ?? [])];
    // A failed scan cannot establish absence (or uniqueness).
    if (this.failures.size) throw this.failures.values().next().value;
    return matches;
  }

  private includes(path: string): boolean {
    return (
      /\.md$/i.test(path) &&
      !path.split("/").some((p) => p.endsWith(".assets")) &&
      this.roots.some((root) => path.startsWith(`${root.replace(/\/$/, "")}/`))
    );
  }
  private remove(path: string): void {
    const oldId = this.identities.get(path);
    if (oldId) {
      this.paths.get(oldId)?.delete(path);
      if (!this.paths.get(oldId)?.size) this.paths.delete(oldId);
    }
    this.identities.delete(path);
  }
}
