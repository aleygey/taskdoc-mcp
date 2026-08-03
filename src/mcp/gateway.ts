import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TaskApi } from "./api.js";
import { McpServer, type McpServerOptions } from "./server.js";

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_CLIENT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

export type McpHttpGatewayOptions = McpServerOptions & {
  api: TaskApi;
  token: string;
  port: number;
  bindHost?: string;
  clientHost?: string;
  allowedOrigins?: readonly string[];
  path?: string;
  maxConcurrentRequests?: number;
};

export type McpHttpGatewayStatus = {
  running: boolean;
  host: string;
  client_host: string;
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
  private readonly bindHost: string;
  private readonly clientHost: string;
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
    this.bindHost = normalizeMcpBindHost(options.bindHost ?? DEFAULT_BIND_HOST);
    this.clientHost = normalizeMcpClientHost(
      options.clientHost ?? (isWildcardBindHost(this.bindHost) ? DEFAULT_CLIENT_HOST : this.bindHost),
    );
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
      host: this.bindHost,
      client_host: this.clientHost,
      port: running ? this.boundPort ?? null : null,
      endpoint: running ? formatMcpEndpoint(this.clientHost, this.boundPort ?? 0, this.path) : null,
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
        nodeServer.listen({
          port: this.configuredPort,
          host: this.bindHost,
          ...(this.bindHost === "::" ? { ipv6Only: true } : {}),
        }, () => {
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

      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? DEFAULT_BIND_HOST}`);
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
      const parsedHostname = parsed.hostname.toLowerCase();
      const hostname = parsedHostname.startsWith("[") && parsedHostname.endsWith("]")
        ? parsedHostname.slice(1, -1)
        : parsedHostname;
      const port = parsed.port === "" ? 80 : Number(parsed.port);
      return (
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        (isIP(hostname) !== 0 || hostname === "localhost" || hostname === this.clientHost) &&
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

export function normalizeMcpBindHost(input: string): string {
  return normalizeMcpHost(input, "bindHost", true);
}

export function normalizeMcpClientHost(input: string): string {
  const host = normalizeMcpHost(input, "clientHost", false);
  if (isWildcardBindHost(host)) {
    throw new TypeError("clientHost must be a reachable IP address or hostname, not a wildcard address");
  }
  return host;
}

export function formatMcpEndpoint(host: string, port: number, path = DEFAULT_PATH): string {
  const normalizedHost = normalizeMcpClientHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  if (!path.startsWith("/")) throw new TypeError("path must start with '/'");
  const urlHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return `http://${urlHost}:${port}${path}`;
}

function normalizeMcpHost(input: string, field: string, allowWildcard: boolean): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 253) throw new TypeError(`${field} must not be empty`);
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const ipVersion = isIP(unwrapped);
  if (ipVersion !== 0) {
    const normalizedIp = ipVersion === 6
      ? new URL(`http://[${unwrapped}]`).hostname.slice(1, -1)
      : unwrapped;
    if (!allowWildcard && isWildcardBindHost(normalizedIp)) {
      throw new TypeError(`${field} must not be a wildcard address`);
    }
    return normalizedIp.toLowerCase();
  }

  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.hostname.length === 0
    ) {
      throw new TypeError(`${field} must contain only an IP address or hostname`);
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const parsedIpVersion = isIP(hostname);
    if (parsedIpVersion !== 0) {
      const normalizedIp = parsedIpVersion === 6
        ? new URL(`http://[${hostname}]`).hostname.slice(1, -1)
        : hostname;
      if (!allowWildcard && isWildcardBindHost(normalizedIp)) {
        throw new TypeError(`${field} must not be a wildcard address`);
      }
      return normalizedIp;
    }
    const validDnsName = hostname.length <= 253 && hostname.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    );
    if (!validDnsName) throw new TypeError(`${field} contains an invalid hostname`);
    return hostname;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(field)) throw error;
    throw new TypeError(`${field} must contain only an IP address or hostname`, { cause: error });
  }
}

function isWildcardBindHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
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
  host: DEFAULT_BIND_HOST,
  bindHost: DEFAULT_BIND_HOST,
  clientHost: DEFAULT_CLIENT_HOST,
  path: DEFAULT_PATH,
  maxBodyBytes: MAX_BODY_BYTES,
  maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
} as const;
