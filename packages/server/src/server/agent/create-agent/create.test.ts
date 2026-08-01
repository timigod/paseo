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
  recoverPendingCreateAgentCommandById,
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
          progress: {
            commands: [],
            nextCommandIndex: 0,
            inFlightCommandIndex: null,
            terminals: "pending",
          },
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
              progress: {
                commands: [],
                nextCommandIndex: 0,
                inFlightCommandIndex: null,
                terminals: "pending",
              },
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
    await creation.acknowledge(() => undefined);
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

test("pending create continuation stays inert until the create acknowledgement is published", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-unacknowledged-gate-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const originalManager = createRealAgentManager(storage);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("Expected Codex test client");
  let restartedCreateCalls = 0;
  const restartedClient = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async (...args: Parameters<AgentClient["createSession"]>) => {
          restartedCreateCalls += 1;
          return await target.createSession(...args);
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
  const registerAutoArchive = vi.fn();
  const abortError = new Error("client never received agent_created");

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
      workspaceId: "ws-unacknowledged-gate",
      initialPrompt: "Must not run before acknowledgement",
      clientMessageId: "msg-unacknowledged-gate",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      autoArchiveTarget: { kind: "agent-only" },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );

  try {
    await creation.prepareForAcknowledgement();
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      pendingCreateContinuation: { acknowledged: false },
    });

    await recoverPendingCreateAgentCommands({
      agentManager: restartedManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      registerAutoArchive,
    });

    expect(restartedCreateCalls).toBe(0);
    expect(registerAutoArchive).not.toHaveBeenCalled();
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      pendingCreateContinuation: {
        acknowledged: false,
        prompt: { status: "pending", input: "Must not run before acknowledgement" },
        autoArchive: { kind: "agent-only" },
      },
    });
  } finally {
    const completion = expect(creation.completion).rejects.toBe(abortError);
    await creation.abortBeforeAcknowledgement(abortError);
    await completion;
    originalManager.prepareForShutdown();
    restartedManager.prepareForShutdown();
    await Promise.all([originalManager.flushForShutdown(), restartedManager.flushForShutdown()]);
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("pending-create recovery aborts a provider resume blocked during shutdown", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-provider-abort-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const originalManager = createRealAgentManager(storage);
  const agent = await originalManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: "ws-provider-abort",
  });
  await originalManager.closeAgent(agent.id);
  await storage.setPendingCreateContinuation(agent.id, {
    phase: "awaiting_dispatch",
    acknowledged: true,
    prompt: { input: "resume after restart" },
  });

  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("Expected Codex test client");
  let observedSignal: AbortSignal | undefined;
  const blockedClient = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "resumeSession") {
        return async (...args: Parameters<NonNullable<AgentClient["resumeSession"]>>) => {
          observedSignal = args[3]?.signal;
          await new Promise((_resolve, reject) => {
            const signal = observedSignal;
            if (!signal) return;
            const abort = () => reject(signal.reason ?? new Error("aborted"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          throw new Error("unreachable");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentClient;
  const restartedManager = new AgentManager({
    clients: { codex: blockedClient },
    registry: storage,
    logger,
  });
  const abort = new AbortController();

  try {
    const recovery = recoverPendingCreateAgentCommandById(
      {
        agentManager: restartedManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      agent.id,
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    abort.abort(new Error("daemon shutdown"));
    await expect(recovery).rejects.toThrow("daemon shutdown");
    expect(observedSignal?.aborted).toBe(true);
    expect(restartedManager.listAgentsInternal()).toEqual([]);
  } finally {
    restartedManager.prepareForShutdown();
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
  const observedPublicEvents: string[] = [];
  const unsubscribe = manager.subscribe((event) => observedPublicEvents.push(event.type));

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
    await expect(creation.acknowledge(publish)).rejects.toThrow(
      "provider failed at acknowledgement boundary",
    );
    expect(publish).not.toHaveBeenCalled();
    await creation.abortBeforeAcknowledgement(startupError);
    await expect(storage.get(creation.snapshot.id)).resolves.toBeNull();
    expect(observedPublicEvents).toEqual([]);
  } finally {
    unsubscribe();
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
    await creation.acknowledge(publish);
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

test("an acknowledged provider-start failure retries online without a daemon restart", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-online-recovery-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("Expected Codex test client");
  const observedTurns: AgentPromptInput[] = [];
  let createAttempts = 0;
  let rejectFirstCreate!: (error: unknown) => void;
  const firstCreate = new Promise<AgentSession>((_resolve, reject) => {
    rejectFirstCreate = reject;
  });
  const client = new Proxy(baseClient, {
    get(target, property, receiver) {
      if (property === "createSession") {
        return async (...args: Parameters<AgentClient["createSession"]>) => {
          createAttempts += 1;
          if (createAttempts === 1) {
            return await firstCreate;
          }
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
  const dependencies = {
    agentManager: manager,
    agentStorage: storage,
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  try {
    const creation = await beginCreateAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "codex", cwd: workdir },
      workspaceId: "ws-online-recovery",
      initialPrompt: "Retry me online",
      clientMessageId: "msg-online-recovery",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    });
    await creation.prepareForAcknowledgement();
    await creation.acknowledge(() => undefined);
    rejectFirstCreate(new Error("transient provider start failure"));
    await expect(creation.completion).rejects.toThrow("transient provider start failure");

    await recoverPendingCreateAgentCommandById(dependencies, creation.snapshot.id);
    expect(observedTurns).toEqual(["Retry me online"]);
    expect((await storage.get(creation.snapshot.id))?.pendingCreateContinuation).toBeUndefined();
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
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
              if (sessionProperty === "streamHistory") {
                return async function* () {
                  yield {
                    type: "timeline" as const,
                    provider: "codex" as const,
                    item: {
                      type: "user_message" as const,
                      text: "Already accepted first turn",
                      clientMessageId: "msg-already-accepted",
                    },
                  };
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
    await storage.setPendingCreateContinuation(agent.id, {
      phase: "awaiting_dispatch",
      acknowledged: true,
      prompt: {
        status: "ambiguous",
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

test("a passive subscriber cannot observe a create before its durable acknowledgement", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-publication-gate-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const observedAgentIds: string[] = [];
  const unsubscribe = manager.subscribe((event) => {
    if (event.type === "agent_state") observedAgentIds.push(event.agent.id);
  });

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
        workspaceId: "ws-publication-gate",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    await Promise.resolve();
    expect(observedAgentIds).not.toContain(creation.snapshot.id);
    expect(manager.listAgents()).toEqual([]);
    expect(manager.getAgent(creation.snapshot.id)).toBeNull();
    expect(() => manager.getTimeline(creation.snapshot.id)).toThrow("Unknown agent");
    expect(() => manager.fetchTimeline(creation.snapshot.id)).toThrow("Unknown agent");
    expect(manager.getAgentInternal(creation.snapshot.id)).toMatchObject({
      id: creation.snapshot.id,
    });
    const replayedAgentIds: string[] = [];
    const unsubscribeReplay = manager.subscribe((event) => {
      if (event.type === "agent_state") replayedAgentIds.push(event.agent.id);
    });
    expect(replayedAgentIds).not.toContain(creation.snapshot.id);
    unsubscribeReplay();
    await creation.prepareForAcknowledgement();
    await creation.acknowledge(() => undefined);
    await creation.completion;
    expect(observedAgentIds).toContain(creation.snapshot.id);
  } finally {
    unsubscribe();
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("recovery refuses to replay an ambiguously dispatched first prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-ambiguous-prompt-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const observedTurns: AgentPromptInput[] = [];
  const originalStreamAgent = manager.streamAgent.bind(manager);
  manager.streamAgent = ((agentId, prompt, options) => {
    observedTurns.push(prompt);
    return originalStreamAgent(agentId, prompt, options);
  }) as typeof manager.streamAgent;

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "ws-ambiguous-prompt",
    });
    await storage.setPendingCreateContinuation(agent.id, {
      phase: "awaiting_dispatch",
      acknowledged: true,
      prompt: {
        status: "dispatching",
        input: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        runOptions: { clientMessageId: "msg-ambiguous" },
      },
    });

    await recoverPendingCreateAgentCommands({
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    });

    expect(observedTurns).toEqual([]);
    await expect(storage.get(agent.id)).resolves.toMatchObject({
      pendingCreateContinuation: { prompt: { status: "dispatching" } },
    });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("recovery refuses to replay a worktree command left in flight", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-setup-boundary-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const runWorktreeBootstrap = vi.fn(async () => undefined);

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "ws-setup-boundary",
    });
    await storage.setPendingCreateContinuation(agent.id, {
      phase: "awaiting_dispatch",
      acknowledged: true,
      setup: {
        workspaceId: "ws-setup-boundary",
        worktree: { branchName: "setup-boundary", worktreePath: workdir },
        shouldBootstrap: true,
        progress: {
          commands: ["npm install"],
          nextCommandIndex: 0,
          inFlightCommandIndex: 0,
          terminals: "pending",
        },
      },
    });

    await recoverPendingCreateAgentCommands({
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      runWorktreeBootstrap,
    });

    expect(runWorktreeBootstrap).not.toHaveBeenCalled();
    await expect(storage.get(agent.id)).resolves.toMatchObject({
      pendingCreateContinuation: { setup: { progress: { inFlightCommandIndex: 0 } } },
    });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("auto-archive intent is persisted before acknowledgement and restored with recovery", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-autoarchive-intent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const registerAutoArchive = vi.fn();

  try {
    const creation = await beginCreateAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        registerAutoArchive,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-autoarchive-intent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        autoArchiveTarget: {
          kind: "created-worktree",
          workspaceId: "ws-autoarchive-intent",
          worktreePath: workdir,
        },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );
    await creation.prepareForAcknowledgement();
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      pendingCreateContinuation: {
        autoArchive: {
          kind: "created-worktree",
          workspaceId: "ws-autoarchive-intent",
          worktreePath: workdir,
        },
      },
    });
    await creation.acknowledge(() => undefined);
    await creation.completion;
    expect(registerAutoArchive).toHaveBeenCalledWith(creation.snapshot.id, {
      kind: "created-worktree",
      workspaceId: "ws-autoarchive-intent",
      worktreePath: workdir,
    });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("modern explicit worktree setup and auto-archive use the durable continuation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-modern-worktree-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const runWorktreeBootstrap = vi.fn(async () => undefined);
  const registerAutoArchive = vi.fn();
  const workspaceId = "ws-modern-worktree";
  const setupContinuation = (
    await fakeWorktreeCreator({ repoRoot: workdir, createdWorkspaceId: workspaceId })()
  ).setupContinuation;

  try {
    const creation = await beginCreateAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        terminalManager: null,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        runWorktreeBootstrap,
        registerAutoArchive,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId,
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        autoArchive: true,
        setupContinuation,
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );
    await creation.prepareForAcknowledgement();
    await expect(storage.get(creation.snapshot.id)).resolves.toMatchObject({
      pendingCreateContinuation: {
        setup: { workspaceId },
        autoArchive: {
          kind: "created-worktree",
          workspaceId,
          worktreePath: setupContinuation.recovery.worktree.worktreePath,
        },
      },
    });
    await creation.acknowledge(() => undefined);
    await creation.completion;
    expect(runWorktreeBootstrap).toHaveBeenCalledOnce();
    expect(registerAutoArchive).toHaveBeenCalledWith(creation.snapshot.id, {
      kind: "created-worktree",
      workspaceId,
      worktreePath: setupContinuation.recovery.worktree.worktreePath,
    });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgentsInternal().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
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
