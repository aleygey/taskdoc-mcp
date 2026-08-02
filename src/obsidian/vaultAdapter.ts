import { normalizePath, TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import { VaultIoError, type VaultAdapter, type VaultFileInfo, type VaultOperation } from "../types";

export function safeVaultPath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.split("/").includes("..")) {
    throw new Error(`Unsafe vault-relative path: ${input}`);
  }
  return normalizePath(raw);
}

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async exists(path: string): Promise<boolean> {
    const safe = safeVaultPath(path);
    try {
      return this.vault.getAbstractFileByPath(safe) !== null;
    } catch (error) {
      throw new VaultIoError("exists", safe, error);
    }
  }

  async read(path: string): Promise<string> {
    const safe = safeVaultPath(path);
    const file = this.requireFile(safe, "read");
    return this.runIo("read", safe, () => this.vault.read(file));
  }

  async create(path: string, content: string): Promise<void> {
    const safe = safeVaultPath(path);
    const parent = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
    if (parent) await this.ensureFolder(parent);
    await this.runIo("create", safe, () => this.vault.create(safe, content));
  }

  async write(path: string, content: string): Promise<void> {
    const safe = safeVaultPath(path);
    const file = this.requireFile(safe, "write");
    await this.runIo("write", safe, () => this.vault.modify(file, content));
  }

  async delete(path: string): Promise<void> {
    const safe = safeVaultPath(path);
    const file = this.requireFile(safe, "delete");
    await this.runIo("delete", safe, () => this.vault.delete(file, true));
  }

  async process(path: string, update: (current: string) => string): Promise<void> {
    const safe = safeVaultPath(path);
    const file = this.requireFile(safe, "process");
    let callbackThrew = false;
    let callbackError: unknown;
    try {
      await this.vault.process(file, (current) => {
        try {
          return update(current);
        } catch (error) {
          callbackThrew = true;
          callbackError = error;
          throw error;
        }
      });
    } catch (error) {
      if (callbackThrew) throw callbackError;
      throw new VaultIoError("process", safe, error);
    }
  }

  async listMarkdownFiles(roots: string[]): Promise<VaultFileInfo[]> {
    const normalized = roots.filter(Boolean).map((root) => safeVaultPath(root).replace(/\/$/, ""));
    try {
      return this.vault.getMarkdownFiles()
        .filter((file) => normalized.length === 0 || normalized.some((root) => file.path === root || file.path.startsWith(`${root}/`)))
        .map((file) => ({ path: file.path, basename: file.basename }));
    } catch (error) {
      throw new VaultIoError("list", normalized.join(","), error);
    }
  }

  async ensureFolder(path: string): Promise<void> {
    const safe = safeVaultPath(path);
    let current = "";
    for (const segment of safe.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      let existing: TAbstractFile | null;
      try {
        existing = this.vault.getAbstractFileByPath(current);
      } catch (error) {
        throw new VaultIoError("mkdir", current, error);
      }
      if (existing instanceof TFile) throw new VaultIoError("mkdir", current, new Error("A file blocks folder creation"), false);
      if (!(existing instanceof TFolder)) {
        try {
          await this.vault.createFolder(current);
        } catch (error) {
          // Another task may have created the same folder after our read.
          let raced: TAbstractFile | null;
          try {
            raced = this.vault.getAbstractFileByPath(current);
          } catch (readError) {
            throw new VaultIoError("mkdir", current, readError);
          }
          if (!(raced instanceof TFolder)) {
            throw new VaultIoError("mkdir", current, error);
          }
        }
      }
    }
  }

  private requireFile(path: string, operation: VaultOperation): TFile {
    const safe = safeVaultPath(path);
    let file: TAbstractFile | null;
    try {
      file = this.vault.getAbstractFileByPath(safe);
    } catch (error) {
      throw new VaultIoError(operation, safe, error);
    }
    if (!(file instanceof TFile)) throw new VaultIoError(operation, safe, new Error("File not found"), false);
    return file;
  }

  private async runIo<T>(operation: VaultOperation, path: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof VaultIoError) throw error;
      throw new VaultIoError(operation, path, error);
    }
  }
}
