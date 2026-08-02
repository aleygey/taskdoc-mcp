import type { VaultAdapter, VaultFileInfo } from "../types.js";
import { KeyedMutex } from "../util/concurrency.js";

/** A small VaultAdapter used by integration tests and non-Obsidian demos. */
export class MemoryVault implements VaultAdapter {
  private readonly files = new Map<string, string>();
  private readonly folders = new Set<string>();
  private readonly mutex = new KeyedMutex();

  constructor(files: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(files)) {
      const normalized = normalize(path);
      this.files.set(normalized, content);
      this.recordParents(normalized);
    }
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalize(path);
    return this.files.has(normalized) || this.folders.has(normalized);
  }

  async read(path: string): Promise<string> {
    const normalized = normalize(path);
    const content = this.files.get(normalized);
    if (content === undefined) throw new Error(`File not found: ${normalized}`);
    return content;
  }

  async create(path: string, content: string): Promise<void> {
    const normalized = normalize(path);
    await this.mutex.run(normalized, async () => {
      if (this.files.has(normalized) || this.folders.has(normalized)) {
        throw new Error(`Path already exists: ${normalized}`);
      }
      this.files.set(normalized, content);
      this.recordParents(normalized);
    });
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalize(path);
    await this.mutex.run(normalized, async () => {
      if (!this.files.has(normalized)) throw new Error(`File not found: ${normalized}`);
      this.files.set(normalized, content);
    });
  }

  async delete(path: string): Promise<void> {
    const normalized = normalize(path);
    await this.mutex.run(normalized, async () => {
      if (!this.files.delete(normalized)) throw new Error(`File not found: ${normalized}`);
    });
  }

  async process(path: string, update: (current: string) => string): Promise<void> {
    const normalized = normalize(path);
    await this.mutex.run(normalized, async () => {
      const current = this.files.get(normalized);
      if (current === undefined) throw new Error(`File not found: ${normalized}`);
      const next = update(current);
      this.files.set(normalized, next);
    });
  }

  async listMarkdownFiles(roots: string[]): Promise<VaultFileInfo[]> {
    const normalizedRoots = roots.map((root) => normalize(root).replace(/\/$/, ""));
    return [...this.files.keys()]
      .filter((path) => path.toLocaleLowerCase().endsWith(".md"))
      .filter((path) => normalizedRoots.length === 0 || normalizedRoots.some((root) => path === root || path.startsWith(`${root}/`)))
      .sort((left, right) => left.localeCompare(right))
      .map((path) => ({ path, basename: path.replace(/^.*\//, "").replace(/\.md$/i, "") }));
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = normalize(path);
    if (this.files.has(normalized)) throw new Error(`A file blocks folder creation: ${normalized}`);
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (this.files.has(current)) throw new Error(`A file blocks folder creation: ${current}`);
      this.folders.add(current);
    }
  }

  snapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.files.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private recordParents(path: string): void {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      this.folders.add(current);
    }
  }
}

function normalize(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Invalid vault-relative path: ${path}`);
  }
  return normalized;
}
