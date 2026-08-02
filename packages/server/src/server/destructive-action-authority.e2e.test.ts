import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DaemonClient, createTestPaseoDaemon } from "./test-utils/index.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

const SHARED_SECRET_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "destructive-authority-e2e-"));
  cleanupPaths.push(cwd);
  return cwd;
}

async function createManagedAgent(
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>,
  cwd: string,
  workspaceId?: string,
) {
  return daemon.daemon.agentManager.createAgent(
    {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "full-access",
      cwd,
    },
    undefined,
    { workspaceId },
  );
}

describe("destructive authority over real WebSocket execution paths", () => {
  test("passwordless ingress denies anonymous destruction and preserves explicit coordinator authority", async () => {
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const cliTarget = await createManagedAgent(daemon, cwd);
    const appTarget = await createManagedAgent(daemon, cwd);
    const coordinatorTarget = await createManagedAgent(daemon, cwd);
    const cli = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "default-passwordless-cli",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    const app = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "default-passwordless-app",
      clientType: "browser",
      reconnect: { enabled: false },
    });
    const coordinator = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "explicit-passwordless-coordinator",
      clientType: "cli",
      authHeader: `Bearer ${daemon.daemon.getCoordinatorAuthToken()}`,
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([cli.connect(), app.connect(), coordinator.connect()]);
      await expect(cli.archiveAgent(cliTarget.id)).rejects.toThrow("INVALID_CALLER_IDENTITY");
      await expect(app.deleteAgent(appTarget.id)).rejects.toThrow("INVALID_CALLER_IDENTITY");
      expect(daemon.daemon.agentManager.getAgent(cliTarget.id)).not.toBeNull();
      expect(daemon.daemon.agentManager.getAgent(appTarget.id)).not.toBeNull();

      await expect(coordinator.archiveAgent(coordinatorTarget.id)).resolves.toHaveProperty(
        "archivedAt",
      );
      expect(daemon.daemon.agentManager.getAgent(coordinatorTarget.id)).toBeNull();
    } finally {
      await Promise.all([cli.close(), app.close(), coordinator.close()]);
      await daemon.close();
    }
  });

  test("passwordless managed capabilities bind omitted claims and reject spoofed claims", async () => {
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const coordinator = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "managed-capability-setup",
      authHeader: `Bearer ${daemon.daemon.getCoordinatorAuthToken()}`,
      reconnect: { enabled: false },
    });
    await coordinator.connect();
    const created = await coordinator.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Managed capability workspace",
    });
    const workspaceId = created.workspace?.id;
    const projectId = created.workspace?.projectId;
    if (!workspaceId || !projectId) throw new Error(created.error ?? "Expected project workspace");

    const managed = await createManagedAgent(daemon, cwd, workspaceId);
    const other = await createManagedAgent(daemon, cwd);
    const managedToken = daemon.daemon.agentManager.getAgentIngressAuthToken(managed.id);
    const otherIdentity = daemon.daemon.agentManager.getAgentCallerIdentity(other.id);
    if (!managedToken || !otherIdentity) throw new Error("Expected managed ingress identities");
    const omitted = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "managed-capability-omitted-claim",
      authHeader: `Bearer ${managedToken}`,
      reconnect: { enabled: false },
    });
    const spoofed = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "managed-capability-spoofed-claim",
      authHeader: `Bearer ${managedToken}`,
      callerAgent: otherIdentity,
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([omitted.connect(), spoofed.connect()]);
      await expect(omitted.archiveAgent(managed.id)).rejects.toThrow("SELF_ARCHIVE_BLOCKED");
      await expect(omitted.deleteAgent(managed.id)).rejects.toThrow(
        "managed agent cannot target itself",
      );
      await expect(omitted.archiveWorkspace(workspaceId)).resolves.toMatchObject({
        archivedAt: null,
        errorCode: "SELF_ARCHIVE_BLOCKED",
      });
      await expect(omitted.removeProject(projectId)).rejects.toThrow(
        "managed agent cannot target itself",
      );

      await expect(spoofed.archiveAgent(managed.id)).rejects.toThrow("INVALID_CALLER_IDENTITY");
      await expect(spoofed.deleteAgent(managed.id)).rejects.toThrow("INVALID_CALLER_IDENTITY");
      await expect(spoofed.archiveWorkspace(workspaceId)).resolves.toMatchObject({
        archivedAt: null,
        errorCode: "INVALID_CALLER_IDENTITY",
      });
      await expect(spoofed.removeProject(projectId)).rejects.toThrow(
        "Destructive action caller identity",
      );
      expect(daemon.daemon.agentManager.getAgent(managed.id)).not.toBeNull();
      const workspaces = await coordinator.fetchWorkspaces();
      expect(workspaces.entries.map((workspace) => workspace.id)).toContain(workspaceId);
    } finally {
      await Promise.all([omitted.close(), spoofed.close(), coordinator.close()]);
      await daemon.close();
    }
  });

  test("binds agent and coordinator authority to the physical connection", async () => {
    const daemon = await createTestPaseoDaemon({
      auth: { password: SHARED_SECRET_HASH },
    });
    const cwd = createCwd();
    const agentA = await createManagedAgent(daemon, cwd);
    const agentB = await createManagedAgent(daemon, cwd);
    const agentC = await createManagedAgent(daemon, cwd);
    const terminalManager = daemon.daemon.terminalManager;
    if (!terminalManager) throw new Error("Expected terminal manager");
    const terminal = await terminalManager.createTerminal({
      cwd,
      workspaceId: "workspace-close-items-authority",
    });
    const identity = daemon.daemon.agentManager.getAgentCallerIdentity(agentA.id);
    if (!identity) throw new Error("Expected a current caller incarnation");

    const coordinator = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "coordinator-physical-connection",
      password: "shared-secret",
      reconnect: { enabled: false },
    });
    const agentCaller = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "agent-physical-connection",
      authHeader: `Bearer ${daemon.daemon.agentManager.getAgentIngressAuthToken(agentA.id)}`,
      callerAgent: identity,
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([coordinator.connect(), agentCaller.connect()]);

      const selfArchive = await agentCaller
        .archiveAgent(agentA.id)
        .catch((error) => error as Error);
      expect(selfArchive).toBeInstanceOf(Error);
      expect((selfArchive as Error).message).toContain("SELF_ARCHIVE_BLOCKED");
      expect((selfArchive as Error).message).not.toContain(agentA.id);
      expect((selfArchive as Error).message).not.toContain(cwd);

      await expect(agentCaller.deleteAgent(agentA.id)).rejects.toThrow(
        "managed agent cannot target itself",
      );
      await expect(agentCaller.closeItems({ terminalIds: [terminal.id] })).rejects.toThrow(
        "SELF_ARCHIVE_BLOCKED",
      );
      expect(terminalManager.getTerminal(terminal.id)).not.toBeUndefined();
      await expect(
        agentCaller.closeItems({
          agentIds: [agentB.id, agentA.id],
          terminalIds: [terminal.id],
        }),
      ).rejects.toThrow("SELF_ARCHIVE_BLOCKED");
      expect(daemon.daemon.agentManager.getAgent(agentA.id)).not.toBeNull();
      expect(daemon.daemon.agentManager.getAgent(agentB.id)).not.toBeNull();
      expect(terminalManager.getTerminal(terminal.id)).not.toBeUndefined();

      await expect(agentCaller.archiveAgent(agentB.id)).resolves.toHaveProperty("archivedAt");
      expect(daemon.daemon.agentManager.getAgent(agentB.id)).toBeNull();

      await daemon.daemon.agentManager.reloadAgentSession(agentA.id);
      const staleReplay = await agentCaller.deleteAgent(agentC.id).catch((error) => error as Error);
      expect(staleReplay).toBeInstanceOf(Error);
      expect((staleReplay as Error).message).toContain("INVALID_CALLER_IDENTITY");
      expect((staleReplay as Error).message).not.toContain(agentC.id);
      expect((staleReplay as Error).message).not.toContain(cwd);

      await expect(coordinator.archiveAgent(agentC.id)).resolves.toHaveProperty("archivedAt");
      expect(daemon.daemon.agentManager.getAgent(agentC.id)).toBeNull();
    } finally {
      await Promise.all([coordinator.close(), agentCaller.close()]);
      await daemon.close();
    }
  });

  test("fails closed for partial and JSON-forged caller claims", async () => {
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const partialTarget = await createManagedAgent(daemon, cwd);
    const forgedTarget = await createManagedAgent(daemon, cwd);
    const partialAgentClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "partial-agent-connection",
      clientType: "browser",
      callerAgent: { agentId: partialTarget.id },
      reconnect: { enabled: false },
    });
    const forgedCoordinatorClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "json-forged-coordinator-connection",
      callerAgent: { kind: "coordinator" } as unknown as {
        agentId?: string;
        incarnation?: string;
      },
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([partialAgentClient.connect(), forgedCoordinatorClient.connect()]);
      await expect(partialAgentClient.deleteAgent(partialTarget.id)).rejects.toThrow(
        "INVALID_CALLER_IDENTITY",
      );
      await expect(forgedCoordinatorClient.archiveAgent(forgedTarget.id)).rejects.toThrow(
        "INVALID_CALLER_IDENTITY",
      );
      expect(daemon.daemon.agentManager.getAgent(partialTarget.id)).not.toBeNull();
      expect(daemon.daemon.agentManager.getAgent(forgedTarget.id)).not.toBeNull();
    } finally {
      await Promise.all([partialAgentClient.close(), forgedCoordinatorClient.close()]);
      await daemon.close();
    }
  });

  test("disconnect during a deferred workspace lookup revokes authority before mutation", async () => {
    const originalList = FileBackedWorkspaceRegistry.prototype.list;
    const originalArchive = FileBackedWorkspaceRegistry.prototype.archive;
    const originalListAgents = AgentManager.prototype.listAgents;
    const webSocketServerPrototype = VoiceAssistantWebSocketServer.prototype as unknown as {
      revokeSocketDestructiveCaller(socket: unknown): void;
    };
    const originalRevokeSocketDestructiveCaller =
      webSocketServerPrototype.revokeSocketDestructiveCaller;
    let deferNextWorkspaceList = false;
    let releaseLookup = () => {};
    let markLookupStarted = () => {};
    let markAuthorizationReached = () => {};
    let authorizationWaitArmed = false;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const authorizationReached = new Promise<void>((resolve) => {
      markAuthorizationReached = resolve;
    });
    const listSpy = vi
      .spyOn(FileBackedWorkspaceRegistry.prototype, "list")
      .mockImplementation(async function () {
        const stack = new Error().stack ?? "";
        if (
          deferNextWorkspaceList &&
          (stack.includes("requireActiveWorkspaceForArchive") ||
            stack.includes("handleArchiveWorkspaceRequest"))
        ) {
          deferNextWorkspaceList = false;
          markLookupStarted();
          await lookupGate;
        }
        return originalList.call(this);
      });
    const archiveSpy = vi
      .spyOn(FileBackedWorkspaceRegistry.prototype, "archive")
      .mockImplementation(function (workspaceId, archivedAt) {
        return originalArchive.call(this, workspaceId, archivedAt);
      });
    const listAgentsSpy = vi
      .spyOn(AgentManager.prototype, "listAgents")
      .mockImplementation(function () {
        const agents = originalListAgents.call(this);
        if (authorizationWaitArmed) {
          authorizationWaitArmed = false;
          setImmediate(markAuthorizationReached);
        }
        return agents;
      });
    const revokeSocketSpy = vi
      .spyOn(webSocketServerPrototype, "revokeSocketDestructiveCaller")
      .mockImplementation(function (socket) {
        return originalRevokeSocketDestructiveCaller.call(this, socket);
      });
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "disconnect-deferred-workspace-lookup",
      authHeader: `Bearer ${daemon.daemon.getCoordinatorAuthToken()}`,
      reconnect: { enabled: false },
    });
    const observer = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "disconnect-deferred-workspace-observer",
      reconnect: { enabled: false },
    });

    try {
      await client.connect();
      const created = await client.createWorkspace({
        source: { kind: "directory", path: cwd },
        title: "Deferred disconnect target",
      });
      const workspaceId = created.workspace?.id;
      if (!workspaceId) throw new Error(created.error ?? "Expected created workspace");

      archiveSpy.mockClear();
      revokeSocketSpy.mockClear();
      deferNextWorkspaceList = true;
      const archiveResult = client.archiveWorkspace(workspaceId).catch((error) => error as Error);
      await lookupStarted;
      await client.close();
      await expect.poll(() => revokeSocketSpy.mock.calls.length).toBeGreaterThan(0);
      authorizationWaitArmed = true;
      releaseLookup();
      await authorizationReached;

      expect(archiveSpy).not.toHaveBeenCalled();
      await observer.connect();
      const active = await observer.fetchWorkspaces();
      expect(active.entries.map((workspace) => workspace.id)).toContain(workspaceId);
      await expect(archiveResult).resolves.toBeInstanceOf(Error);
    } finally {
      releaseLookup();
      await Promise.all([client.close(), observer.close()]);
      await daemon.close();
      revokeSocketSpy.mockRestore();
      listAgentsSpy.mockRestore();
      archiveSpy.mockRestore();
      listSpy.mockRestore();
    }
  }, 30_000);

  test("disconnect after delete authorization but before storage lookup completes fences mutation", async () => {
    const originalGet = AgentStorage.prototype.get;
    const originalBeginDelete = AgentStorage.prototype.beginDelete;
    let targetAgentId: string | null = null;
    let releaseLookup = () => {};
    let markLookupStarted = () => {};
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const getSpy = vi.spyOn(AgentStorage.prototype, "get").mockImplementation(async function (id) {
      const stack = new Error().stack ?? "";
      if (id === targetAgentId && stack.includes("handleDeleteAgentRequest")) {
        markLookupStarted();
        await lookupGate;
      }
      return originalGet.call(this, id);
    });
    const beginDeleteSpy = vi
      .spyOn(AgentStorage.prototype, "beginDelete")
      .mockImplementation(function (id) {
        return originalBeginDelete.call(this, id);
      });
    const webSocketServerPrototype = VoiceAssistantWebSocketServer.prototype as unknown as {
      revokeSocketDestructiveCaller(socket: unknown): void;
    };
    const originalRevokeSocketDestructiveCaller =
      webSocketServerPrototype.revokeSocketDestructiveCaller;
    const revokeSocketSpy = vi
      .spyOn(webSocketServerPrototype, "revokeSocketDestructiveCaller")
      .mockImplementation(function (socket) {
        return originalRevokeSocketDestructiveCaller.call(this, socket);
      });
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const target = await createManagedAgent(daemon, cwd);
    targetAgentId = target.id;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "disconnect-after-delete-authorization",
      authHeader: `Bearer ${daemon.daemon.getCoordinatorAuthToken()}`,
      reconnect: { enabled: false },
    });

    try {
      await client.connect();
      beginDeleteSpy.mockClear();
      const deleteResult = client.deleteAgent(target.id).catch((error) => error as Error);
      await lookupStarted;
      await client.close();
      await expect.poll(() => revokeSocketSpy.mock.calls.length).toBeGreaterThan(0);
      releaseLookup();

      await expect(deleteResult).resolves.toBeInstanceOf(Error);
      expect(beginDeleteSpy).not.toHaveBeenCalled();
      expect(daemon.daemon.agentManager.getAgent(target.id)).not.toBeNull();
      await expect(daemon.daemon.agentStorage.get(target.id)).resolves.not.toBeNull();
    } finally {
      releaseLookup();
      await client.close();
      await daemon.close();
      revokeSocketSpy.mockRestore();
      beginDeleteSpy.mockRestore();
      getSpy.mockRestore();
    }
  }, 30_000);

  test("disconnect before permanent delete does not commit the guarded final closed snapshot", async () => {
    const originalRemove = AgentStorage.prototype.remove;
    const originalCancelDelete = AgentStorage.prototype.cancelDelete;
    let targetAgentId: string | null = null;
    let releaseRemove = () => {};
    let markRemoveStarted = () => {};
    let deferRemove = true;
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    const removeSpy = vi
      .spyOn(AgentStorage.prototype, "remove")
      .mockImplementation(async function (id, options) {
        if (deferRemove && id === targetAgentId) {
          deferRemove = false;
          markRemoveStarted();
          await new Promise<void>((resolve) => {
            releaseRemove = resolve;
          });
        }
        return originalRemove.call(this, id, options);
      });
    const cancelDeleteSpy = vi
      .spyOn(AgentStorage.prototype, "cancelDelete")
      .mockImplementation(function (fence) {
        return originalCancelDelete.call(this, fence);
      });
    const webSocketServerPrototype = VoiceAssistantWebSocketServer.prototype as unknown as {
      revokeSocketDestructiveCaller(socket: unknown): void;
    };
    const originalRevokeSocketDestructiveCaller =
      webSocketServerPrototype.revokeSocketDestructiveCaller;
    const revokeSocketSpy = vi
      .spyOn(webSocketServerPrototype, "revokeSocketDestructiveCaller")
      .mockImplementation(function (socket) {
        return originalRevokeSocketDestructiveCaller.call(this, socket);
      });
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const target = await createManagedAgent(daemon, cwd);
    targetAgentId = target.id;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "disconnect-before-permanent-delete",
      authHeader: `Bearer ${daemon.daemon.getCoordinatorAuthToken()}`,
      reconnect: { enabled: false },
    });

    try {
      await client.connect();
      const deleteResult = client.deleteAgent(target.id).catch((error) => error as Error);
      await removeStarted;
      expect(daemon.daemon.agentManager.getAgent(target.id)).toBeNull();

      await client.close();
      await expect.poll(() => revokeSocketSpy.mock.calls.length).toBeGreaterThan(0);
      releaseRemove();

      await expect(deleteResult).resolves.toBeInstanceOf(Error);
      await expect.poll(() => cancelDeleteSpy.mock.calls.length).toBeGreaterThan(0);
      await expect
        .poll(async () => (await daemon.daemon.agentStorage.get(target.id))?.lastStatus)
        .toBe("idle");
    } finally {
      releaseRemove();
      removeSpy.mockRestore();
      cancelDeleteSpy.mockRestore();
      revokeSocketSpy.mockRestore();
      await client.close();
      await daemon.close();
    }
  }, 30_000);
});
