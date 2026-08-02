import { createHash } from "node:crypto";

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.tails.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === queued) this.tails.delete(key);
    }
  }
}

interface IdempotentValue<T> {
  fingerprint: string;
  value: T;
}

export class IdempotencyStore {
  private readonly values = new Map<string, IdempotentValue<unknown>>();

  async run<T>(requestId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const fingerprint = createHash("sha256").update(stableJson(payload)).digest("hex");
    const existing = this.values.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT: request_id was reused with a different payload");
      return existing.value as T;
    }
    const value = await operation();
    this.values.set(requestId, { fingerprint, value });
    if (this.values.size > 1000) this.values.delete(this.values.keys().next().value as string);
    return value;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
