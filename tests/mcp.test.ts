import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TaskApi, TaskCatalogOutput } from "../src/mcp/api.js";
import { TaskApiError } from "../src/mcp/api.js";
import { McpHttpGateway } from "../src/mcp/gateway.js";
import { taskBlockPutInputSchema, taskCardUpdateInputSchema } from "../src/mcp/schemas.js";

const TOKEN = "test-token-with-at-least-thirty-two-characters";

function createApi(): TaskApi & { catalogError?: TaskApiError; catalogOutput?: TaskCatalogOutput } {
  const api: TaskApi & { catalogError?: TaskApiError; catalogOutput?: TaskCatalogOutput } = {
    async catalog() {
      if (api.catalogError !== undefined) throw api.catalogError;
      return api.catalogOutput ?? { boards: [] };
    },
    async query() {
      return { tasks: [] };
    },
    async resume(input) {
      return {
        task: {
          taskId: input.task_id,
          boardId: "board-1",
          columnId: "column-1",
          title: "Test task",
          state: "active",
          objective: "Test the MCP layer",
          acceptance: ["The MCP result can be resumed"],
          revision: 1,
        },
        active_checkpoints: [],
        completed_outline: [],
      };
    },
    async read(input) {
      return { view: input.view };
    },
    async create() {
      throw new Error("not used in this test");
    },
    async cardUpdate() {
      throw new Error("not used in this test");
    },
    async checkpointCommit() {
      throw new Error("not used in this test");
    },
    async blockPut() {
      throw new Error("not used in this test");
    },
    async handoff() {
      throw new Error("not used in this test");
    },
    async finalize() {
      throw new Error("not used in this test");
    },
  };
  return api;
}

async function withGateway<T>(
  run: (context: { gateway: McpHttpGateway; endpoint: string; api: ReturnType<typeof createApi> }) => Promise<T>,
  options: { maxConcurrentRequests?: number } = {},
): Promise<T> {
  const api = createApi();
  const gateway = new McpHttpGateway({
    api,
    token: TOKEN,
    port: 0,
    ...(options.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: options.maxConcurrentRequests }),
  });
  const started = await gateway.start();
  assert.equal(started.running, true);
  assert.equal(started.host, "127.0.0.1");
  assert.ok(started.endpoint);
  try {
    return await run({ gateway, endpoint: started.endpoint, api });
  } finally {
    const stopped = await gateway.stop();
    assert.equal(stopped.running, false);
    assert.equal(stopped.port, null);
  }
}

test("registers the ten TaskDoc tools and returns structured data/errors", async () => {
  await withGateway(async ({ endpoint, api }) => {
    const client = new Client({ name: "taskdoc-mcp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    // SDK 1.30's declarations are not exactOptionalPropertyTypes-clean.
    await client.connect(transport as unknown as Transport);
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [
          "task_block_put",
          "task_card_update",
          "task_catalog",
          "task_checkpoint_commit",
          "task_create",
          "task_finalize",
          "task_handoff",
          "task_query",
          "task_read",
          "task_resume",
        ],
      );
      const createTool = listed.tools.find((tool) => tool.name === "task_create");
      const finalizeTool = listed.tools.find((tool) => tool.name === "task_finalize");
      assert.equal(createTool?.annotations?.destructiveHint, false);
      assert.equal(createTool?.annotations?.idempotentHint, false);
      assert.equal(finalizeTool?.annotations?.destructiveHint, true);
      assert.equal(finalizeTool?.annotations?.idempotentHint, false);

      const success = await client.callTool({ name: "task_catalog", arguments: {} });
      assert.equal(success.isError, undefined, JSON.stringify(success));
      assert.deepEqual(success.structuredContent, { ok: true, data: { boards: [] } });
      const successContent = success.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(JSON.parse(successContent[0]?.text ?? ""), success.structuredContent);

      api.catalogError = new TaskApiError("QUALITY_REJECTED", "Core contains a session transcript", {
        action: "revise_input",
        issues: [{ path: "/core", rule: "NO_TRANSCRIPT", message: "Remove dialogue" }],
      });
      const failure = await client.callTool({ name: "task_catalog", arguments: {} });
      assert.equal(failure.isError, true);
      assert.deepEqual(failure.structuredContent, {
        ok: false,
        error: {
          code: "QUALITY_REJECTED",
          message: "Core contains a session transcript",
          action: "revise_input",
          retryable: false,
          issues: [{ path: "/core", rule: "NO_TRANSCRIPT", message: "Remove dialogue" }],
        },
      });
      const failureContent = failure.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(JSON.parse(failureContent[0]?.text ?? ""), failure.structuredContent);

      delete api.catalogError;
      api.catalogOutput = {
        boards: [{
          id: "large-board",
          name: "x".repeat(70_000),
          projectId: "large",
          file: "Projects/large.md",
          tasksFolder: "Tasks/large",
          autoConvertCards: false,
          columns: [],
        }],
      };
      const oversized = await client.callTool({ name: "task_catalog", arguments: {} });
      assert.equal(oversized.isError, true);
      assert.equal((oversized.structuredContent as { error?: { code?: string } })?.error?.code, "INVALID_INPUT");
    } finally {
      await client.close();
    }
  });
});

