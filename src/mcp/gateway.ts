import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TaskApi } from "./api.js";
import { McpServer, type McpServerOptions } from "./server.js";

const BIND_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

export type McpHttpGatewayOptions = McpServerOptions & {
  api: TaskApi;
  token: string;
  port: number;
  allowedOrigins?: readonly string[];
  path?: string;
  maxConcurrentRequests?: number;
};

export type McpHttpGatewayStatus = {
  running: boolean;
  host: typeof BIND_HOST;
  port: number | null;
  endpoint: string | null;
  started_at: string | null;
  active_requests: number;
};

type ActiveRequest = {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
};

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class McpHttpGateway {
  private readonly api: TaskApi;
  private readonly token: string;
  private readonly configuredPort: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly path: string;
  private readonly mcpOptions: McpServerOptions;
  private readonly maxConcurrentRequests: number;
  private readonly activeRequests = new Set<ActiveRequest>();
  private inflightRequests = 0;
  private nodeServer: NodeHttpServer | undefined;
  private boundPort: number | undefined;
  private startedAt: string | undefined;

  constructor(options: McpHttpGatewayOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("port must be an integer between 0 and 65535");
    }
    if (options.token.length === 0) {
      throw new TypeError("token must not be empty");
    }
    if (options.path !== undefined && !options.path.startsWith("/")) {
      throw new TypeError("path must start with '/'");
    }
    if (options.maxConcurrentRequests !== undefined &&
        (!Number.isInteger(options.maxConcurrentRequests) || options.maxConcurrentRequests < 1 || options.maxConcurrentRequests > 128)) {
      throw new RangeError("maxConcurrentRequests must be an integer between 1 and 128");
    }

    this.api = options.api;
    this.token = options.token;
    this.configuredPort = options.port;
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
    this.path = options.path ?? DEFAULT_PATH;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.mcpOptions = {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.version === undefined ? {} : { version: options.version }),
    };
  }

  status(): McpHttpGatewayStatus {
    const running = this.nodeServer !== undefined && this.boundPort !== undefined;
    return {
      running,
      host: BIND_HOST,
      port: running ? this.boundPort ?? null : null,
      endpoint: running ? `http://${BIND_HOST}:${this.boundPort ?? 0}${this.path}` : null,
      started_at: running ? this.startedAt ?? null : null,
      active_requests: this.inflightRequests,
    };
  }

  async start(): Promise<McpHttpGatewayStatus> {
    if (this.nodeServer !== undefined) return this.status();

    const nodeServer = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.nodeServer = nodeServer;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        nodeServer.once("error", onError);
        nodeServer.listen(this.configuredPort, BIND_HOST, () => {
          nodeServer.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.nodeServer = undefined;
      throw error;
    }

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      await this.stop();
      throw new Error("HTTP gateway did not expose an IP address");
    }
    this.boundPort = (address as AddressInfo).port;
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  async stop(): Promise<McpHttpGatewayStatus> {
    const nodeServer = this.nodeServer;
    this.nodeServer = undefined;
    this.boundPort = undefined;
    this.startedAt = undefined;

    const active = [...this.activeRequests];
    this.activeRequests.clear();
    await Promise.allSettled(
      active.flatMap(({ transport, mcp }) => [transport.close(), mcp.close()]),
    );

    if (nodeServer !== undefined) {
      const closed = new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      nodeServer.closeIdleConnections?.();
      nodeServer.closeAllConnections?.();
      await closed;
    }
    return this.status();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.isAllowedHost(request.headers.host)) {
        writeJsonError(response, 403, "Invalid Host header");
        return;
      }

      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? BIND_HOST}`);
      if (requestUrl.pathname !== this.path) {
        writeJsonError(response, 404, "Not found");
        return;
      }

      const origin = getSingleHeader(request, "origin");
      if (!this.isAllowedOrigin(origin)) {
        writeJsonError(response, 403, "Origin is not allowed");
        return;
      }
      if (origin !== undefined) {
        response.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin));
        response.setHeader("Vary", "Origin");
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        writeJsonError(response, 405, "Method not allowed");
        return;
      }

      if (!this.hasValidBearer(getSingleHeader(request, "authorization"))) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="taskdoc-mcp"');
        writeJsonError(response, 401, "Unauthorized");
        return;
      }

      const mediaType = (getSingleHeader(request, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        writeJsonError(response, 415, "Content-Type must be application/json");
        return;
      }

      if (this.inflightRequests >= this.maxConcurrentRequests) {
        response.setHeader("Retry-After", "1");
        writeJsonError(response, 429, "Too many concurrent MCP requests");
        return;
      }
      this.inflightRequests += 1;
      let httpReleased = false;
      const releaseHttp = (): void => {
        if (httpReleased) return;
        httpReleased = true;
        this.inflightRequests = Math.max(0, this.inflightRequests - 1);
      };
      response.once("finish", releaseHttp);
      response.once("close", releaseHttp);

      const body = await readJsonBody(request);
      const mcp = new McpServer(this.api, this.mcpOptions);
      // SDK 1.30 models stateless mode as an explicit `undefined`, while its
      // declaration is not compiled with exactOptionalPropertyTypes.
      const transportOptions = {
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as unknown as StreamableHTTPServerTransportOptions;
      const transport = new StreamableHTTPServerTransport(transportOptions);
      const activeRequest = { mcp, transport };
      this.activeRequests.add(activeRequest);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        this.activeRequests.delete(activeRequest);
        void Promise.allSettled([transport.close(), mcp.close()]);
      };
      response.once("finish", cleanup);
      response.once("close", cleanup);

      try {
        await mcp.sdk.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        cleanup();
        if (!response.headersSent) writeJsonError(response, 500, "Internal MCP transport error");
        else response.destroy(error instanceof Error ? error : undefined);
      }
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeJsonError(response, error.status, error.message);
      } else if (!response.headersSent) {
        writeJsonError(response, 500, "Internal HTTP gateway error");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  }

  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (hostHeader === undefined || this.boundPort === undefined) return false;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      const hostname = parsed.hostname.toLowerCase();
      const port = parsed.port === "" ? 80 : Number(parsed.port);
      return (
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        (hostname === BIND_HOST || hostname === "localhost") &&
        port === this.boundPort
      );
    } catch {
      return false;
    }
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    try {
      return this.allowedOrigins.has(normalizeOrigin(origin));
    } catch {
      return false;
    }
  }

  private hasValidBearer(authorization: string | undefined): boolean {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (match === null) return false;
    const supplied = Buffer.from(match[1] ?? "", "utf8");
    const expected = Buffer.from(this.token, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

function getSingleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const lengthHeader = getSingleHeader(request, "content-length");
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) throw new HttpRequestError(400, "Invalid Content-Length");
    if (length > MAX_BODY_BYTES) throw new HttpRequestError(413, "Request body exceeds 1 MiB");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpRequestError(413, "Request body exceeds 1 MiB");
    chunks.push(chunk);
  }

  if (size === 0) throw new HttpRequestError(400, "Request body is empty");
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "Request body is not valid JSON");
  }
}

function writeJsonError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: status === 500 ? -32603 : -32000, message },
      id: null,
    }),
  );
}

export const mcpHttpGatewayDefaults = {
  host: BIND_HOST,
  path: DEFAULT_PATH,
  maxBodyBytes: MAX_BODY_BYTES,
  maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
} as const;
