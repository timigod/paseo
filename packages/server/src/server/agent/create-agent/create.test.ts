import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import {
  beginCreateAgentCommand,
  createAgentCommand,
  recoverPendingCreateAgentCommands,
} from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
} from "../agent-sdk-types.js";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: {
        kind: "agent" as const,
        recovery: {
          workspaceId: args.createdWorkspaceId,
          worktree: { branchName: "feature", worktreePath },
          workspaceCwd,
          shouldBootstrap: true,
        },
        startAfterAgentCreate: () => {},
      },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(async () => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("acknowledged creation recovers its first turn and setup continuation after a daemon crash", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-crash-recovery-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const originalBaseClient = createTestAgentClients().codex;
  const restartedBaseClient = createTestAgentClients().codex;
  if (!originalBaseClient || !restartedBaseClient) {
    throw new Error("Expected Codex test clients");
  }

  const neverCreates = new Promise<AgentSession>(() => undefined);
  const heldClient = new Proxy(originalBaseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async () => await neverCreates;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const originalManager = new AgentManager({
    clients: { codex: heldClient },
    registry: storage,
    logger,
  });

  const observedTurns: Array<{ prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  const restartedClient = new Proxy(restartedBaseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async (...args: Parameters<AgentClient["createSession"]>) => {
          const session = await target.createSession(...args);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty, sessionReceiver) {
              if (sessionProperty === "startTurn") {
                return async (prompt: AgentPromptInput, options?: AgentRunOptions) => {
                  observedTurns.push({ prompt, options });
                  return await sessionTarget.startTurn(prompt, options);
                };
              }
              const value = Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const restartedManager = new AgentManager({
    clients: { codex: restartedClient },
    registry: storage,
    logger,
  });
  const runWorktreeBootstrap = vi.fn(async () => undefined);

  try {
    const creation = await beginCreateAgentCommand(
      {
        agentManager: originalManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        initialPrompt: "Resume this exact first turn",
        clientMessageId: "msg-durable-first-turn",
        outputSchema: { type: "object", properties: { done: { type: "boolean" } } },
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: {
            kind: "agent",
            recovery: {
              workspaceId: "ws-durable-worktree",
              worktree: {
                branchName: "durable-create",
                worktreePath: join(workdir, "durable-create"),
              },
              workspaceCwd: join(workdir, "durable-create"),
              shouldBootstrap: true,
            },
            startAfterAgentCreate: () => {
              throw new Error("The crashed daemon must not reach its in-memory continuation");
            },
          },
          createdWorkspaceId: "ws-durable-worktree",
        }),
      },
    );

    await creation.prepareForAcknowledgement();
    creation.acknowledge(() => undefined);
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      pendingCreateContinuation: {
        phase: "awaiting_dispatch",
        prompt: {
          input: "Resume this exact first turn",
          runOptions: {
            clientMessageId: "msg-durable-first-turn",
            outputSchema: { type: "object", properties: { done: { type: "boolean" } } },
          },
        },
        setup: {
          workspaceId: "ws-durable-worktree",
          worktree: {
            branchName: "durable-create",
            worktreePath: join(workdir, "durable-create"),
          },
          shouldBootstrap: true,
        },
      },
    });

    await recoverPendingCreateAgentCommands({
      agentManager: restartedManager,
      agentStorage: storage,
      logger,
      terminalManager: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      runWorktreeBootstrap: async (options) => {
        await runWorktreeBootstrap(options);
      },
    });
    await recoverPendingCreateAgentCommands({
      agentManager: restartedManager,
      agentStorage: storage,
      logger,
      terminalManager: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      runWorktreeBootstrap: async (options) => {
        await runWorktreeBootstrap(options);
      },
    });

    expect(observedTurns).toEqual([
      {
        prompt: "Resume this exact first turn",
        options: {
          clientMessageId: "msg-durable-first-turn",
          outputSchema: { type: "object", properties: { done: { type: "boolean" } } },
        },
      },
    ]);
    expect(runWorktreeBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: creation.snapshot.id,
        workspaceId: "ws-durable-worktree",
        worktree: {
          branchName: "durable-create",
          worktreePath: join(workdir, "durable-create"),
        },
        shouldBootstrap: true,
      }),
    );
    expect(runWorktreeBootstrap).toHaveBeenCalledTimes(1);
    expect((await storage.get(creation.snapshot.id))?.pendingCreateContinuation).toBeUndefined();
  } finally {
    restartedManager.prepareForShutdown();
    await Promise.all(
      restartedManager.listAgents().map((agent) => restartedManager.closeAgent(agent.id)),
    );
    await restartedManager.flushForShutdown();
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider failure settled before publish cannot be acknowledged", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-pre-ack-failure-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("Expected Codex test client");
  }

  let rejectCreate!: (error: unknown) => void;
  const createResult = new Promise<AgentSession>((_resolve, reject) => {
    rejectCreate = reject;
  });
  const client = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async () => await createResult;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const creation = await beginCreateAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-pre-ack-failure",
        initialPrompt: "Must not be falsely acknowledged",
        clientMessageId: "msg-pre-ack-failure",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    await creation.prepareForAcknowledgement();
    const startupError = new Error("provider failed at acknowledgement boundary");
    rejectCreate(startupError);
    await expect(creation.completion).rejects.toBe(startupError);

    const publish = vi.fn();
    expect(() => creation.acknowledge(publish)).toThrow(
      "provider failed at acknowledgement boundary",
    );
    expect(publish).not.toHaveBeenCalled();
    await creation.abortBeforeAcknowledgement(startupError);
    await expect(storage.get(creation.snapshot.id)).resolves.toBeNull();
  } finally {
    manager.prepareForShutdown();
    await manager.flushForShutdown();
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider failure after publish preserves the acknowledged creation for recovery", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-post-ack-failure-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("Expected Codex test client");
  }

  let rejectCreate!: (error: unknown) => void;
  const createResult = new Promise<AgentSession>((_resolve, reject) => {
    rejectCreate = reject;
  });
  const client = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async () => await createResult;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const creation = await beginCreateAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-post-ack-failure",
        initialPrompt: "Recover this acknowledged first turn",
        clientMessageId: "msg-post-ack-failure",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    await creation.prepareForAcknowledgement();
    const publish = vi.fn();
    creation.acknowledge(publish);
    expect(publish).toHaveBeenCalledOnce();

    const startupError = new Error("provider failed after acknowledgement");
    rejectCreate(startupError);
    await expect(creation.completion).rejects.toBe(startupError);
    expect(manager.getAgent(creation.snapshot.id)).toBeNull();
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      lastStatus: "closed",
      lastError: "provider failed after acknowledgement",
      pendingCreateContinuation: {
        prompt: {
          input: "Recover this acknowledged first turn",
          runOptions: { clientMessageId: "msg-post-ack-failure" },
        },
      },
    });
  } finally {
    manager.prepareForShutdown();
    await manager.flushForShutdown();
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("recovery does not dispatch an already-observed first turn twice", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-dispatch-dedupe-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("Expected Codex test client");
  }

  const observedTurns: AgentPromptInput[] = [];
  const client = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async (...args: Parameters<AgentClient["createSession"]>) => {
          const session = await target.createSession(...args);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty, sessionReceiver) {
              if (sessionProperty === "startTurn") {
                return async (prompt: AgentPromptInput, options?: AgentRunOptions) => {
                  observedTurns.push(prompt);
                  return await sessionTarget.startTurn(prompt, options);
                };
              }
              const value = Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "ws-dispatch-dedupe",
    });
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: "Already accepted first turn",
      clientMessageId: "msg-already-accepted",
    });
    await storage.setPendingCreateContinuation(agent.id, {
      phase: "awaiting_dispatch",
      prompt: {
        input: "Already accepted first turn",
        runOptions: { clientMessageId: "msg-already-accepted" },
      },
    });

    await recoverPendingCreateAgentCommands({
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    });

    expect(observedTurns).toEqual([]);
    expect((await storage.get(agent.id))?.pendingCreateContinuation).toBeUndefined();
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: {
            kind: "agent",
            recovery: {
              workspaceId: "ws-new-worktree",
              worktree: { branchName: "feature", worktreePath: workdir },
              workspaceCwd: workdir,
              shouldBootstrap: true,
            },
            startAfterAgentCreate: () => {},
          },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
