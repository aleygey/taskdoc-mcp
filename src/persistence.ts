import { createHash } from "node:crypto";
import type { VaultAdapter } from "./types.js";
import { TaskApiError } from "./mcp/api.js";
import { canonicalJson } from "./core/crypto.js";
import { KeyedMutex } from "./util/concurrency.js";

export interface JournalEntry {
  path: string;
  before: string | null;
  after: string | null;
  intermediate?: Array<string | null>;
}
export interface RuntimeState {
  version: 1;
  requests: Record<string, { fingerprint: string; result?: unknown }>;
  journal?: { requestId: string; files: JournalEntry[] };
}
export interface RuntimeStore {
  load(): Promise<RuntimeState | undefined>;
  save(state: RuntimeState): Promise<void>;
}
export class MemoryRuntimeStore implements RuntimeStore {
  private state: RuntimeState | undefined;
  async load(): Promise<RuntimeState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }
  async save(state: RuntimeState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** One mutation at a time per vault; journal each file before touching it. */
export class MutationStore {
  private state: RuntimeState = { version: 1, requests: {} };
  private loaded = false;
  private loading: Promise<void> | undefined;
  private recording = false;
  private mutex = new KeyedMutex();
  readonly vault: VaultAdapter;

  constructor(
    private raw: VaultAdapter,
    private persistence: RuntimeStore = new MemoryRuntimeStore(),
    private changed: (path: string) => void = () => {},
  ) {
    this.vault = {
      exists: (p) => raw.exists(p),
      read: (p) => raw.read(p),
      listMarkdownFiles: (roots) => raw.listMarkdownFiles(roots),
      ensureFolder: (p) => raw.ensureFolder(p),
      create: (p, text) => this.change(p, null, text),
      write: async (p, text) => this.change(p, await raw.read(p), text),
      delete: async (p) => this.change(p, await raw.read(p), null),
      process: async (p, fn) => {
        const before = await raw.read(p);
        await this.change(p, before, fn(before));
      },
    };
  }

  async run<T>(
    requestId: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.mutex.run("mutations", async () => {
      await this.load();
      if (this.state.journal)
        throw new TaskApiError(
          "RECOVERY_REQUIRED",
          "An interrupted write needs recovery in plugin diagnostics",
          { action: "configure_plugin" },
        );
      const fingerprint = createHash("sha256")
        .update(canonicalJson(payload))
        .digest("hex");
      const key = `request:${requestId}`;
      const existing = this.state.requests[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new TaskApiError(
            "IDEMPOTENCY_CONFLICT",
            "request_id was reused with a different payload",
            { action: "revise_input" },
          );
        if (!("result" in existing))
          throw new TaskApiError(
            "IDEMPOTENCY_EXPIRED",
            "The write already completed, but its cached result expired. Reread the task; do not repeat the creation with a new ID.",
            { action: "reread" },
          );
        return structuredClone(existing.result) as T;
      }
      this.state.journal = { requestId, files: [] };
      await this.persistence.save(this.state);
      this.recording = true;
      try {
        const result = await operation();
        const next = structuredClone(this.state);
        next.requests[key] = { fingerprint, result: structuredClone(result) };
        const withResults = Object.keys(next.requests).filter(
          (id) => "result" in next.requests[id]!,
        );
        for (const id of withResults.slice(
          0,
          Math.max(0, withResults.length - 1000),
        ))
          delete next.requests[id]!.result;
        delete next.journal;
        await this.persistence.save(next);
        this.state = next;
        return result;
      } catch (error) {
        this.recording = false;
        try {
          await this.recoverInternal();
        } catch (recoveryError) {
          throw new TaskApiError(
            "RECOVERY_REQUIRED",
            "Write failed and rollback needs attention. Open TaskDoc diagnostics before retrying.",
            { action: "configure_plugin", cause: recoveryError },
          );
        }
        throw error;
      } finally {
        this.recording = false;
      }
    });
  }

  async pending(): Promise<RuntimeState["journal"]> {
    await this.load();
    return structuredClone(this.state.journal);
  }

  async recover(): Promise<void> {
    await this.mutex.run("mutations", async () => {
      await this.load();
      await this.recoverInternal();
    });
  }

  private async recoverInternal(): Promise<void> {
    const journal = this.state.journal;
    if (!journal) return;
    // Preflight all files before restoring any: preserve concurrent human changes.
    for (const entry of journal.files) {
      const current = (await this.raw.exists(entry.path))
        ? await this.raw.read(entry.path)
        : null;
      if (
        current !== entry.before &&
        current !== entry.after &&
        !entry.intermediate?.includes(current)
      )
        throw new TaskApiError(
          "RECOVERY_REQUIRED",
          `File changed after interrupted write: ${entry.path}`,
          { action: "configure_plugin" },
        );
    }
    for (const entry of [...journal.files].reverse()) {
      const current = (await this.raw.exists(entry.path))
        ? await this.raw.read(entry.path)
        : null;
      if (current === entry.before) continue;
      await this.apply(entry.path, current, entry.before);
      this.changed(entry.path);
    }
    const next = structuredClone(this.state);
    delete next.journal;
    await this.persistence.save(next);
    this.state = next;
  }

  private async change(
    path: string,
    before: string | null,
    after: string | null,
  ): Promise<void> {
    if (before === after) return;
    if (this.recording && this.state.journal) {
      const prior = this.state.journal.files.find((e) => e.path === path);
      if (prior) {
        prior.intermediate = [...(prior.intermediate ?? []), prior.after];
        prior.after = after;
      } else this.state.journal.files.push({ path, before, after });
      await this.persistence.save(this.state);
    }
    await this.apply(path, before, after);
    this.changed(path);
  }

  private async apply(
    path: string,
    before: string | null,
    after: string | null,
  ): Promise<void> {
    if (before === null) {
      if (after !== null) await this.raw.create(path, after);
      return;
    }
    if (after === null) {
      if ((await this.raw.read(path)) !== before)
        throw new TaskApiError("DOCUMENT_CONFLICT", `File changed: ${path}`, {
          action: "reread",
        });
      if (!this.raw.delete)
        throw new Error("Vault adapter cannot delete a rolled-back file");
      await this.raw.delete(path);
      return;
    }
    await this.raw.process(path, (current) => {
      if (current !== before)
        throw new TaskApiError("DOCUMENT_CONFLICT", `File changed: ${path}`, {
          action: "reread",
        });
      return after;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.loadState();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadState(): Promise<void> {
    const saved = await this.persistence.load();
    if (saved) {
      if (
        saved.version !== 1 ||
        !saved.requests ||
        typeof saved.requests !== "object"
      )
        throw new Error(
          "Invalid TaskDoc runtime state; restore the runtime backup",
        );
      this.state = saved;
    }
    this.loaded = true;
  }
}
