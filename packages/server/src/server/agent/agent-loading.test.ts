import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived history after its cwd is removed and active records interactively", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const archivedCwd = path.join(root, "archived-workspace");
  const activeCwd = path.join(root, "active-workspace");
  await Promise.all([mkdir(archivedCwd), mkdir(activeCwd)]);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      const session = await baseClient.resumeSession(handle, overrides, launchContext);
      if (options?.purpose === "history") {
        session.streamHistory = async function* () {
          yield {
            type: "timeline",
            provider: "codex",
            item: { type: "assistant_message", text: "persisted response" },
          } satisfies AgentStreamEvent;
        };
      }
      return session;
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent(
      { provider: "codex", cwd: archivedCwd },
      archivedId,
      { workspaceId: "workspace-archived" },
    );
    await manager.archiveAgent(archived.id);
    await rm(archivedCwd, { recursive: true, force: true });

    const active = await manager.createAgent({ provider: "codex", cwd: activeCwd }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
    expect(manager.fetchTimeline(archived.id, { limit: 0 }).rows).toEqual([
      expect.objectContaining({
        item: { type: "assistant_message", text: "persisted response" },
      }),
    ]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stored-agent recovery before provider startup when host runtime capacity is full", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-capacity-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  let resumeCalls = 0;
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => {
      resumeCalls += 1;
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const storedId = "00000000-0000-4000-8000-000000000303";
  const liveId = "00000000-0000-4000-8000-000000000304";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, storedId, {
      workspaceId: "workspace-stored",
    });
    await manager.closeAgent(storedId);
    await manager.createAgent({ provider: "codex", cwd: root }, liveId, {
      workspaceId: "workspace-live",
    });

    await expect(
      ensureAgentLoaded(storedId, { agentManager: manager, agentStorage: storage, logger }),
    ).rejects.toMatchObject({
      name: "AgentRuntimeCapacityError",
      limit: 1,
      live: 1,
      reserved: 0,
    });
    expect(resumeCalls).toBe(0);
  } finally {
    await manager.closeAgent(liveId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects interactive resume after its cwd is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }
  const manager = new AgentManager({
    clients: { codex: baseClient },
    registry: storage,
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000305";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(agent.id);
    await rm(cwd, { recursive: true, force: true });

    await expect(
      ensureAgentLoaded(agent.id, { agentManager: manager, agentStorage: storage, logger }),
    ).rejects.toThrow(`Working directory does not exist: ${cwd}`);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
