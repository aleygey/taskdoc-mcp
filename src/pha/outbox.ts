export type OutboxState = "pending" | "inflight" | "blocked";

export interface PhaOutboxItem {
  operationId: string;
  taskId: string;
  checkpointId: string;
  phaTaskId: string;
  commentId?: string;
  desiredBody: string;
  desiredHash: string;
  attempt: number;
  nextAttemptAt: string;
  state: OutboxState;
}

export class PhaOutbox {
  private readonly items = new Map<string, PhaOutboxItem>();

  upsert(item: PhaOutboxItem): void {
    this.items.set(`${item.phaTaskId}:${item.checkpointId}`, item);
  }

  pending(now = new Date()): PhaOutboxItem[] {
    return [...this.items.values()].filter((item) => item.state === "pending" && new Date(item.nextAttemptAt) <= now);
  }

  acknowledge(phaTaskId: string, checkpointId: string): void {
    this.items.delete(`${phaTaskId}:${checkpointId}`);
  }

  snapshot(): PhaOutboxItem[] {
    return [...this.items.values()];
  }
}
