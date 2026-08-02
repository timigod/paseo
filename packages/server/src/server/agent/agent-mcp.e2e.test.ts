import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { withTimeout } from "../../utils/promise-timeout.js";
import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import * as destructiveAuthority from "./destructive-action-authority.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

async function waitForPathExists(options: {
  targetPath: string;
  timeoutMs: number;
}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for path: ${options.targetPath}`);
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(
  url: string,
  authToken?: string,
  signal?: AbortSignal,
): Promise<McpClient> {
  const requestInit = authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined;
  const abortableFetch = signal
    ? async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        return fetch(input, { ...init, signal: requestSignal });
      }
    : undefined;
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    requestInit || abortableFetch
      ? {
          ...(requestInit ? { requestInit } : {}),
          ...(abortableFetch ? { fetch: abortableFetch } : {}),
        }
      : undefined,
  );
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

interface LaunchRecorder {
  recordedLaunches: AgentSessionConfig[];
}

function findRecordedPaseoMcpServer(recorder: LaunchRecorder, agentId: string) {
  for (const launch of recorder.recordedLaunches) {
    const server = launch.mcpServers?.paseo;
    if (
      server?.type === "http" &&
      new URL(server.url).searchParams.get("callerAgentId") === agentId
    ) {
      return server;
    }
  }
  return undefined;
}

class RecordingAgentClient implements AgentClient {
  readonly provider: AgentClient["provider"];
  readonly capabilities: AgentClient["capabilities"];

  constructor(
    private readonly inner: AgentClient,
    private readonly recorder: LaunchRecorder,
  ) {
    this.provider = inner.provider;
    this.capabilities = {
      ...inner.capabilities,
      supportsMcpServers: true,
      supportsNativePaseoTools: false,
    };
  }

  async createSession(
    ...args: Parameters<AgentClient["createSession"]>
  ): ReturnType<AgentClient["createSession"]> {
    this.recorder.recordedLaunches.push(args[0]);
    return this.inner.createSession(...args);
  }

  async resumeSession(
    ...args: Parameters<AgentClient["resumeSession"]>
  ): ReturnType<AgentClient["resumeSession"]> {
    return this.inner.resumeSession(...args);
  }

  async fetchCatalog(
    ...args: Parameters<AgentClient["fetchCatalog"]>
  ): ReturnType<AgentClient["fetchCatalog"]> {
    return this.inner.fetchCatalog(...args);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

function createMcpRecordingAgentClients(recorder: LaunchRecorder) {
  const clients = createTestAgentClients();
  const claude = clients.claude;
  if (!claude) {
    throw new Error("Fake Claude client is not configured");
  }

  return {
    ...clients,
    claude: new RecordingAgentClient(claude, recorder),
  };
}

async function assertAgentNotRunning(options: {
  client: McpClient;
  agentId: string;
}): Promise<void> {
  const statusResult = await options.client.callTool({
    name: "get_agent_status",
    args: { agentId: options.agentId },
  });
  const payload = getStructuredContent(statusResult);
  if (!payload) {
    throw new Error("get_agent_status returned no structured payload");
  }
  const status = payload.status;
  if (status === "running" || status === "initializing") {
    throw new Error(`Agent still running after blocking create_agent (status=${status})`);
  }
}

describe("agent MCP end-to-end (offline)", () => {
  test("create_agent runs initial prompt and affects filesystem", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const filePath = path.join(agentCwd, "mcp-smoke.txt");
      await writeFile(filePath, "ok", "utf8");

      const initialPrompt = [
        "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
        "Run it and reply with done and stop.",
        "Do not respond before the command finishes.",
      ].join("\n");

      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP e2e smoke",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt,
          background: false,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await assertAgentNotRunning({ client, agentId: agentId! });

      if (existsSync(filePath)) {
        const contents = await readFile(filePath, "utf8");
        throw new Error(
          `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`,
        );
      }
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("default passwordless top-level MCP can archive, kill, and archive a workspace", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const archiveAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-archive-agent-"));
    const killAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-kill-agent-"));
    const workspaceCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-archive-workspace-"));
    const port = await getAvailablePort();
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);
    let agentScopedClient: McpClient | null = null;

    const createAgent = async (cwd: string, title: string): Promise<string> => {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd,
          title,
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      expect(result.isError).not.toBe(true);
      const agentId = getStructuredContent(result)?.agentId;
      if (typeof agentId !== "string") throw new Error("Expected create_agent agentId");
      return agentId;
    };

    try {
      const archiveAgentId = await createAgent(archiveAgentCwd, "Passwordless archive target");
      const killAgentId = await createAgent(killAgentCwd, "Passwordless kill target");

      const callerIdentity = daemon.agentManager.getAgentCallerIdentity(archiveAgentId);
      if (!callerIdentity) throw new Error("Expected current passwordless MCP caller identity");
      const agentScopedUrl = new URL(`http://127.0.0.1:${port}/mcp/agents`);
      agentScopedUrl.searchParams.set("callerAgentId", callerIdentity.agentId);
      agentScopedUrl.searchParams.set("callerAgentIncarnation", callerIdentity.incarnation);
      agentScopedClient = await createMcpClient(agentScopedUrl.toString());
      const selfArchiveResult = await agentScopedClient.callTool({
        name: "archive_agent",
        args: { agentId: archiveAgentId },
      });
      expect(selfArchiveResult.isError).toBe(true);
      expect(daemon.agentManager.getAgent(archiveAgentId)).not.toBeNull();

      const archiveAgentResult = await client.callTool({
        name: "archive_agent",
        args: { agentId: archiveAgentId },
      });
      expect(archiveAgentResult.isError).not.toBe(true);
      expect(daemon.agentManager.getAgent(archiveAgentId)).toBeNull();

      const killAgentResult = await client.callTool({
        name: "kill_agent",
        args: { agentId: killAgentId },
      });
      expect(killAgentResult.isError).not.toBe(true);
      expect(daemon.agentManager.getAgent(killAgentId)).toBeNull();

      const createWorkspaceResult = await client.callTool({
        name: "create_workspace",
        args: { isolation: "local", path: workspaceCwd },
      });
      expect(createWorkspaceResult.isError).not.toBe(true);
      const workspaceId = getStructuredContent(createWorkspaceResult)?.workspaceId;
      if (typeof workspaceId !== "string") {
        throw new Error("Expected create_workspace workspaceId");
      }

      const archiveWorkspaceResult = await client.callTool({
        name: "archive_workspace",
        args: { workspaceId },
      });
      expect(archiveWorkspaceResult.isError).not.toBe(true);
      const listResult = await client.callTool({ name: "list_workspaces", args: {} });
      const workspaces = getStructuredContent(listResult)?.workspaces;
      expect(Array.isArray(workspaces)).toBe(true);
      expect(
        (workspaces as Array<{ workspaceId?: string }>).some(
          (workspace) => workspace.workspaceId === workspaceId,
        ),
      ).toBe(false);
    } finally {
      await agentScopedClient?.close();
      await client.close();
      await daemon.stop();
      await Promise.all(
        [paseoHome, staticDir, archiveAgentCwd, killAgentCwd, workspaceCwd].map((target) =>
          rm(target, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);

  test("HTTP disconnect after archive authorization revokes authority before mutation", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const target = await daemon.agentManager.createAgent(
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        cwd: agentCwd,
      },
      undefined,
      { workspaceId: undefined },
    );
    let releaseAttention = () => {};
    let markAttentionStarted = () => {};
    const attentionGate = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    const attentionStarted = new Promise<void>((resolve) => {
      markAttentionStarted = resolve;
    });
    const originalClearAttention = AgentManager.prototype.clearAgentAttention;
    const clearAttentionSpy = vi
      .spyOn(AgentManager.prototype, "clearAgentAttention")
      .mockImplementation(async function (agentId) {
        if (agentId === target.id) {
          markAttentionStarted();
          await attentionGate;
        }
        return originalClearAttention.call(this, agentId);
      });
    const archiveSpy = vi.spyOn(AgentManager.prototype, "archiveAgent");
    const requestController = new AbortController();
    const client = await createMcpClient(
      `http://127.0.0.1:${port}/mcp/agents`,
      undefined,
      requestController.signal,
    );
    const revokeCallerSpy = vi.spyOn(destructiveAuthority, "revokeDestructiveCaller");

    try {
      archiveSpy.mockClear();
      const archiveResult = client
        .callTool({ name: "archive_agent", args: { agentId: target.id } })
        .catch((error) => error as Error);
      await attentionStarted;
      requestController.abort();
      await expect.poll(() => revokeCallerSpy.mock.calls.length).toBeGreaterThan(0);
      releaseAttention();

      const abortedResult = await withTimeout({
        promise: archiveResult,
        timeoutMs: 5000,
        label: "aborted MCP archive request",
      });
      expect(archiveSpy, JSON.stringify(abortedResult)).not.toHaveBeenCalled();
      expect(daemon.agentManager.getAgent(target.id)).not.toBeNull();
      expect(abortedResult instanceof Error || abortedResult.isError === true).toBe(true);
    } finally {
      releaseAttention();
      await client.close();
      clearAttentionSpy.mockRestore();
      archiveSpy.mockRestore();
      revokeCallerSpy.mockRestore();
      await daemon.stop();
      await Promise.all(
        [paseoHome, staticDir, agentCwd].map((targetPath) =>
          rm(targetPath, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);

  test("HTTP disconnect during archive storage lookup fences the archivedAt commit", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const target = await daemon.agentManager.createAgent(
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        cwd: agentCwd,
      },
      undefined,
      { workspaceId: undefined },
    );
    const originalGet = AgentStorage.prototype.get;
    let releaseLookup = () => {};
    let markLookupStarted = () => {};
    let deferLookup = true;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const getSpy = vi.spyOn(AgentStorage.prototype, "get").mockImplementation(async function (id) {
      const stack = new Error().stack ?? "";
      if (deferLookup && id === target.id && stack.includes("AgentManager.archiveAgent")) {
        deferLookup = false;
        markLookupStarted();
        await new Promise<void>((resolve) => {
          releaseLookup = resolve;
        });
      }
      return originalGet.call(this, id);
    });
    const requestController = new AbortController();
    const client = await createMcpClient(
      `http://127.0.0.1:${port}/mcp/agents`,
      undefined,
      requestController.signal,
    );
    const archiveSpy = vi.spyOn(AgentManager.prototype, "archiveAgent");
    const revokeCallerSpy = vi.spyOn(destructiveAuthority, "revokeDestructiveCaller");

    try {
      void client
        .callTool({ name: "archive_agent", args: { agentId: target.id } })
        .catch(() => undefined);
      await lookupStarted;
      const serverArchiveResult = Promise.resolve(archiveSpy.mock.results[0]?.value).catch(
        (error) => error as Error,
      );
      requestController.abort();
      await expect.poll(() => revokeCallerSpy.mock.calls.length).toBeGreaterThan(0);
      releaseLookup();

      const abortedResult = await withTimeout({
        promise: serverArchiveResult,
        timeoutMs: 5000,
        label: "server archive after aborted MCP storage lookup",
      });
      expect(abortedResult).toBeInstanceOf(Error);
      expect(daemon.agentManager.getAgent(target.id)).toBeNull();
      await expect(daemon.agentStorage.get(target.id)).resolves.toMatchObject({
        lastStatus: "closed",
      });
      expect((await daemon.agentStorage.get(target.id))?.archivedAt).toBeFalsy();
    } finally {
      releaseLookup();
      getSpy.mockRestore();
      archiveSpy.mockRestore();
      revokeCallerSpy.mockRestore();
      await client.close();
      await daemon.stop();
      await Promise.all(
        [paseoHome, staticDir, agentCwd].map((targetPath) =>
          rm(targetPath, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);

  test("HTTP disconnect during kill event drain fences live-agent removal", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const target = await daemon.agentManager.createAgent(
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        cwd: agentCwd,
      },
      undefined,
      { workspaceId: undefined },
    );
    const managerPrototype = AgentManager.prototype as unknown as {
      drainSessionEvents(agentId: string): Promise<void>;
    };
    const originalDrainSessionEvents = managerPrototype.drainSessionEvents;
    let releaseDrain = () => {};
    let markDrainStarted = () => {};
    let deferDrain = true;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    const drainSpy = vi
      .spyOn(managerPrototype, "drainSessionEvents")
      .mockImplementation(async function (agentId) {
        if (deferDrain && agentId === target.id) {
          deferDrain = false;
          markDrainStarted();
          await new Promise<void>((resolve) => {
            releaseDrain = resolve;
          });
        }
        return originalDrainSessionEvents.call(this, agentId);
      });
    const requestController = new AbortController();
    const client = await createMcpClient(
      `http://127.0.0.1:${port}/mcp/agents`,
      undefined,
      requestController.signal,
    );
    const revokeCallerSpy = vi.spyOn(destructiveAuthority, "revokeDestructiveCaller");

    try {
      const killResult = client
        .callTool({ name: "kill_agent", args: { agentId: target.id } })
        .catch((error) => error as Error);
      await drainStarted;
      requestController.abort();
      await expect.poll(() => revokeCallerSpy.mock.calls.length).toBeGreaterThan(0);
      releaseDrain();

      const abortedResult = await withTimeout({
        promise: killResult,
        timeoutMs: 5000,
        label: "aborted MCP kill during event drain",
      });
      expect(abortedResult instanceof Error || abortedResult.isError === true).toBe(true);
      expect(daemon.agentManager.getAgent(target.id)).not.toBeNull();
    } finally {
      releaseDrain();
      drainSpy.mockRestore();
      revokeCallerSpy.mockRestore();
      await client.close();
      await daemon.stop();
      await Promise.all(
        [paseoHome, staticDir, agentCwd].map((targetPath) =>
          rm(targetPath, { recursive: true, force: true }),
        ),
      );
    }
  }, 30_000);

  test("password-protected daemon authorizes the agent MCP via the capability token", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      auth: { password: hashDaemonPassword("daemon-secret") },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const capabilityToken = daemon.agentManager.getMcpAuthToken();
    expect(typeof capabilityToken).toBe("string");

    let agentId: string | null = null;
    let client: McpClient | null = null;
    try {
      // Remote auth is not weakened: a request without credentials is rejected
      // before any MCP processing.
      const unauthorized = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      // The injected capability token authenticates the full MCP handshake:
      // creating (and connecting) the client and driving a tool call both go
      // through the password-gated /mcp/agents route. (The exact bearer header
      // injected into a child agent's config is covered by the
      // runtime-mcp-config unit test.)
      client = await createMcpClient(mcpUrl, capabilityToken!);
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Password MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
    } finally {
      if (agentId) {
        await client?.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client?.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent auto-injects paseo MCP by default and can be disabled", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    const disabledPaseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-disabled-"));
    const disabledStaticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-disabled-"));
    const disabledAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-disabled-"));
    const disabledPort = await getAvailablePort();
    const disabledRecorder: LaunchRecorder = { recordedLaunches: [] };
    const disabledDaemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${disabledPort}`,
      paseoHome: disabledPaseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: false,
      staticDir: disabledStaticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(disabledRecorder),
      agentStoragePath: path.join(disabledPaseoHome, "agents"),
    };
    const disabledDaemon = await createPaseoDaemon(disabledDaemonConfig, pino({ level: "silent" }));
    await disabledDaemon.start();

    const disabledClient = await createMcpClient(`http://127.0.0.1:${disabledPort}/mcp/agents`);

    let agentId: string | null = null;
    let disabledAgentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const callerIdentity = daemon.agentManager.getAgentCallerIdentity(agentId!);
      expect(callerIdentity).toMatchObject({ agentId: agentId!, incarnation: expect.any(String) });

      expect(findRecordedPaseoMcpServer(recorder, agentId!)).toMatchObject({
        type: "http",
        url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}&callerAgentIncarnation=${callerIdentity!.incarnation}`,
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();

      const disabledResult = await disabledClient.callTool({
        name: "create_agent",
        args: {
          cwd: disabledAgentCwd,
          title: "No injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const disabledPayload = getStructuredContent(disabledResult);
      disabledAgentId =
        typeof disabledPayload?.agentId === "string" ? disabledPayload.agentId : null;
      expect(disabledAgentId).toBeTruthy();

      expect(disabledRecorder.recordedLaunches.at(-1)?.mcpServers?.paseo).toBeUndefined();
      const disabledAgent = disabledDaemon.agentManager.getAgent(disabledAgentId!);
      expect(disabledAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      if (disabledAgentId) {
        await disabledClient.callTool({ name: "kill_agent", args: { agentId: disabledAgentId } });
      }
      await disabledClient.close();
      await disabledDaemon.stop();
      await rm(disabledPaseoHome, { recursive: true, force: true });
      await rm(disabledStaticDir, { recursive: true, force: true });
      await rm(disabledAgentCwd, { recursive: true, force: true });
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent injects a loopback MCP URL when the daemon listens on all interfaces", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `0.0.0.0:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Wildcard MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const callerIdentity = daemon.agentManager.getAgentCallerIdentity(agentId!);
      expect(callerIdentity).toMatchObject({ agentId: agentId!, incarnation: expect.any(String) });

      expect(findRecordedPaseoMcpServer(recorder, agentId!)).toMatchObject({
        type: "http",
        url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}&callerAgentIncarnation=${callerIdentity!.incarnation}`,
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with background initialPrompt reflects running state once the first turn starts", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP background create",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
          background: true,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      expect(payload?.status).toBe("running");

      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("running");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent propagates initial-turn start failure instead of returning success", async () => {
    class StartTurnFailureSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly id = "mcp-start-turn-failure-session";
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("Initial turn failed to start");
      }

      subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
        return () => undefined;
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield* [];
      }

      async getRuntimeInfo() {
        return {
          provider: "codex" as const,
          sessionId: this.id,
          model: "gpt-5.4-mini",
          modeId: "full-access",
        };
      }

      async getAvailableModes(): Promise<
        Array<{ id: string; label: string; description: string }>
      > {
        return [{ id: "full-access", label: "Full access", description: "No prompts" }];
      }

      async getCurrentMode(): Promise<string | null> {
        return "full-access";
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle | null {
        return { provider: "codex", sessionId: this.id };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    class StartTurnFailureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async fetchCatalog(): Promise<{
        models: Array<{ provider: "codex"; id: string; label: string; isDefault: boolean }>;
        modes: Array<{ id: string; label: string; description: string }>;
      }> {
        return {
          models: [
            {
              provider: "codex",
              id: "gpt-5.4-mini",
              label: "gpt-5.4-mini",
              isDefault: true,
            },
          ],
          modes: [{ id: "full-access", label: "Full access", description: "No prompts" }],
        };
      }

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }

      async resumeSession(
        _handle: AgentPersistenceHandle,
        _config?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }
    }

    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: {
        ...createTestAgentClients(),
        codex: new StartTurnFailureClient(),
      },
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP start failure",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
          background: true,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await assertAgentNotRunning({ client, agentId: agentId! });
      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("error");
      const snapshot = statusPayload?.snapshot;
      const lastError =
        snapshot && typeof snapshot === "object" ? Reflect.get(snapshot, "lastError") : undefined;
      expect(lastError).toContain("Initial turn failed to start");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with worktree is async and boots terminals only after setup success", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-worktree-repo-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const { execSync } = await import("node:child_process");
      execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });
      await writeFile(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
      execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

      const setupCommand =
        'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
      await writeFile(
        path.join(repoRoot, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: [setupCommand],
            terminals: [
              {
                name: "Dev Server",
                command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
              },
            ],
          },
        }),
        "utf8",
      );
      execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'add worktree config'", {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const result = await withTimeout({
        promise: client.callTool({
          name: "create_agent",
          args: {
            cwd: repoRoot,
            title: "MCP worktree setup terminals",
            provider: "claude/claude-test-model",
            mode: "bypassPermissions",
            initialPrompt: "say done and stop",
            worktreeName: "mcp-worktree-setup-test",
            baseBranch: "main",
            background: true,
          },
        }),
        timeoutMs: 2500,
        label: "create_agent should not block on setup",
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const worktreePath = typeof payload?.cwd === "string" ? payload.cwd : "";
      expect(worktreePath).toContain(`${path.sep}worktrees${path.sep}`);
      expect(existsSync(path.join(worktreePath, "setup-done.txt"))).toBe(false);
      expect(existsSync(path.join(worktreePath, "dev-terminal.txt"))).toBe(false);

      await writeFile(path.join(worktreePath, "allow-setup"), "ok\n", "utf8");

      await waitForPathExists({
        targetPath: path.join(worktreePath, "setup-done.txt"),
        timeoutMs: 15000,
      });
      await waitForPathExists({
        targetPath: path.join(worktreePath, "dev-terminal.txt"),
        timeoutMs: 30000,
      });
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
