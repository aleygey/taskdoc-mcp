export interface PhaCapabilities {
  updateComment: boolean;
  nativeIdempotency: boolean;
  conditionalUpdate: boolean;
  searchableMetadata: boolean;
  maxCommentLength?: number;
}

export interface PhaComment {
  id: string;
  body: string;
  revision?: string;
  updatedAt?: string;
}

export interface PhaAdapter {
  readonly id: string;
  readonly capabilities: PhaCapabilities;
  validateConnection(): Promise<void>;
  listComments(taskId: string): Promise<PhaComment[]>;
  createComment(taskId: string, body: string, operationId: string): Promise<PhaComment>;
  updateComment(taskId: string, commentId: string, body: string, revision?: string): Promise<PhaComment>;
}

export class UnavailablePhaAdapter implements PhaAdapter {
  readonly id = "unavailable";
  readonly capabilities: PhaCapabilities = {
    updateComment: false,
    nativeIdempotency: false,
    conditionalUpdate: false,
    searchableMetadata: false
  };

  private fail(): never {
    throw new Error("PHA sync is unavailable until the concrete task/comment API is configured.");
  }

  async validateConnection(): Promise<void> { this.fail(); }
  async listComments(_taskId: string): Promise<PhaComment[]> { return this.fail(); }
  async createComment(_taskId: string, _body: string, _operationId: string): Promise<PhaComment> { return this.fail(); }
  async updateComment(_taskId: string, _commentId: string, _body: string, _revision?: string): Promise<PhaComment> { return this.fail(); }
}