test("accepts the configurable rich-block range and rejects free task types", () => {
  const baseBlock = {
    schema_version: 1 as const,
    request_id: "request-12345678",
    task_id: "task-1",
    checkpoint_id: "checkpoint-1",
    expected_revision: 0,
    block: {
      kind: "technical_spec" as const,
      title: "Large specification",
      summary: "Durable technical detail supporting the final decision",
      supports: "judgment" as const,
      content: "x".repeat(24_576),
    },
  };
  assert.equal(taskBlockPutInputSchema.safeParse(baseBlock).success, true);
  assert.equal(
    taskBlockPutInputSchema.safeParse({ ...baseBlock, block: { ...baseBlock.block, content: `${baseBlock.block.content}x` } }).success,
    true,
  );
  assert.equal(
    taskBlockPutInputSchema.safeParse({ ...baseBlock, block: { ...baseBlock.block, content: "x".repeat(200_001) } }).success,
    false,
  );

  assert.equal(
    taskCardUpdateInputSchema.safeParse({
      schema_version: 1,
      request_id: "request-12345678",
      task_id: "task-1",
      expected_revision: 1,
      type: "agent-invented-type",
    }).success,
    false,
  );
  assert.equal(
    taskCardUpdateInputSchema.safeParse({
      schema_version: 1,
      request_id: "request-12345678",
      task_id: "task-1",
      expected_revision: 1,
      state: "done",
    }).success,
    false,
  );
});

test("enforces Bearer, Host, Origin, content type, and the 1 MiB body limit", async () => {
  await withGateway(async ({ endpoint }) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "security-test", version: "1.0.0" },
      },
    });

    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(unauthorized.status, 401);

    const badOrigin = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body,
    });
    assert.equal(badOrigin.status, 403);

    const wrongMediaType = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body,
    });
    assert.equal(wrongMediaType.status, 415);

    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: `"${"x".repeat(1024 * 1024)}"`,
    });
    assert.equal(oversized.status, 413);

    const target = new URL(endpoint);
    const invalidHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          headers: {
            Host: "evil.example",
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end(body);
    });
    assert.equal(invalidHostStatus, 403);
  });
});

test("rejects requests over the configured concurrency budget", async () => {
  await withGateway(async ({ endpoint, gateway }) => {
    const target = new URL(endpoint);
    const blocker = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": "100",
      },
    });
    blocker.on("error", () => undefined);
    const blockerClosed = new Promise<void>((resolve) => blocker.once("close", () => resolve()));
    blocker.write("{");
    for (let attempt = 0; attempt < 40 && gateway.status().active_requests === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(gateway.status().active_requests, 1);

    const limited = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    blocker.destroy();
    await blockerClosed;
  }, { maxConcurrentRequests: 1 });
});
