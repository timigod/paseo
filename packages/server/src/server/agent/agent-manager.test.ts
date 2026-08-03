import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  AgentManager,
  AgentManagerShuttingDownError,
  ManagedWorktreeWriterConflictError,
  commandMayHaveChangedExternalState,
  type AgentManagerEvent,
  type ManagedAgent,
} from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import { toAgentPayload } from "./agent-projections.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { formatSystemNotificationPrompt } from "./agent-prompt.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent-loading.js";
import { archiveAgentCommand } from "./lifecycle-command.js";
import {
  createAgentDestructiveCaller,
  createCoordinatorDestructiveCaller,
} from "./destructive-action-authority.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentPromptInput,
  AgentProvider,
  AgentPersistenceHandle,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeCapacityController,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
  ResolveAgentDefaultModeInput,
} from "./agent-sdk-types.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import type { ProviderDefinition } from "./provider-registry.js";
import {
  DestructiveMembershipExcludedError,
  DestructiveMembershipGate,
} from "../destructive-membership-gate.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForAgentLifecycle(
  manager: AgentManager,
  agentId: string,
  lifecycle: ManagedAgent["lifecycle"],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === agentId &&
          event.agent.lifecycle === lifecycle
        ) {
          unsubscribe();
          resolve();
        }
      },
      { agentId, replayState: false },
    );
  });
}

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createFeature(args: { id: string; label: string; value: boolean }): AgentFeature {
  return {
    type: "toggle",
    id: args.id,
    label: args.label,
    value: args.value,
  };
}

function expectArchivedAgentRecord(
  record: StoredAgentRecord | null,
  expectedLastStatus: "closed" | "idle",
): void {
  expect(record).not.toBeNull();
  expect(record?.archivedAt).toEqual(
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  );
  expect(record?.lastStatus).toBe(expectedLastStatus);
  expect(record?.requiresAttention).toBe(false);
  expect(record?.attentionReason).toBeNull();
  expect(record?.attentionTimestamp).toBeNull();
}

class TestAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdConfigs: AgentSessionConfig[] = [];
  readonly resumeOverrides: Array<Partial<AgentSessionConfig> | undefined> = [];

  constructor(provider: AgentProvider = "codex") {
    this.provider = provider;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
    return new TestAgentSession(config);
  }

  async fetchCatalog() {
    return {
      models: [
        {
          provider: this.provider,
          id: "gpt-5.4",
          label: "GPT-5.4",
          isDefault: true,
        },
        {
          provider: this.provider,
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
        },
        {
          provider: this.provider,
          id: "gpt-5.2-codex",
          label: "GPT-5.2 Codex",
        },
      ],
      modes: [],
    };
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeOverrides.push(config);
    return new TestAgentSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
      daemonAppendSystemPrompt: config?.daemonAppendSystemPrompt,
    });
  }
}

class SessionRecordingAgentClient extends TestAgentClient {
  readonly sessions: TestAgentSession[] = [];

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new TestAgentSession(config);
    this.sessions.push(session);
    return session;
  }
}

class HeldAgentCreationClient extends TestAgentClient {
  private readonly creationStarted = deferred<void>();
  private readonly creationAllowed = deferred<void>();
  createSessionCalls = 0;
  creationFailure: Error | null = null;
  createdSessionClosed = false;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createSessionCalls += 1;
    const recordSessionClosed = () => {
      this.createdSessionClosed = true;
    };
    const session = new (class extends TestAgentSession {
      override async close(): Promise<void> {
        recordSessionClosed();
      }
    })(config);
    this.creationStarted.resolve();
    await this.creationAllowed.promise;
    if (this.creationFailure) {
      throw this.creationFailure;
    }
    return session;
  }

  waitForCreationToStart(): Promise<void> {
    return this.creationStarted.promise;
  }

  finishCreating(): void {
    this.creationAllowed.resolve();
  }
}

class HeldFirstSessionCloseClient extends TestAgentClient {
  private readonly firstCloseStarted = deferred<void>();
  private readonly firstCloseAllowed = deferred<void>();
  private readonly firstCloseFinished = deferred<void>();
  createSessionCalls = 0;
  resumeSessionCalls = 0;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createSessionCalls += 1;
    if (this.createSessionCalls !== 1) {
      return new TestAgentSession(config);
    }

    const started = this.firstCloseStarted;
    const allowed = this.firstCloseAllowed;
    const finished = this.firstCloseFinished;
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        started.resolve();
        await allowed.promise;
        finished.resolve();
      }
    })(config);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeSessionCalls += 1;
    return await super.resumeSession(handle, config, launchContext);
  }

  waitForFirstCloseToStart(): Promise<void> {
    return this.firstCloseStarted.promise;
  }

  finishFirstClose(): void {
    this.firstCloseAllowed.resolve();
  }

  waitForFirstCloseToFinish(): Promise<void> {
    return this.firstCloseFinished.promise;
  }
}

class HeldAgentCreationAndCloseClient extends TestAgentClient {
  private readonly creationStarted = deferred<void>();
  private readonly creationAllowed = deferred<void>();
  private readonly closeStarted = deferred<void>();
  private readonly closeAllowed = deferred<void>();

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.creationStarted.resolve();
    await this.creationAllowed.promise;
    const signalCloseStarted = () => this.closeStarted.resolve();
    const waitForClose = () => this.closeAllowed.promise;
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        signalCloseStarted();
        await waitForClose();
      }
    })(config);
  }

  waitForCreationToStart(): Promise<void> {
    return this.creationStarted.promise;
  }

  finishCreating(): void {
    this.creationAllowed.resolve();
  }

  waitForCloseToStart(): Promise<void> {
    return this.closeStarted.promise;
  }

  finishClosing(): void {
    this.closeAllowed.resolve();
  }
}

class HeldReloadCloseClient extends TestAgentClient {
  private readonly closeStarted = deferred<void>();
  private readonly closeAllowed = deferred<void>();
  originalSessionClosed = false;
  replacementSessionClosed = false;
  resumeCount = 0;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const signalCloseStarted = () => this.closeStarted.resolve();
    const waitForClose = () => this.closeAllowed.promise;
    const recordOriginalClosed = () => {
      this.originalSessionClosed = true;
    };
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        signalCloseStarted();
        await waitForClose();
        recordOriginalClosed();
      }
    })(config);
  }

  override async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeCount += 1;
    const recordReplacementClosed = () => {
      this.replacementSessionClosed = true;
    };
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        recordReplacementClosed();
      }
    })({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }

  waitForCloseToStart(): Promise<void> {
    return this.closeStarted.promise;
  }

  finishClosing(): void {
    this.closeAllowed.resolve();
  }
}

class NativeArchiveRecordingClient extends TestAgentClient {
  readonly archivedHandles: AgentPersistenceHandle[] = [];
  readonly unarchivedHandles: AgentPersistenceHandle[] = [];
  readArchivedAtDuringUnarchive: (() => Promise<string | null | undefined>) | null = null;
  archivedAtDuringUnarchive: string | null | undefined;
  unarchiveFailure: Error | null = null;
  private unarchiveStarted: Deferred<void> | null = null;
  private unarchiveAllowed: Deferred<void> | null = null;

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.archivedHandles.push(handle);
  }

  async unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.unarchivedHandles.push(handle);
    this.unarchiveStarted?.resolve();
    if (this.unarchiveAllowed) {
      await this.unarchiveAllowed.promise;
    }
    if (this.readArchivedAtDuringUnarchive) {
      this.archivedAtDuringUnarchive = await this.readArchivedAtDuringUnarchive();
    }
    if (this.unarchiveFailure) {
      throw this.unarchiveFailure;
    }
  }

  holdNativeUnarchive(): void {
    this.unarchiveStarted = deferred<void>();
    this.unarchiveAllowed = deferred<void>();
  }

  waitForNativeUnarchive(): Promise<void> {
    if (!this.unarchiveStarted) {
      throw new Error("Native unarchive is not held");
    }
    return this.unarchiveStarted.promise;
  }

  finishNativeUnarchive(): void {
    if (!this.unarchiveAllowed) {
      throw new Error("Native unarchive is not held");
    }
    this.unarchiveAllowed.resolve();
    this.unarchiveStarted = null;
    this.unarchiveAllowed = null;
  }
}

class EnvProbeAgentClient extends TestAgentClient {
  probe: Promise<{ probe: string | null; agentId: string | null }> | null = null;

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const script = `
      process.stdout.write(JSON.stringify({
        probe: process.env.CHUNK14_PROBE ?? null,
        agentId: process.env.PASEO_AGENT_ID ?? null
      }));
    `;
    const child = spawn(process.execPath, ["-e", script], {
      cwd: config.cwd,
      env: { ...process.env, ...launchContext?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.probe = new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`env probe exited ${code}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as { probe: string | null; agentId: string | null });
      });
    });
    return new TestAgentSession(config);
  }
}

class TestAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private runtimeModel: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;
  private interrupted = false;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.interrupted = false;
    const turnId = `turn-${++this.turnIdCounter}`;
    // Use setTimeout so events arrive after the caller sets up the foreground waiter
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      this.runtimeModel = "gpt-5.2-codex";
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // error isolation per design
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {}
}

class RegistrationCleanupSession extends TestAgentSession {
  closeCalls = 0;
  activeSubscriptions = 0;

  constructor(
    config: AgentSessionConfig,
    private readonly closeFailure: Error | null = null,
  ) {
    super(config);
  }

  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    const unsubscribe = super.subscribe(callback);
    this.activeSubscriptions += 1;
    return () => {
      this.activeSubscriptions -= 1;
      unsubscribe();
    };
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure) throw this.closeFailure;
  }
}

class ControlledInterruptSession extends TestAgentSession {
  interruptCalled = false;
  interruptCallCount = 0;

  constructor(
    config: AgentSessionConfig,
    readonly turnId: string,
    private readonly interruptBehavior: (session: ControlledInterruptSession) => Promise<void>,
  ) {
    super(config);
  }

  override async startTurn(): Promise<{ turnId: string }> {
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId: this.turnId });
    }, 0);
    return { turnId: this.turnId };
  }

  override async interrupt(): Promise<void> {
    this.interruptCalled = true;
    this.interruptCallCount += 1;
    await this.interruptBehavior(this);
  }
}

interface ControlledInterruptFixture {
  agentId: string;
  manager: AgentManager;
  session: ControlledInterruptSession;
  startForegroundRun(): Promise<void>;
  cleanup(): void;
}

async function createControlledInterruptFixture(options: {
  name: string;
  agentId: string;
  turnId: string;
  interrupt: (session: ControlledInterruptSession) => Promise<void>;
}): Promise<ControlledInterruptFixture> {
  const workdir = mkdtempSync(join(tmpdir(), `agent-manager-${options.name}-`));
  const session = new ControlledInterruptSession(
    { provider: "codex", cwd: workdir },
    options.turnId,
    options.interrupt,
  );
  const client = new (class extends TestAgentClient {
    override async createSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    rescueTimeouts: { interruptSessionMs: 10 },
    idFactory: () => options.agentId,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  return {
    agentId: agent.id,
    manager,
    session,
    async startForegroundRun() {
      const run = manager.streamAgent(agent.id, "exercise cancellation");
      void (async () => {
        for await (const _event of run) {
          // Keep the foreground stream subscribed until the controlled turn settles.
        }
      })();
      await manager.waitForAgentRunStart(agent.id);
    },
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

class HeldRuntimeInfoSession extends TestAgentSession {
  private readonly runtimeInfoRequested = deferred<void>();
  private readonly runtimeInfoAllowed = deferred<void>();

  override async getRuntimeInfo() {
    this.runtimeInfoRequested.resolve();
    await this.runtimeInfoAllowed.promise;
    return await super.getRuntimeInfo();
  }

  waitForRuntimeInfo(): Promise<void> {
    return this.runtimeInfoRequested.promise;
  }

  finishRuntimeInfo(): void {
    this.runtimeInfoAllowed.resolve();
  }
}

class HeldRuntimeInfoClient extends TestAgentClient {
  private readonly sessionCreated = deferred<HeldRuntimeInfoSession>();
  private session: HeldRuntimeInfoSession | null = null;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new HeldRuntimeInfoSession(config);
    this.sessionCreated.resolve(this.session);
    return this.session;
  }

  async waitForRuntimeInfo(): Promise<void> {
    const session = await this.sessionCreated.promise;
    await session.waitForRuntimeInfo();
  }

  finishRuntimeInfo(): void {
    this.requireSession().finishRuntimeInfo();
  }

  private requireSession(): HeldRuntimeInfoSession {
    if (!this.session) {
      throw new Error("Expected a created session");
    }
    return this.session;
  }
}

type InitializationTerminalEvent = Extract<
  AgentStreamEvent,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

class InitializationTerminalSession extends TestAgentSession {
  subscriptionCount = 0;
  closeCount = 0;

  constructor(
    config: AgentSessionConfig,
    private readonly terminalEvent: InitializationTerminalEvent,
    private readonly onAvailableModes?: () => void,
  ) {
    super(config);
  }

  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscriptionCount += 1;
    const unsubscribe = super.subscribe(callback);
    return () => {
      this.subscriptionCount -= 1;
      unsubscribe();
    };
  }

  override async getAvailableModes() {
    this.pushEvent(this.terminalEvent);
    this.onAvailableModes?.();
    return [];
  }

  override async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class StreamingAssistantSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turnIdCounter}`;
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: "final " },
      });
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: "reply" },
      });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class StreamingAssistantClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new StreamingAssistantSession(config);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new StreamingAssistantSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }
}

interface FakeCodexEmitterArgs {
  turnItems?: AgentTimelineItem[];
  historyItems?: AgentTimelineItem[];
}

function fakeCodexEmitting(args: FakeCodexEmitterArgs): AgentClient {
  const turnItems = args.turnItems ?? [];
  const historyItems = args.historyItems ?? [];

  class FakeCodexSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-fake-codex";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        for (const item of turnItems) {
          this.pushEvent({ type: "timeline", provider: this.provider, item, turnId });
        }
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }

    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      for (const item of historyItems) {
        yield { type: "timeline", provider: this.provider, item };
      }
    }
  }

  return {
    provider: "codex",
    capabilities: TEST_CAPABILITIES,
    async isAvailable() {
      return true;
    },
    async createSession(config: AgentSessionConfig) {
      return new FakeCodexSession(config);
    },
    async resumeSession() {
      throw new Error("unused");
    },
  };
}

const logger = createTestLogger();

test("reserves host runtime capacity before concurrent provider startup", async () => {
  const client = new HeldAgentCreationClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
    idFactory: () => "00000000-0000-4000-8000-000000000094",
  });

  const first = manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000094",
    { workspaceId: undefined },
  );
  await client.waitForCreationToStart();

  expect(manager.getRuntimeCapacitySnapshot()).toEqual({
    limit: 1,
    live: 0,
    reserved: 1,
    free: 0,
  });

  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000095",
      { workspaceId: undefined },
    ),
  ).rejects.toMatchObject({
    name: "AgentRuntimeCapacityError",
    limit: 1,
    live: 0,
    reserved: 1,
  });
  expect(client.createSessionCalls).toBe(1);

  client.finishCreating();
  const created = await first;
  expect(manager.getRuntimeCapacitySnapshot()).toEqual({
    limit: 1,
    live: 1,
    reserved: 0,
    free: 0,
  });
  await manager.closeAgent(created.id);
  expect(manager.getRuntimeCapacitySnapshot()).toEqual({
    limit: 1,
    live: 0,
    reserved: 0,
    free: 1,
  });
});

test("preflights ordinary provider capacity before caller-owned placement work", async () => {
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const live = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000086",
    {},
  );

  await expect(manager.preflightAgentRegistration("codex")).rejects.toMatchObject({
    name: "AgentRuntimeCapacityError",
    live: 1,
    reserved: 0,
  });
  await manager.closeAgent(live.id);
  await expect(manager.preflightAgentRegistration("codex")).resolves.toBeUndefined();
});

test("lets a source-managed provider admit normal agent creation without double charging", async () => {
  class SourceManagedClient extends TestAgentClient {
    readonly managesRuntimeCapacityAtSource = true as const;
    private controller: AgentRuntimeCapacityController | null = null;

    configureRuntimeCapacityController(controller: AgentRuntimeCapacityController): void {
      this.controller = controller;
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      if (!this.controller) throw new Error("missing runtime capacity controller");
      const reservation = this.controller.reserve();
      const session = await super.createSession(config);
      reservation.track(session);
      const close = session.close.bind(session);
      session.close = async () => {
        await close();
        this.controller?.release(session);
      };
      return session;
    }
  }

  const client = new SourceManagedClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const first = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000089",
    {},
  );

  // The source knows whether it can reuse the existing provider process, so a
  // generic preflight must not reserve a second slot or reject too early.
  await expect(manager.preflightAgentRegistration("codex")).resolves.toBeUndefined();

  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000090",
      {},
    ),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1, reserved: 0 });

  await manager.closeAgent(first.id);
  const second = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000090",
    {},
  );
  await manager.closeAgent(second.id);
});

test("rejects source-managed provider registration without capacity controller injection", () => {
  class InvalidSourceManagedClient extends TestAgentClient {
    readonly managesRuntimeCapacityAtSource = true as const;
  }

  const invalid = new InvalidSourceManagedClient("cursor");
  expect(
    () =>
      new AgentManager({
        clients: { cursor: invalid },
        logger,
        maxActiveAgentRuntimes: 1,
      }),
  ).toThrow(
    "Provider 'cursor' claims source-managed runtime capacity without configureRuntimeCapacityController",
  );

  const manager = new AgentManager({ clients: {}, logger, maxActiveAgentRuntimes: 1 });
  expect(() => manager.registerClient("cursor", invalid)).toThrow(
    "Provider 'cursor' claims source-managed runtime capacity without configureRuntimeCapacityController",
  );
  expect(manager.getRegisteredProviderIds()).toEqual([]);
});

test("applies host runtime capacity before fallback draft discovery starts a session", async () => {
  class DraftDiscoveryClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }

  const client = new DraftDiscoveryClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const live = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000096",
    { workspaceId: undefined },
  );

  await expect(
    manager.listDraftCommands({ provider: "codex", cwd: process.cwd(), model: "gpt-5.4" }),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1, reserved: 0 });
  await expect(
    manager.listDraftFeatures({ provider: "codex", cwd: process.cwd(), model: "gpt-5.4" }),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1, reserved: 0 });
  expect(client.createSessionCalls).toBe(1);

  await manager.closeAgent(live.id);
});

test("keeps fallback draft discovery charged when its session does not close", async () => {
  class DraftCommandSession extends TestAgentSession {
    override async listCommands(): Promise<AgentSlashCommand[]> {
      return [];
    }

    override async close(): Promise<void> {
      throw new Error("draft session cleanup failed");
    }
  }
  class DraftDiscoveryClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return new DraftCommandSession(config);
    }
  }

  const client = new DraftDiscoveryClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });

  await expect(
    manager.listDraftCommands({ provider: "codex", cwd: process.cwd(), model: "gpt-5.4" }),
  ).resolves.toEqual([]);
  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000097",
      { workspaceId: undefined },
    ),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1, reserved: 0 });
  expect(client.createSessionCalls).toBe(1);
});

test("counts errored provider runtimes until they are closed", async () => {
  const client = new SessionRecordingAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const first = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000091",
    { workspaceId: undefined },
  );

  client.sessions[0]?.pushEvent({
    type: "turn_failed",
    provider: "codex",
    error: "provider failed",
    turnId: "failed-turn",
  });
  await vi.waitFor(() => expect(manager.getAgent(first.id)?.lifecycle).toBe("error"));

  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000092",
      { workspaceId: undefined },
    ),
  ).rejects.toMatchObject({ limit: 1, live: 1, reserved: 0 });

  await manager.closeAgent(first.id);
  const replacement = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000093",
    { workspaceId: undefined },
  );
  await manager.closeAgent(replacement.id);
});

test("releases capacity and closes the provider runtime when registration fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-capacity-registration-failure-"));
  class FailFirstSnapshotStorage extends AgentStorage {
    private shouldFail = true;

    override async applySnapshot(
      agent: ManagedAgent,
      options?: { title?: string | null; internal?: boolean },
    ): Promise<void> {
      if (this.shouldFail) {
        this.shouldFail = false;
        throw new Error("snapshot failed");
      }
      await super.applySnapshot(agent, options);
    }
  }
  class CloseRecordingClient extends TestAgentClient {
    firstSessionClosed = false;
    private attempt = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.attempt += 1;
      if (this.attempt !== 1) {
        return new TestAgentSession(config);
      }
      const recordClosed = () => {
        this.firstSessionClosed = true;
      };
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          recordClosed();
        }
      })(config);
    }
  }

  const client = new CloseRecordingClient();
  const storage = new FailFirstSnapshotStorage(join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    maxActiveAgentRuntimes: 1,
  });

  try {
    await expect(
      manager.createAgent(
        { provider: "codex", cwd: root },
        "00000000-0000-4000-8000-000000000088",
        { workspaceId: undefined },
      ),
    ).rejects.toThrow("snapshot failed");
    expect({ agents: manager.listAgents(), firstSessionClosed: client.firstSessionClosed }).toEqual(
      {
        agents: [],
        firstSessionClosed: true,
      },
    );

    const second = await manager.createAgent(
      { provider: "codex", cwd: root },
      "00000000-0000-4000-8000-000000000089",
      { workspaceId: undefined },
    );
    await manager.closeAgent(second.id);
  } finally {
    await storage.flush().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("releases reserved capacity when provider startup fails", async () => {
  class FailFirstStartupClient extends TestAgentClient {
    private shouldFail = true;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      if (this.shouldFail) {
        this.shouldFail = false;
        throw new Error("provider startup failed");
      }
      return new TestAgentSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new FailFirstStartupClient() },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000083",
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("provider startup failed");

  const created = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000084",
    { workspaceId: undefined },
  );
  await manager.closeAgent(created.id);
});

test("keeps a runtime charged until provider close completes", async () => {
  const client = new HeldFirstSessionCloseClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const first = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000080",
    { workspaceId: undefined },
  );

  const closing = manager.closeAgent(first.id);
  await client.waitForFirstCloseToStart();
  await expect(
    manager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      "00000000-0000-4000-8000-000000000081",
      { workspaceId: undefined },
    ),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1, reserved: 0 });
  expect(client.createSessionCalls).toBe(1);

  client.finishFirstClose();
  await closing;
  const replacement = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000082",
    { workspaceId: undefined },
  );
  await manager.closeAgent(replacement.id);
});

test("retries failed registration cleanup before admitting a replacement runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-capacity-close-failure-"));
  class FailFirstSnapshotStorage extends AgentStorage {
    private shouldFail = true;

    override async applySnapshot(
      agent: ManagedAgent,
      options?: { title?: string | null; internal?: boolean },
    ): Promise<void> {
      if (this.shouldFail) {
        this.shouldFail = false;
        throw new Error("snapshot failed");
      }
      await super.applySnapshot(agent, options);
    }
  }
  class RetryableCloseClient extends TestAgentClient {
    createSessionCalls = 0;
    firstSessionCloseCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      if (this.createSessionCalls !== 1) {
        return new TestAgentSession(config);
      }
      const recordClose = () => {
        this.firstSessionCloseCalls += 1;
        return this.firstSessionCloseCalls;
      };
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          if (recordClose() === 1) {
            throw new Error("provider close failed");
          }
        }
      })(config);
    }
  }

  const client = new RetryableCloseClient();
  const storage = new FailFirstSnapshotStorage(join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    maxActiveAgentRuntimes: 1,
  });

  try {
    const failedRegistration = await manager
      .createAgent({ provider: "codex", cwd: root }, "00000000-0000-4000-8000-000000000077", {
        workspaceId: undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failedRegistration).toBeInstanceOf(AggregateError);
    expect((failedRegistration as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "snapshot failed" }),
      expect.objectContaining({ message: "provider close failed" }),
    ]);
    expect(client.firstSessionCloseCalls).toBe(1);

    const replacement = await manager.createAgent(
      { provider: "codex", cwd: root },
      "00000000-0000-4000-8000-000000000078",
      { workspaceId: undefined },
    );
    expect(client.firstSessionCloseCalls).toBe(2);
    expect(client.createSessionCalls).toBe(2);
    await manager.closeAgent(replacement.id);
  } finally {
    await storage.flush().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown retries a retained agent runtime cleanup", async () => {
  let closeCalls = 0;
  class RetryableCloseClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          closeCalls += 1;
          if (closeCalls === 1) {
            throw new Error("provider close failed");
          }
        }
      })(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new RetryableCloseClient() },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000076",
    { workspaceId: undefined },
  );

  await expect(manager.closeAgent(agent.id)).rejects.toThrow("provider close failed");
  manager.prepareForShutdown();
  await manager.flushForShutdown();
  expect(closeCalls).toBe(2);
});

test("keeps timed-out reload runtimes charged until their late close completes", async () => {
  const client = new HeldFirstSessionCloseClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 2,
    rescueTimeouts: { reloadSessionCloseMs: 1 },
  });
  const first = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000079",
    { workspaceId: undefined },
  );

  const reloading = manager.reloadAgentSession(first.id);
  await client.waitForFirstCloseToStart();
  const reloaded = await reloading;
  await expect(manager.reloadAgentSession(reloaded.id)).rejects.toMatchObject({
    name: "AgentRuntimeCapacityError",
    live: 2,
    reserved: 0,
  });
  expect(client.resumeSessionCalls).toBe(1);

  client.finishFirstClose();
  await client.waitForFirstCloseToFinish();
  await manager.closeAgent(reloaded.id);
});

test("applies one runtime limit to resume, import, and reload startup paths", async () => {
  class StartupRecordingClient extends TestAgentClient {
    resumeCalls = 0;
    importCalls = 0;

    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.resumeCalls += 1;
      return await super.resumeSession(handle, config, launchContext);
    }

    async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
      this.importCalls += 1;
      return {
        session: new TestAgentSession(context.storedConfig),
        config: context.storedConfig,
        persistence: {
          provider: "codex" as const,
          sessionId: input.providerHandleId,
        },
        timeline: [],
      };
    }
  }

  const client = new StartupRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
  });
  const live = await manager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    "00000000-0000-4000-8000-000000000085",
    { workspaceId: undefined },
  );
  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "capacity-resume",
    metadata: { provider: "codex", cwd: process.cwd() },
  };

  await expect(
    manager.resumeAgentFromPersistence(handle, undefined, "00000000-0000-4000-8000-000000000086"),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1 });
  await expect(
    manager.importProviderSession({
      provider: "codex",
      providerHandleId: "capacity-import",
      cwd: process.cwd(),
      workspaceId: "workspace-capacity",
    }),
  ).rejects.toMatchObject({ name: "AgentRuntimeCapacityError", live: 1 });
  await expect(manager.reloadAgentSession(live.id)).rejects.toMatchObject({
    name: "AgentRuntimeCapacityError",
    live: 1,
  });

  expect({ resumeCalls: client.resumeCalls, importCalls: client.importCalls }).toEqual({
    resumeCalls: 0,
    importCalls: 0,
  });
  expect(manager.getAgent(live.id)?.lifecycle).toBe("idle");
  await manager.closeAgent(live.id);
});

test("does not register a session that finishes starting after shutdown begins", async () => {
  const client = new HeldAgentCreationClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    maxActiveAgentRuntimes: 1,
    idFactory: () => "00000000-0000-4000-8000-000000000100",
  });

  const creation = manager.createAgent(
    {
      provider: "codex",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
  await client.waitForCreationToStart();

  manager.prepareForShutdown();
  client.finishCreating();

  await expect(creation).rejects.toThrow("Agent manager is shutting down");
  expect({ agents: manager.listAgents(), sessionClosed: client.createdSessionClosed }).toEqual({
    agents: [],
    sessionClosed: true,
  });
});

test("flush waits for rejected session cleanup that starts after shutdown", async () => {
  const client = new HeldAgentCreationAndCloseClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000098",
  });

  const creation = manager
    .createAgent(
      {
        provider: "codex",
        cwd: process.cwd(),
      },
      undefined,
      { workspaceId: undefined },
    )
    .catch((error: unknown) => error);
  await client.waitForCreationToStart();

  manager.prepareForShutdown();
  let flushResolved = false;
  const flushing = manager.flushForShutdown().then(() => {
    flushResolved = true;
    return undefined;
  });
  client.finishCreating();
  await client.waitForCloseToStart();

  try {
    expect(flushResolved).toBe(false);
  } finally {
    client.finishClosing();
  }

  expect(await creation).toBeInstanceOf(AgentManagerShuttingDownError);
  await flushing;
  expect(manager.listAgents()).toEqual([]);
});

test("background task rejection does not create an unhandled derived rejection", async () => {
  const manager = new AgentManager({ clients: {}, logger });
  const task = deferred<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    manager.trackBackgroundTask(task.promise);
    let flushResolved = false;
    const flushing = manager.flushForShutdown().then(() => {
      flushResolved = true;
      return undefined;
    });
    await Promise.resolve();

    expect(flushResolved).toBe(false);
    task.reject(new Error("background task failed"));
    await flushing;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
    await expect(manager.flushForShutdown()).resolves.toBeUndefined();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("does not persist an initializing session after shutdown closes it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-shutdown-register-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldRuntimeInfoClient();
  const agentId = "00000000-0000-4000-8000-000000000099";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { agentId, replayState: false });

  try {
    const creation = manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    await client.waitForRuntimeInfo();

    manager.prepareForShutdown();
    const closing = manager.closeAgent(agentId);
    client.finishRuntimeInfo();

    await expect(creation).rejects.toBeInstanceOf(AgentManagerShuttingDownError);
    await closing;
    await storage.flush();
    expect({ agents: manager.listAgents(), record: await storage.get(agentId) }).toMatchObject({
      agents: [],
      record: { lastStatus: "closed" },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "completed",
    event: { type: "turn_completed", provider: "codex", turnId: "restored-turn" } as const,
    lifecycle: "idle" as const,
    lastError: undefined,
  },
  {
    name: "failed",
    event: {
      type: "turn_failed",
      provider: "codex",
      turnId: "restored-turn",
      error: "restored turn failed",
    } as const,
    lifecycle: "error" as const,
    lastError: "restored turn failed",
  },
  {
    name: "canceled",
    event: {
      type: "turn_canceled",
      provider: "codex",
      turnId: "restored-turn",
      reason: "interrupted",
    } as const,
    lifecycle: "idle" as const,
    lastError: undefined,
  },
])("restored session keeps $name events emitted during initialization", async (testCase) => {
  const agentId = "00000000-0000-4000-8000-000000000107";
  const session = new InitializationTerminalSession(
    { provider: "codex", cwd: process.cwd() },
    testCase.event,
  );
  const client = new (class extends TestAgentClient {
    override async resumeSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, logger });

  try {
    const snapshot = await manager.resumeAgentFromPersistence(
      { provider: "codex", sessionId: "provider-session-1" },
      { cwd: process.cwd() },
      agentId,
      { resumeRunning: true },
    );
    await manager.flush();

    expect(snapshot.lifecycle).toBe(testCase.lifecycle);
    expect(snapshot.lastError).toBe(testCase.lastError);
    expect(manager.getAgent(agentId)?.lifecycle).toBe(testCase.lifecycle);
    expect(manager.hasInFlightRun(agentId)).toBe(false);
    expect(session.subscriptionCount).toBe(1);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
  }

  expect(session.subscriptionCount).toBe(0);
  expect(session.closeCount).toBe(1);
});

test("restored session initialization failure removes its subscription and tracked run", async () => {
  const agentId = "00000000-0000-4000-8000-000000000108";
  let manager: AgentManager;
  const session = new InitializationTerminalSession(
    { provider: "codex", cwd: process.cwd() },
    { type: "turn_completed", provider: "codex", turnId: "restored-turn" },
    () => manager.prepareForShutdown(),
  );
  const client = new (class extends TestAgentClient {
    override async resumeSession(): Promise<AgentSession> {
      return session;
    }
  })();
  manager = new AgentManager({ clients: { codex: client }, logger });

  await expect(
    manager.resumeAgentFromPersistence(
      { provider: "codex", sessionId: "provider-session-1" },
      { cwd: process.cwd() },
      agentId,
      { resumeRunning: true },
    ),
  ).rejects.toBeInstanceOf(AgentManagerShuttingDownError);
  await manager.flushForShutdown();

  expect(manager.listAgents()).toEqual([]);
  expect(manager.hasInFlightRun(agentId)).toBe(false);
  expect(session.subscriptionCount).toBe(0);
  expect(session.closeCount).toBe(1);
});

test("reload leaves a closed durable snapshot when shutdown starts during the swap", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-shutdown-reload-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldReloadCloseClient();
  const agentId = "00000000-0000-4000-8000-000000000097";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    const reload = manager.reloadAgentSession(agentId).catch((error: unknown) => error);
    await client.waitForCloseToStart();

    manager.prepareForShutdown();
    const closing = Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    client.finishClosing();

    await closing;
    expect(await reload).toBeInstanceOf(AgentManagerShuttingDownError);
    await manager.flush();
    await storage.flush();
    expect({
      agents: manager.listAgents(),
      record: await storage.get(agentId),
      replacementSessionClosed: client.replacementSessionClosed,
    }).toMatchObject({
      agents: [],
      record: { lastStatus: "closed" },
      replacementSessionClosed: true,
    });
  } finally {
    client.finishClosing();
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("reload closes both sessions when the closed snapshot cannot be persisted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-persist-failure-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new HeldReloadCloseClient();
  const agentId = "00000000-0000-4000-8000-000000000096";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    await storage.flush();
    rmSync(storagePath, { recursive: true, force: true });
    writeFileSync(storagePath, "blocks the storage directory");

    const reload = manager.reloadAgentSession(agentId).catch((error: unknown) => error);
    await client.waitForCloseToStart();
    client.finishClosing();

    expect(await reload).toBeInstanceOf(Error);
    await manager.flushForShutdown();
    expect({
      agents: manager.listAgents(),
      originalSessionClosed: client.originalSessionClosed,
      replacementSessionClosed: client.replacementSessionClosed,
    }).toEqual({
      agents: [],
      originalSessionClosed: true,
      replacementSessionClosed: true,
    });
  } finally {
    client.finishClosing();
    await manager.flushForShutdown().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("normalizeConfig injects the provider default model when omitted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000101",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.model).toBe("gpt-5.4");
  expect(snapshot.config.modeId).toBe("auto-review");
});

test("normalizeConfig injects Claude's automatic approval default when omitted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-claude-default-test-"));
  const manager = new AgentManager({
    clients: { claude: new TestAgentClient("claude") },
    logger,
  });

  const snapshot = await manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  expect(snapshot.config.modeId).toBe("auto");
});

test("normalizeConfig uses a capability-aware provider mode default", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-mode-default-test-"));
  class CapabilityAwareClient extends TestAgentClient {
    override async resolveDefaultModeId(input: ResolveAgentDefaultModeInput): Promise<string> {
      return input.env?.CLAUDE_CODE_USE_BEDROCK === "1" ? "default" : "auto";
    }
  }
  const manager = new AgentManager({
    clients: { codex: new CapabilityAwareClient() },
    logger,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
  });

  expect(snapshot.config.modeId).toBe("default");
});

test("createAgent forwards request env into the spawned provider process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-env-test-"));
  const client = new EnvProbeAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    logger,
    idFactory: () => "00000000-0000-4000-8000-00000000e001",
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      {
        env: {
          CHUNK14_PROBE: "expected",
        },
        workspaceId: undefined,
      },
    );

    await expect(client.probe).resolves.toEqual({
      probe: "expected",
      agentId: "00000000-0000-4000-8000-00000000e001",
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("normalizeConfig strips legacy 'default' model id", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000102",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "default",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.model).toBe("gpt-5.4");
  expect(snapshot.config.modeId).toBe("auto-review");
});

test("listDraftCommands returns no commands without guessing a missing model", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-commands-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class DraftCommandClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    availabilityCalls = 0;

    override async isAvailable(): Promise<boolean> {
      this.availabilityCalls += 1;
      return true;
    }

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }
  const client = new DraftCommandClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await expect(manager.listDraftCommands({ provider: "codex", cwd: workdir })).resolves.toEqual([]);

  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.availabilityCalls).toBe(0);
});

test("listDraftCommands uses explicit model config without default model fetching", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-commands-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const draftCommand: AgentSlashCommand = {
    name: "review",
    description: "Review changes",
    argumentHint: "",
    kind: "command",
  };
  class DraftCommandSession extends TestAgentSession {
    override async listCommands(): Promise<AgentSlashCommand[]> {
      return [draftCommand];
    }
  }
  class DraftCommandClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    readonly commandConfigs: AgentSessionConfig[] = [];

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      this.commandConfigs.push(config);
      return new DraftCommandSession(config);
    }
  }
  const client = new DraftCommandClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  const commands = await manager.listDraftCommands({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
  });

  expect(commands).toEqual([draftCommand]);
  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(1);
  expect(client.commandConfigs).toEqual([
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.4",
      modeId: "auto-review",
    },
  ]);
});

test("listDraftFeatures returns no features without guessing a missing model", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-features-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class DraftFeatureClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    availabilityCalls = 0;
    readonly featureConfigs: AgentSessionConfig[] = [];

    override async isAvailable(): Promise<boolean> {
      this.availabilityCalls += 1;
      return true;
    }

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }

    async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
      this.featureConfigs.push(config);
      return [createFeature({ id: "fast_mode", label: "Fast mode", value: false })];
    }
  }
  const client = new DraftFeatureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await expect(manager.listDraftFeatures({ provider: "codex", cwd: workdir })).resolves.toEqual([]);

  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.availabilityCalls).toBe(0);
  expect(client.featureConfigs).toEqual([]);
});

test("listDraftFeatures uses explicit model config without default model fetching", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-features-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const draftFeature = createFeature({ id: "fast_mode", label: "Fast mode", value: false });
  class DraftFeatureClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    readonly featureConfigs: AgentSessionConfig[] = [];

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }

    async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
      this.featureConfigs.push(config);
      return [draftFeature];
    }
  }
  const client = new DraftFeatureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  const features = await manager.listDraftFeatures({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
  });

  expect(features).toEqual([draftFeature]);
  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.featureConfigs).toEqual([
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.4",
      modeId: "auto-review",
    },
  ]);
});

test("createAgent injects daemon append system prompt at runtime only", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    appendSystemPrompt: "  Daemon instructions.  ",
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      systemPrompt: "Agent instructions.",
    },
    undefined,
    { workspaceId: undefined },
  );
  const record = await storage.get(snapshot.id);

  expect(client.createdConfigs[0]?.systemPrompt).toBe("Agent instructions.");
  expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe("Daemon instructions.");
  expect(snapshot.config).not.toHaveProperty("daemonAppendSystemPrompt");
  expect(record?.config?.systemPrompt).toBe("Agent instructions.");
  expect(record?.config).not.toHaveProperty("daemonAppendSystemPrompt");
});

test("daemon append system prompt is injected into Pi configs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      pi: client as unknown as AgentClient,
    },
    providerDefinitions: {
      pi: { enabled: true },
    },
    registry: storage,
    logger,
    appendSystemPrompt: "Daemon instructions.",
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  await manager.createAgent(
    {
      provider: "pi",
      cwd: workdir,
      systemPrompt: "Agent instructions.",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe("Daemon instructions.");
});

test("setAgentMode persists the selected mode across session reload", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ModeAwareSession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly id = randomUUID();
    private currentMode: string | null;

    constructor(private readonly config: AgentSessionConfig) {
      this.currentMode = config.modeId ?? null;
    }

    async run(): Promise<AgentRunResult> {
      return { sessionId: this.id, finalText: "", timeline: [] };
    }

    async startTurn(): Promise<{ turnId: string }> {
      return { turnId: "turn-1" };
    }

    subscribe(): () => void {
      return () => {};
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

    async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: this.config.model ?? null,
        modeId: this.currentMode,
      };
    }

    async getAvailableModes() {
      return [];
    }

    async getCurrentMode() {
      return this.currentMode;
    }

    async setMode(modeId: string): Promise<void> {
      this.currentMode = modeId;
    }

    getPendingPermissions() {
      return [];
    }

    async respondToPermission(): Promise<void> {}

    describePersistence() {
      return { provider: this.provider, sessionId: this.id };
    }

    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  class ModeAwareClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ModeAwareSession(config);
    }

    async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new ModeAwareSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
        modeId: config?.modeId,
        model: config?.model,
      });
    }

    async fetchCatalog() {
      return {
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
        modes: [],
      };
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ModeAwareClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000301",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "auto",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setAgentMode(snapshot.id, "full-access");

  const beforeReload = manager.getAgent(snapshot.id);
  expect(beforeReload?.config.modeId).toBe("full-access");
  expect(beforeReload?.currentModeId).toBe("full-access");

  const reloaded = await manager.reloadAgentSession(snapshot.id);
  expect(reloaded.config.modeId).toBe("full-access");
  expect(reloaded.currentModeId).toBe("full-access");
});

test("reloadAgentSession completes when the previous session close hangs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-close-timeout-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class HangingCloseSession extends TestAgentSession {
    closeCalled = false;

    override async close(): Promise<void> {
      this.closeCalled = true;
      await new Promise(() => {});
    }
  }

  class HangingCloseClient extends TestAgentClient {
    readonly firstSession = new HangingCloseSession({
      provider: "codex",
      cwd: workdir,
    });
    resumeSessionCalls = 0;

    override async createSession(): Promise<AgentSession> {
      return this.firstSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      this.resumeSessionCalls += 1;
      return new TestAgentSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
      });
    }
  }

  const client = new HangingCloseClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    rescueTimeouts: { reloadSessionCloseMs: 10 },
    idFactory: () => "00000000-0000-4000-8000-000000000302",
  });

  try {
    const snapshot = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );

    const reloaded = await manager.reloadAgentSession(snapshot.id);

    expect(reloaded.id).toBe(snapshot.id);
    expect(client.firstSession.closeCalled).toBe(true);
    expect(client.resumeSessionCalls).toBe(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("cancelAgentRun preserves running state when the provider interrupt hangs", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-timeout",
    agentId: "00000000-0000-4000-8000-000000000303",
    turnId: "hanging-interrupt-turn",
    interrupt: async () => await new Promise(() => {}),
  });

  try {
    const running = waitForAgentLifecycle(fixture.manager, fixture.agentId, "running");
    fixture.session.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "hanging-interrupt-turn",
    });
    await running;

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "refused",
    });
    expect(fixture.session.interruptCalled).toBe(true);
    expect(fixture.manager.getAgent(fixture.agentId)?.lifecycle).toBe("running");
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun coalesces cancellation for a resumed run that was persisted as running", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "persisted-running",
    agentId: "00000000-0000-4000-8000-000000000307",
    turnId: "persisted-running-turn",
    interrupt: async (session) => {
      session.pushEvent({
        type: "turn_canceled",
        provider: "codex",
        reason: "interrupted",
      });
    },
  });

  try {
    expect(fixture.manager.getAgent(fixture.agentId)?.lifecycle).toBe("idle");

    await expect(
      Promise.all([
        fixture.manager.cancelAgentRun(fixture.agentId, { assumeRunning: true }),
        fixture.manager.cancelAgentRun(fixture.agentId, { assumeRunning: true }),
      ]),
    ).resolves.toEqual([{ status: "settled" }, { status: "settled" }]);
    expect(fixture.session.interruptCallCount).toBe(1);
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun preserves the active turn when the provider rejects the interrupt", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-rejected",
    agentId: "00000000-0000-4000-8000-000000000304",
    turnId: "provider-still-active-turn",
    interrupt: async () => {
      throw new Error("A foreground turn is already active");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "refused",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "provider-still-active-turn",
    });

    fixture.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: "provider-still-active-turn",
    });
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun succeeds when the foreground turn finishes before the provider rejects the interrupt", async () => {
  let fixture!: ControlledInterruptFixture;
  fixture = await createControlledInterruptFixture({
    name: "interrupt-after-completion",
    agentId: "00000000-0000-4000-8000-000000000305",
    turnId: "naturally-completed-turn",
    interrupt: async (session) => {
      const settled = waitForAgentLifecycle(fixture.manager, fixture.agentId, "idle");
      session.pushEvent({
        type: "turn_completed",
        provider: session.provider,
        turnId: "naturally-completed-turn",
      });
      await settled;
      throw new Error("turn already completed");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "settled",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "idle",
      activeForegroundTurnId: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun succeeds when the provider queues completion before rejecting the interrupt", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-queued-completion",
    agentId: "00000000-0000-4000-8000-000000000306",
    turnId: "queued-completion-turn",
    interrupt: async (session) => {
      session.pushEvent({
        type: "turn_completed",
        provider: session.provider,
        turnId: "queued-completion-turn",
      });
      throw new Error("turn already completed");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "settled",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "idle",
      activeForegroundTurnId: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test("listProviderAvailability uses registered client keys, including custom providers", async () => {
  const customClient: AgentClient = {
    provider: "zai",
    capabilities: TEST_CAPABILITIES,
    async isAvailable() {
      return true;
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
  };

  const manager = new AgentManager({
    clients: {
      zai: customClient,
    },
    logger,
  });

  await expect(manager.listProviderAvailability()).resolves.toEqual([
    {
      provider: "zai",
      available: true,
      error: null,
    },
  ]);
});

test("createAgent passes daemon launch env through the provider launch context", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;
    lastLaunchContext: AgentLaunchContext | undefined;

    override async createSession(
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.lastConfig = config;
      this.lastLaunchContext = launchContext;
      return new TestAgentSession(config);
    }
  }

  const client = new CaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    {
      workspaceId: undefined,
      env: {
        CUSTOM_CHILD_VALUE: "preserved",
        PASEO_MANAGED_AGENT_CONTEXT: "0",
        PASEO_PASSWORD: "must-not-reach-provider",
        PASEO_COORDINATOR_AUTH_TOKEN: "must-not-reach-provider",
        PASEO_COORDINATOR_CAPABILITY: "must-not-reach-provider",
      },
    },
  );

  expect(client.lastConfig).toEqual({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
    modeId: "auto-review",
  });
  expect(client.lastLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      CUSTOM_CHILD_VALUE: "preserved",
      PASEO_AGENT_ID: snapshot.id,
      PASEO_AGENT_INCARNATION: expect.any(String),
      PASEO_AGENT_CWD: workdir,
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    },
  });
});

test("createAgent passes persistSession to provider create options", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastCreateOptions: AgentCreateSessionOptions | undefined;

    override async createSession(
      config: AgentSessionConfig,
      _launchContext?: AgentLaunchContext,
      options?: AgentCreateSessionOptions,
    ): Promise<AgentSession> {
      this.lastCreateOptions = options;
      return new TestAgentSession(config);
    }
  }

  const client = new CaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { persistSession: false, workspaceId: undefined },
  );

  expect(client.lastCreateOptions).toEqual({ persistSession: false });

  rmSync(workdir, { recursive: true, force: true });
});

test("createAgent persists workspaceId on the stored record and emits it in the snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000000a1",
  });

  try {
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: "wks_owner" },
    );

    expect(agent.workspaceId).toBe("wks_owner");
    expect(toAgentPayload(agent).workspaceId).toBe("wks_owner");

    const record = await storage.get(agent.id);
    expect(record?.workspaceId).toBe("wks_owner");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("createAgent injects paseo MCP server only into provider launch config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
      return new TestAgentSession(config);
    }
  }

  const client = new CaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        custom: {
          type: "stdio",
          command: "custom-mcp",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  const callerIdentity = manager.getAgentCallerIdentity(snapshot.id);
  expect(callerIdentity).toMatchObject({ agentId: snapshot.id, incarnation: expect.any(String) });
  expect(client.lastConfig?.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: `http://127.0.0.1:6767/mcp/agents?callerAgentId=${snapshot.id}&callerAgentIncarnation=${callerIdentity!.incarnation}`,
    },
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });

  const stored = await storage.get(snapshot.id);
  expect(stored?.config?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("createAgent passes native Paseo tools through launch context without internal MCP", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const paseoTools: PaseoToolCatalog = {
    tools: new Map(),
    getTool: () => undefined,
    executeTool: async () => {
      throw new Error("No tools registered in test catalog");
    },
  };

  class NativeToolsClient extends TestAgentClient {
    override readonly capabilities = {
      ...TEST_CAPABILITIES,
      supportsMcpServers: true,
      supportsNativePaseoTools: true,
    };
    lastConfig: AgentSessionConfig | null = null;
    lastLaunchContext: AgentLaunchContext | undefined;

    override async createSession(
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.lastConfig = config;
      this.lastLaunchContext = launchContext;
      return new TestAgentSession(config);
    }
  }

  const client = new NativeToolsClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    paseoToolCatalogFactory: () => paseoTools,
    idFactory: () => "00000000-0000-4000-8000-000000000106",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        custom: {
          type: "stdio",
          command: "custom-mcp",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastLaunchContext?.paseoTools).toBe(paseoTools);
  expect(client.lastConfig?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });

  const stored = await storage.get(snapshot.id);
  expect(stored?.config?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("createAgent injects an identity-bound MCP auth token into the launch config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
      return new TestAgentSession(config);
    }
  }

  const client = new CaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    issueAgentAuthToken: ({ agentId, incarnation }) => `agent-token:${agentId}:${incarnation}`,
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const callerIdentity = manager.getAgentCallerIdentity(snapshot.id);
  expect(client.lastConfig?.mcpServers?.paseo).toEqual({
    type: "http",
    url: `http://127.0.0.1:6767/mcp/agents?callerAgentId=${
      snapshot.id
    }&callerAgentIncarnation=${callerIdentity!.incarnation}`,
    headers: {
      Authorization: `Bearer agent-token:${snapshot.id}:${callerIdentity!.incarnation}`,
    },
  });
  expect(manager.getAgentIngressAuthToken(snapshot.id)).toBe(
    `agent-token:${snapshot.id}:${callerIdentity!.incarnation}`,
  );

  rmSync(workdir, { recursive: true, force: true });
});

test("resumeAgentFromPersistence replaces stored internal paseo MCP with current runtime URL", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6768/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000105",
  });
  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "session-123",
    metadata: {
      cwd: workdir,
    },
  };

  const snapshot = await manager.resumeAgentFromPersistence(handle, {
    cwd: workdir,
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
      },
      custom: {
        type: "stdio",
        command: "custom-mcp",
      },
    },
  });
  const callerIdentity = manager.getAgentCallerIdentity(snapshot.id);

  expect(client.resumeOverrides[0]?.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: `http://127.0.0.1:6768/mcp/agents?callerAgentId=${snapshot.id}&callerAgentIncarnation=${callerIdentity!.incarnation}`,
    },
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("resumeAgentFromPersistence drops stored internal paseo MCP when runtime injection is disabled", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "session-123",
    metadata: {
      cwd: workdir,
    },
  };

  const snapshot = await manager.resumeAgentFromPersistence(handle, {
    cwd: workdir,
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
      },
    },
  });

  expect(client.resumeOverrides[0]?.mcpServers).toBeUndefined();
  expect(snapshot.config.mcpServers).toBeUndefined();
});

test("createAgent preserves a user-provided paseo MCP config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
      return new TestAgentSession(config);
    }
  }

  const client = new CaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        paseo: {
          type: "http",
          url: "https://example.com/custom-paseo",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: "https://example.com/custom-paseo",
    },
  });
  expect(client.lastConfig?.mcpServers).toEqual(snapshot.config.mcpServers);
});

test("createAgent fails when cwd does not exist", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: join(workdir, "does-not-exist"),
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Working directory does not exist");
});

test("createAgent reports configured providers when provider is unknown", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "missing-provider",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Unknown provider 'missing-provider'. Configured providers: codex.");
});

test("createAgent reports available providers when selected provider is unavailable", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class UnavailableCodexClient extends TestAgentClient {
    override async isAvailable(): Promise<boolean> {
      return false;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new UnavailableCodexClient(),
      claude: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow(
    "Provider 'codex' is not available. Available providers: claude. Use one of those providers, or install/configure 'codex'.",
  );
});

test("createAgent rejects a disabled provider without creating a session", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class DisabledCodexClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }

  const disabledClient = new DisabledCodexClient();
  const providerDefinitions = {
    codex: {
      enabled: false,
    },
  } satisfies Partial<Record<AgentProvider, Pick<ProviderDefinition, "enabled">>>;
  const manager = new AgentManager({
    clients: {
      codex: disabledClient,
    },
    providerDefinitions,
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Provider 'codex' is disabled");
  expect(disabledClient.createSessionCalls).toBe(0);
  expect(await storage.list()).toHaveLength(0);
});

test("updateProviderRegistry re-enables a previously disabled provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: { enabled: false },
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Provider 'codex' is disabled");

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: client },
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  expect(snapshot.config.provider).toBe("codex");
});

test("updateProviderRegistry disables a previously enabled provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: { enabled: true },
    },
    registry: storage,
    logger,
  });

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: false } },
    clients: { codex: client },
  });

  await expect(
    manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Provider 'codex' is disabled");
});

test("updateProviderRegistry registers a previously unknown provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {},
    providerDefinitions: {},
    registry: storage,
    logger,
  });

  expect(manager.getRegisteredProviderIds()).not.toContain("codex");

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: new TestAgentClient() },
  });

  expect(manager.getRegisteredProviderIds()).toContain("codex");
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  expect(snapshot.config.provider).toBe("codex");
});

test("updateProviderRegistry removes providers omitted from the next registry", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const removedProvider = "zai-claude" as AgentProvider;
  class RemovedProviderClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }

  const removedClient = new RemovedProviderClient();
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient(), [removedProvider]: removedClient },
    providerDefinitions: {
      codex: { enabled: true },
      [removedProvider]: { enabled: true },
    },
    registry: storage,
    logger,
  });

  expect(manager.getRegisteredProviderIds()).toContain(removedProvider);

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: new TestAgentClient() },
  });

  expect(manager.getRegisteredProviderIds()).not.toContain(removedProvider);
  await expect(
    manager.createAgent({ provider: removedProvider, cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Unknown provider 'zai-claude'");
  expect(removedClient.createSessionCalls).toBe(0);
});

test("createAgent passes explicit model strings through to the provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class CaptureModelClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
      return new TestAgentSession(config);
    }
  }
  const client = new CaptureModelClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "not-a-real-model",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastConfig?.model).toBe("not-a-real-model");
});

test("resumeAgentFromPersistence keeps metadata config, applies overrides, and passes launch env", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-resume-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ResumeCaptureClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    lastResumeOverrides: Partial<AgentSessionConfig> | undefined;
    lastResumeLaunchContext: AgentLaunchContext | undefined;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new TestAgentSession(config);
    }

    async fetchCatalog() {
      return {
        models: [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "GPT-5.4",
            isDefault: true,
          },
        ],
        modes: [],
      };
    }

    async resumeSession(
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.lastResumeOverrides = overrides;
      this.lastResumeLaunchContext = launchContext;
      const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
      const merged: AgentSessionConfig = {
        ...metadata,
        ...overrides,
        provider: "codex",
        cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      };
      return new TestAgentSession(merged);
    }
  }

  const client = new ResumeCaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000106",
  });

  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "resume-session-1",
    metadata: {
      provider: "codex",
      cwd: workdir,
      systemPrompt: "old prompt",
      mcpServers: {
        legacy: {
          type: "stdio",
          command: "legacy-bridge",
          args: ["/tmp/legacy.sock"],
        },
      },
    },
  };

  const resumed = await manager.resumeAgentFromPersistence(handle, {
    cwd: workdir,
    systemPrompt: "new prompt",
    mcpServers: {
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
      },
    },
  });

  expect(resumed.config.systemPrompt).toBe("new prompt");
  expect(resumed.config.mcpServers).toEqual({
    paseo: {
      type: "stdio",
      command: "node",
      args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
    },
  });
  expect(client.lastResumeOverrides).toMatchObject({
    model: "gpt-5.4",
    modeId: "auto-review",
    systemPrompt: "new prompt",
    mcpServers: {
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
      },
    },
  });
  expect(client.lastResumeLaunchContext).toEqual({
    agentId: resumed.id,
    env: {
      PASEO_AGENT_ID: resumed.id,
      PASEO_AGENT_INCARNATION: expect.any(String),
      PASEO_AGENT_CWD: workdir,
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    },
  });
});

test("importProviderSession imports the selected session without listing and publishes ready state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-import-session-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const session = new TestAgentSession({ provider: "codex", cwd: workdir });
  const events: AgentManagerEvent[] = [];

  class ImportClient extends TestAgentClient {
    listCalls = 0;
    importInput: unknown = null;
    importLaunchContext: AgentLaunchContext | undefined;

    async listImportableSessions() {
      this.listCalls += 1;
      return [];
    }

    async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
      this.importInput = input;
      this.importLaunchContext = context.launchContext;
      return {
        session,
        config: { provider: "codex" as const, cwd: workdir },
        persistence: {
          provider: "codex" as const,
          sessionId: input.providerHandleId,
          nativeHandle: input.providerHandleId,
          metadata: { provider: "codex", cwd: workdir },
        },
        timeline: [
          {
            item: { type: "user_message" as const, text: "Trace provider imports" },
            timestamp: "2026-01-02T00:00:00.000Z",
          },
          {
            item: { type: "assistant_message" as const, text: "Done" },
            timestamp: "2026-01-02T00:00:01.000Z",
          },
          {
            item: {
              type: "tool_call" as const,
              callId: "large-shell-result",
              name: "shell",
              status: "completed" as const,
              error: null,
              detail: {
                type: "shell" as const,
                command: "print output",
                output: "x".repeat(1024 * 1024),
                exitCode: 0,
              },
            },
            timestamp: "2026-01-02T00:00:02.000Z",
          },
        ],
        providerSubagentEvents: [
          {
            type: "provider_subagent" as const,
            provider: "codex" as const,
            event: {
              type: "upsert" as const,
              id: "thread-child",
              title: "Imported child",
              status: "completed" as const,
            },
          },
          {
            type: "provider_subagent" as const,
            provider: "codex" as const,
            event: {
              type: "timeline" as const,
              id: "thread-child",
              item: { type: "assistant_message" as const, text: "Child result" },
            },
          },
        ],
      };
    }
  }

  const client = new ImportClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  manager.subscribe((event) => events.push(event), { replayState: false });

  const imported = await manager.importProviderSession({
    provider: "codex",
    providerHandleId: "thread-selected",
    cwd: workdir,
    workspaceId: "ws-imported",
  });

  expect(client.listCalls).toBe(0);
  expect(client.importInput).toEqual({ providerHandleId: "thread-selected", cwd: workdir });
  expect(client.importLaunchContext).toEqual({
    agentId: imported.id,
    env: {
      PASEO_AGENT_ID: imported.id,
      PASEO_AGENT_INCARNATION: expect.any(String),
      PASEO_AGENT_CWD: workdir,
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    },
  });
  expect(imported.lifecycle).toBe("idle");
  expect(imported.historyPrimed).toBe(true);
  expect(manager.getTimeline(imported.id)).toEqual([
    { type: "user_message", text: "Trace provider imports" },
    { type: "assistant_message", text: "Done" },
    {
      type: "tool_call",
      callId: "large-shell-result",
      name: "shell",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "print output",
        output: "x".repeat(64 * 1024),
        exitCode: 0,
      },
    },
  ]);
  expect(manager.listProviderSubagents(imported.id)).toEqual([
    expect.objectContaining({ id: "thread-child", title: "Imported child", status: "completed" }),
  ]);
  expect(manager.fetchProviderSubagentTimeline(imported.id, "thread-child").rows).toEqual([
    expect.objectContaining({ item: { type: "assistant_message", text: "Child result" } }),
  ]);
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({
    type: "agent_state",
    agent: {
      id: imported.id,
      lifecycle: "idle",
      persistence: { nativeHandle: "thread-selected" },
    },
  });
  expect((await storage.get(imported.id))?.title).toBe("Trace provider imports");
});

test("reloadAgentSession passes daemon launch env through the provider launch context", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-context-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ReloadCaptureClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    lastCreateLaunchContext: AgentLaunchContext | undefined;
    lastResumeLaunchContext: AgentLaunchContext | undefined;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.lastCreateLaunchContext = launchContext;
      return new TestAgentSession(config);
    }

    async resumeSession(
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      this.lastResumeLaunchContext = launchContext;
      const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
      const merged: AgentSessionConfig = {
        ...metadata,
        ...overrides,
        provider: "codex",
        cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      };
      return new TestAgentSession(merged);
    }
  }

  const client = new ReloadCaptureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000108",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastCreateLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      PASEO_AGENT_ID: snapshot.id,
      PASEO_AGENT_INCARNATION: expect.any(String),
      PASEO_AGENT_CWD: workdir,
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    },
  });
  const initialIncarnation = client.lastCreateLaunchContext?.env?.PASEO_AGENT_INCARNATION;
  expect(initialIncarnation).toBe(manager.getAgentCallerIdentity(snapshot.id)?.incarnation);
  expect(client.lastCreateLaunchContext).not.toHaveProperty("env.PASEO_AGENT_CALLER_PROOF");

  await manager.reloadAgentSession(snapshot.id, {
    systemPrompt: "reloaded prompt",
  });

  expect(client.lastResumeLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      PASEO_AGENT_ID: snapshot.id,
      PASEO_AGENT_INCARNATION: expect.any(String),
      PASEO_AGENT_CWD: workdir,
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    },
  });
  const reloadedIncarnation = client.lastResumeLaunchContext?.env?.PASEO_AGENT_INCARNATION;
  expect(reloadedIncarnation).toBe(manager.getAgentCallerIdentity(snapshot.id)?.incarnation);
  expect(reloadedIncarnation).not.toBe(initialIncarnation);
  expect(client.lastResumeLaunchContext).not.toHaveProperty("env.PASEO_AGENT_CALLER_PROOF");
});

test("reloadAgentSession preserves timeline and does not force history replay", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class HistoryProbeSession extends TestAgentSession {
    constructor(
      config: AgentSessionConfig,
      private readonly historyText: string | null,
    ) {
      super(config);
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      if (!this.historyText) {
        return;
      }
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: this.historyText },
      };
    }
  }

  class HistoryProbeClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new HistoryProbeSession(config, null);
    }

    async resumeSession(
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
      const merged: AgentSessionConfig = {
        ...metadata,
        ...overrides,
        provider: "codex",
        cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      };
      return new HistoryProbeSession(merged, "history replay from provider");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new HistoryProbeClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000113",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "keep this timeline in memory",
  });
  await manager.hydrateTimelineFromProvider(snapshot.id);
  const beforeReload = manager.getTimeline(snapshot.id);
  expect(beforeReload).toHaveLength(1);

  await manager.reloadAgentSession(snapshot.id, {
    systemPrompt: "reloaded prompt",
  });
  const afterReload = manager.getTimeline(snapshot.id);
  expect(afterReload).toEqual(beforeReload);

  // If reload resets historyPrimed, this would replay provider history and append another item.
  await manager.hydrateTimelineFromProvider(snapshot.id);
  const afterHydrate = manager.getTimeline(snapshot.id);
  expect(afterHydrate).toEqual(beforeReload);
});

test("reloadAgentSession keeps provider children until disk rehydration commits", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-reload-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let activeSession: TestAgentSession | null = null;
  class ProviderChildClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      activeSession = new TestAgentSession(config);
      return activeSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new TestAgentSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
      });
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000116",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  activeSession?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "stale-child", title: "Stale child", status: "running" },
  });
  await vi.waitFor(() => expect(manager.listProviderSubagents(snapshot.id)).toHaveLength(1));

  await manager.reloadAgentSession(snapshot.id, undefined, { rehydrateFromDisk: true });

  expect(manager.listProviderSubagents(snapshot.id)).toHaveLength(1);
  await manager.hydrateTimelineFromProvider(snapshot.id, { force: true, broadcast: true });
  expect(manager.listProviderSubagents(snapshot.id)).toEqual([]);
});

test("hydrateTimelineFromProvider restores and broadcasts provider children from session history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-history-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  class ProviderChildHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "provider_subagent",
        provider: "codex",
        event: {
          type: "upsert",
          id: "restored-child",
          title: "Restored child",
          status: "completed",
        },
      };
    }
  }
  class ProviderChildHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ProviderChildHistorySession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildHistoryClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000117",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), {
    agentId: snapshot.id,
    replayState: false,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id, { broadcast: true });

  expect(manager.listProviderSubagents(snapshot.id)).toEqual([
    expect.objectContaining({
      id: "restored-child",
      parentAgentId: snapshot.id,
      title: "Restored child",
      status: "completed",
    }),
  ]);
  expect(events).toContainEqual({
    type: "provider_subagent",
    event: {
      type: "upsert",
      subagent: expect.objectContaining({
        id: "restored-child",
        parentAgentId: snapshot.id,
      }),
    },
  });
});

test("force provider hydration removes children absent from current history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-force-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let session: TestAgentSession | null = null;
  class ProviderChildForceClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new TestAgentSession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildForceClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000118",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  session?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "removed-by-rewind", status: "completed" },
  });
  await vi.waitFor(() => expect(manager.listProviderSubagents(snapshot.id)).toHaveLength(1));
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), {
    agentId: snapshot.id,
    replayState: false,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id, { force: true, broadcast: true });

  expect(manager.listProviderSubagents(snapshot.id)).toEqual([]);
  expect(events).toContainEqual({
    type: "provider_subagent",
    event: {
      type: "remove",
      parentAgentId: snapshot.id,
      subagentId: "removed-by-rewind",
    },
  });
});

test("provider hydration preserves a queued terminal child update across a successor", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-order-"));
  const agentId = "00000000-0000-4000-8000-000000000161";
  let session: TestAgentSession | null = null;
  let historyGeneration = 0;

  class ProviderChildOrderingSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyGeneration += 1;
      yield {
        type: "provider_subagent",
        provider: "codex",
        event: {
          type: "upsert",
          id: "child-1",
          title: "Child",
          status: "running",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      };
      if (historyGeneration > 1) {
        yield {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "upsert",
            id: "child-1",
            title: "Child",
            status: "completed",
            timestamp: "2026-01-02T00:00:00.000Z",
          },
        };
      }
    }
  }

  class ProviderChildOrderingClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new ProviderChildOrderingSession(config);
      return session;
    }
  }

  const manager = new AgentManager({
    clients: { codex: new ProviderChildOrderingClient() },
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    let successorHydration: Promise<void> | null = null;
    let completedUpserts = 0;
    manager.subscribe(
      (event) => {
        if (
          event.type !== "provider_subagent" ||
          event.event.type !== "upsert" ||
          event.event.subagent.status !== "completed"
        ) {
          return;
        }
        completedUpserts += 1;
        successorHydration ??= manager.hydrateTimelineFromProvider(created.id, {
          force: true,
          broadcast: true,
        });
      },
      { agentId: created.id, replayState: false },
    );
    session?.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "child-1",
        title: "Child",
        status: "completed",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
    });

    await manager.hydrateTimelineFromProvider(created.id, { force: true, broadcast: true });
    await successorHydration;

    expect(manager.getProviderSubagent(created.id, "child-1")).toMatchObject({
      status: "completed",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(historyGeneration).toBe(1);
    expect(completedUpserts).toBe(1);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider history hydration retries after a one-row-then-throw restart without persisting a prefix", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-atomic-retry-"));
  const agentStoragePath = join(workdir, "agents");
  const timelineStoragePath = join(workdir, "timelines");
  const agentId = "00000000-0000-4000-8000-000000000154";
  let historyReads = 0;

  class RetryHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      yield {
        type: "timeline",
        provider: this.provider,
        timestamp: "2026-08-01T00:00:00.000Z",
        item: { type: "user_message", text: "history row one" },
      };
      if (historyReads === 1) throw new Error("history interrupted after one row");
      yield {
        type: "timeline",
        provider: this.provider,
        timestamp: "2026-08-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "history row two" },
      };
    }
  }

  class RetryHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new RetryHistorySession(config);
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new RetryHistorySession({ provider: "codex", cwd: config?.cwd ?? workdir });
    }
  }

  const client = new RetryHistoryClient();
  const createManager = (storage: AgentStorage) =>
    new AgentManager({
      clients: { codex: client },
      registry: storage,
      durableTimelineStore: new FileAgentTimelineStore(timelineStoragePath, logger),
      logger,
      idFactory: () => agentId,
    });

  try {
    const firstStorage = new AgentStorage(agentStoragePath, logger);
    const firstManager = createManager(firstStorage);
    const created = await firstManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const beforeFailureEpoch = firstManager.fetchTimeline(created.id, { limit: 0 }).epoch;

    await expect(firstManager.hydrateTimelineFromProvider(created.id)).rejects.toThrow(
      "history interrupted after one row",
    );
    await firstManager.flush();
    expect(historyReads).toBe(1);
    expect(firstManager.getTimeline(created.id)).toEqual([]);
    await expect(
      new FileAgentTimelineStore(timelineStoragePath, logger).fetchCommitted(created.id, {
        limit: 0,
      }),
    ).resolves.toMatchObject({ epoch: beforeFailureEpoch, rows: [] });
    expect((await firstStorage.get(created.id))?.historyPrimed).toBe(false);

    await firstManager.closeAgent(created.id);
    await firstManager.flush();

    const restartedStorage = new AgentStorage(agentStoragePath, logger);
    const restartedManager = createManager(restartedStorage);
    try {
      await ensureAgentLoaded(created.id, {
        agentManager: restartedManager,
        agentStorage: restartedStorage,
        logger,
      });
      await restartedManager.flush();

      expect(historyReads).toBe(2);
      expect(restartedManager.fetchTimeline(created.id, { limit: 0 }).epoch).not.toBe(
        beforeFailureEpoch,
      );
      expect(restartedManager.getTimeline(created.id)).toEqual([
        { type: "user_message", text: "history row one" },
        { type: "assistant_message", text: "history row two" },
      ]);
      await expect(
        new FileAgentTimelineStore(timelineStoragePath, logger).getCommittedRows(created.id),
      ).resolves.toMatchObject([
        { seq: 1, item: { text: "history row one" } },
        { seq: 2, item: { text: "history row two" } },
      ]);
      expect((await restartedStorage.get(created.id))?.historyPrimed).toBe(true);
    } finally {
      await restartedManager.closeAgent(created.id).catch(() => undefined);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("concurrent force demand shares one consumptive provider history read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-force-coalesce-"));
  const agentId = "00000000-0000-4000-8000-000000000181";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  let historyReads = 0;

  class ConsumptiveHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "one complete consumptive snapshot" },
      };
    }
  }
  class ConsumptiveHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ConsumptiveHistorySession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new ConsumptiveHistoryClient() },
    logger,
    idFactory: () => agentId,
  });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const first = manager.hydrateTimelineFromProvider(created.id, { force: true });
    await historyStarted.promise;
    const second = manager.hydrateTimelineFromProvider(created.id, {
      force: true,
      broadcast: true,
    });
    releaseHistory.resolve();
    await Promise.all([first, second]);

    expect(historyReads).toBe(1);
    expect(manager.getTimeline(agentId)).toEqual([
      { type: "assistant_message", text: "one complete consumptive snapshot" },
    ]);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a force arriving behind a primed non-force admission performs exactly one read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-force-upgrade-"));
  const agentId = "00000000-0000-4000-8000-000000000182";
  let historyReads = 0;

  class ForceUpgradeSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "forced provider snapshot" },
      };
    }
  }
  class ForceUpgradeClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ForceUpgradeSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new ForceUpgradeClient() },
    logger,
    idFactory: () => agentId,
  });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(created.id, {
      type: "assistant_message",
      text: "already primed live truth",
    });

    const nonForce = manager.hydrateTimelineFromProvider(created.id);
    const force = manager.hydrateTimelineFromProvider(created.id, { force: true });
    await Promise.all([nonForce, force]);

    expect(historyReads).toBe(1);
    expect(manager.getTimeline(agentId)).toEqual([
      { type: "assistant_message", text: "forced provider snapshot" },
    ]);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a force admitted while a skipped hydration is releasing still performs one read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-late-force-upgrade-"));
  const agentId = "00000000-0000-4000-8000-000000000190";
  const releaseEntered = deferred<void>();
  const allowRelease = deferred<void>();
  let historyReads = 0;

  class LateForceSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "late forced provider snapshot" },
      };
    }
  }
  class LateForceClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new LateForceSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new LateForceClient() },
    logger,
    idFactory: () => agentId,
  });
  type ReleaseHistoryHydration = (
    id: string,
    token: symbol,
    shouldRetire?: () => boolean,
  ) => Promise<boolean>;
  const releaseOwner = manager as unknown as {
    releaseHistoryHydration: ReleaseHistoryHydration;
  };
  const originalRelease = releaseOwner.releaseHistoryHydration.bind(manager);
  const releaseSpy = vi
    .spyOn(releaseOwner, "releaseHistoryHydration")
    .mockImplementation(async (...args) => {
      releaseEntered.resolve();
      await allowRelease.promise;
      return await originalRelease(...args);
    });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(created.id, {
      type: "assistant_message",
      text: "already primed live truth",
    });

    const nonForce = manager.hydrateTimelineFromProvider(created.id);
    await releaseEntered.promise;
    const force = manager.hydrateTimelineFromProvider(created.id, { force: true });
    allowRelease.resolve();
    await Promise.all([nonForce, force]);

    expect(historyReads).toBe(1);
    expect(manager.getTimeline(agentId)).toEqual([
      { type: "assistant_message", text: "late forced provider snapshot" },
    ]);
  } finally {
    allowRelease.resolve();
    releaseSpy.mockRestore();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a broadcast admitted after publish handoff replays the snapshot without a provider read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-late-broadcast-"));
  const agentId = "00000000-0000-4000-8000-000000000195";
  const releaseEntered = deferred<void>();
  const allowRelease = deferred<void>();
  let historyReads = 0;
  class LateBroadcastSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      yield* [];
    }
  }
  class LateBroadcastClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new LateBroadcastSession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new LateBroadcastClient() },
    logger,
    idFactory: () => agentId,
  });
  type ReleaseHistoryHydration = (
    id: string,
    token: symbol,
    shouldRetire?: () => boolean,
  ) => Promise<boolean>;
  const releaseOwner = manager as unknown as {
    releaseHistoryHydration: ReleaseHistoryHydration;
  };
  const originalRelease = releaseOwner.releaseHistoryHydration.bind(manager);
  const releaseSpy = vi
    .spyOn(releaseOwner, "releaseHistoryHydration")
    .mockImplementation(async (...args) => {
      releaseEntered.resolve();
      await allowRelease.promise;
      return await originalRelease(...args);
    });
  const events: AgentManagerEvent[] = [];
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: "snapshot for late broadcast",
    });
    manager.subscribe((event) => events.push(event), { agentId, replayState: false });

    const quietHydration = manager.hydrateTimelineFromProvider(agentId);
    await releaseEntered.promise;
    const lateBroadcast = manager.hydrateTimelineFromProvider(agentId, { broadcast: true });
    allowRelease.resolve();
    await Promise.all([quietHydration, lateBroadcast]);

    expect(historyReads).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "agent_stream" &&
          event.event.type === "timeline" &&
          event.event.item.type === "assistant_message" &&
          event.event.item.text === "snapshot for late broadcast",
      ),
    ).toHaveLength(1);
  } finally {
    allowRelease.resolve();
    releaseSpy.mockRestore();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a broadcast admitted inside delayed buffered replay receives the complete snapshot without another provider read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-buffered-broadcast-"));
  const agentId = "00000000-0000-4000-8000-000000000196";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  const userPersistStarted = deferred<void>();
  const releaseUserPersist = deferred<void>();
  let historyReads = 0;
  let session: TestAgentSession | null = null;

  class DelayedUserStateStorage extends AgentStorage {
    delayNextUserStatePersist = false;

    override async applySnapshot(
      ...args: Parameters<AgentStorage["applySnapshot"]>
    ): Promise<void> {
      const [agent] = args;
      if (this.delayNextUserStatePersist && agent.lastUserMessageAt) {
        this.delayNextUserStatePersist = false;
        userPersistStarted.resolve();
        await releaseUserPersist.promise;
      }
      await super.applySnapshot(...args);
    }
  }

  class BufferedBroadcastSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyReads += 1;
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "provider snapshot row" },
      };
    }
  }
  class BufferedBroadcastClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new BufferedBroadcastSession(config);
      return session;
    }
  }

  const storage = new DelayedUserStateStorage(join(workdir, "agents"), logger);
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);
  const manager = new AgentManager({
    clients: { codex: new BufferedBroadcastClient() },
    registry: storage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { agentId, replayState: false });

  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    storage.delayNextUserStatePersist = true;

    const hydration = manager.hydrateTimelineFromProvider(agentId, {
      force: true,
      broadcast: true,
    });
    await historyStarted.promise;
    session?.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "user_message", text: "buffered live row" },
    });
    releaseHistory.resolve();
    await userPersistStarted.promise;

    const lateEventStart = events.length;
    const lateBroadcast = manager.hydrateTimelineFromProvider(agentId, { broadcast: true });
    releaseUserPersist.resolve();
    await Promise.all([hydration, lateBroadcast]);

    expect(historyReads).toBe(1);
    const replayedItems = events
      .slice(lateEventStart)
      .filter(
        (event): event is Extract<AgentManagerEvent, { type: "agent_stream" }> =>
          event.type === "agent_stream" && event.event.type === "timeline",
      )
      .map((event) => event.event.item);
    expect(replayedItems).toEqual([
      { type: "assistant_message", text: "provider snapshot row" },
      { type: "user_message", text: "buffered live row" },
    ]);
    expect(manager.getTimeline(agentId)).toEqual(replayedItems);
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toMatchObject([
      { seq: 1, item: replayedItems[0] },
      { seq: 2, item: replayedItems[1] },
    ]);
  } finally {
    releaseHistory.resolve();
    releaseUserPersist.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a successor hydration preserves stalled progress when provider history omits turn ids", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-hydration-progress-successor-"));
  const agentId = "00000000-0000-4000-8000-000000000164";
  const turnId = "accepted-live-turn";
  const timestamp = "2026-08-02T12:00:00.000Z";
  const progressItems: AgentTimelineItem[] = [
    {
      type: "tool_call",
      callId: "write-replayed-behind-successor",
      name: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "proof.txt", content: "durable successor proof" },
    },
    { type: "compaction", status: "completed" },
    { type: "compaction", status: "completed" },
  ];
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const epochs = ["initial-progress-epoch", "first-progress-epoch", "successor-progress-epoch"];
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger, {
    epochFactory: () => epochs.shift() ?? "unexpected-progress-epoch",
  });
  let session: TestAgentSession | null = null;
  let historyGeneration = 0;

  class SuccessorProgressHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyGeneration += 1;
      if (historyGeneration === 2) {
        for (const item of progressItems) {
          yield { type: "timeline", provider: "codex", timestamp, item };
        }
      }
    }
  }

  class SuccessorProgressHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new SuccessorProgressHistorySession(config);
      return session;
    }
  }

  const manager = new AgentManager({
    clients: { codex: new SuccessorProgressHistoryClient() },
    registry: storage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const firstHydration = manager.hydrateTimelineFromProvider(created.id, { force: true });
    session!.pushEvent({ type: "turn_started", provider: "codex", turnId });
    for (const item of progressItems) {
      session!.pushEvent({ type: "timeline", provider: "codex", turnId, timestamp, item });
    }
    session!.pushEvent({
      type: "usage_updated",
      provider: "codex",
      turnId,
      usage: { inputTokens: 1 },
    });

    await firstHydration;
    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "stalled",
      observedThroughSeq: 3,
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressKind: "write",
    });
    await manager.hydrateTimelineFromProvider(created.id, { force: true });
    await manager.flush();

    expect(historyGeneration).toBe(2);
    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "stalled",
      timelineEpoch: "successor-progress-epoch",
      continuationBoundarySeq: 1,
      observedThroughSeq: 3,
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressKind: "write",
    });
    const committedRows = await durableTimelineStore.getCommittedRows(agentId);
    expect(committedRows).toHaveLength(3);
    expect(committedRows.map((row) => row.turnId)).toEqual([turnId, turnId, turnId]);
    expect(committedRows.map((row) => row.item)).toEqual(progressItems);
    expect((await storage.get(agentId))?.materialProgress).toMatchObject({
      timelineEpoch: "successor-progress-epoch",
      continuationBoundarySeq: 1,
      acceptedTurnId: turnId,
      observedThroughSeq: 3,
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressKind: "write",
    });
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("one canonical and one buffered identical compaction remain two stalled occurrences", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-hydration-progress-ledger-"));
  const agentId = "00000000-0000-4000-8000-000000000206";
  const turnId = "accepted-ledger-turn";
  const compaction: AgentTimelineItem = { type: "compaction", status: "completed" };
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);
  let session: TestAgentSession | null = null;
  let historyGeneration = 0;

  class LedgerHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyGeneration += 1;
      if (historyGeneration === 2) {
        historyStarted.resolve();
        await releaseHistory.promise;
        yield { type: "timeline", provider: "codex", item: compaction };
      }
    }
  }
  class LedgerHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new LedgerHistorySession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new LedgerHistoryClient() },
    registry: storage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const firstHydration = manager.hydrateTimelineFromProvider(created.id, { force: true });
    session!.pushEvent({ type: "turn_started", provider: "codex", turnId });
    session!.pushEvent({ type: "timeline", provider: "codex", turnId, item: compaction });
    session!.pushEvent({
      type: "usage_updated",
      provider: "codex",
      turnId,
      usage: { inputTokens: 1 },
    });
    await firstHydration;
    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
    });

    const replacement = manager.hydrateTimelineFromProvider(created.id, { force: true });
    await historyStarted.promise;
    session!.pushEvent({ type: "timeline", provider: "codex", turnId, item: compaction });
    releaseHistory.resolve();
    await replacement;
    await manager.flush();

    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "stalled",
      observedThroughSeq: 2,
      completedCompactionsSinceMaterialProgress: 2,
    });
    const committedRows = await durableTimelineStore.getCommittedRows(agentId);
    expect(committedRows).toHaveLength(2);
    expect(committedRows.map((row) => row.turnId)).toEqual([turnId, turnId]);
    expect(committedRows.map((row) => row.item)).toEqual([compaction, compaction]);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("partial provider cardinality fails stalled material progress rebinding closed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-hydration-progress-ambiguous-"));
  const agentId = "00000000-0000-4000-8000-000000000205";
  const turnId = "accepted-ambiguous-turn";
  const compaction: AgentTimelineItem = { type: "compaction", status: "completed" };
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const epochs = [
    "initial-ambiguous-epoch",
    "first-ambiguous-epoch",
    "replacement-ambiguous-epoch",
  ];
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger, {
    epochFactory: () => epochs.shift() ?? "unexpected-ambiguous-epoch",
  });
  let session: TestAgentSession | null = null;
  let historyGeneration = 0;

  class AmbiguousProgressHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyGeneration += 1;
      if (historyGeneration === 2) {
        yield { type: "timeline", provider: "codex", item: compaction };
      }
    }
  }

  class AmbiguousProgressHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new AmbiguousProgressHistorySession(config);
      return session;
    }
  }

  const manager = new AgentManager({
    clients: { codex: new AmbiguousProgressHistoryClient() },
    registry: storage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const firstHydration = manager.hydrateTimelineFromProvider(created.id, { force: true });
    session!.pushEvent({ type: "turn_started", provider: "codex", turnId });
    session!.pushEvent({ type: "timeline", provider: "codex", turnId, item: compaction });
    session!.pushEvent({ type: "timeline", provider: "codex", turnId, item: compaction });
    session!.pushEvent({
      type: "usage_updated",
      provider: "codex",
      turnId,
      usage: { inputTokens: 1 },
    });
    await firstHydration;
    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
    });

    await manager.hydrateTimelineFromProvider(created.id, { force: true });
    await manager.flush();

    expect(manager.getMaterialProgress(created.id)).toMatchObject({
      state: "none",
      timelineEpoch: "replacement-ambiguous-epoch",
      continuationBoundarySeq: null,
      observedThroughSeq: 1,
      completedCompactionsSinceMaterialProgress: 2,
      reason:
        "Material progress is unavailable because accepted-turn attribution could not be proven after timeline replacement.",
    });
    const committedRows = await durableTimelineStore.getCommittedRows(agentId);
    expect(committedRows).toHaveLength(1);
    expect(committedRows.every((row) => row.turnId === undefined)).toBe(true);
    expect((await storage.get(agentId))?.materialProgress).toMatchObject({
      timelineEpoch: "replacement-ambiguous-epoch",
      continuationBoundarySeq: null,
      observedThroughSeq: 1,
      completedCompactionsSinceMaterialProgress: 2,
      unavailableReason:
        "Material progress is unavailable because accepted-turn attribution could not be proven after timeline replacement.",
    });
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ordered canonical reconciliation preserves cross-turn ids around intervening rows", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-hydration-cross-turn-ledger-"));
  const agentId = "00000000-0000-4000-8000-000000000207";
  const firstTurnId = "first-identical-turn";
  const secondTurnId = "second-identical-turn";
  const compaction: AgentTimelineItem = { type: "compaction", status: "completed" };
  const intervening: AgentTimelineItem = {
    type: "assistant_message",
    text: "chronological separator",
  };
  const providerItems = [compaction, intervening, compaction];
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);
  let session: TestAgentSession | null = null;

  class CrossTurnHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      for (const item of providerItems) {
        yield { type: "timeline", provider: "codex", item };
      }
    }
  }
  class CrossTurnHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new CrossTurnHistorySession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new CrossTurnHistoryClient() },
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    session!.pushEvent({ type: "turn_started", provider: "codex", turnId: firstTurnId });
    session!.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId: firstTurnId,
      item: compaction,
    });
    session!.pushEvent({ type: "turn_completed", provider: "codex", turnId: firstTurnId });
    session!.pushEvent({ type: "turn_started", provider: "codex", turnId: secondTurnId });
    session!.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId: secondTurnId,
      item: intervening,
    });
    session!.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId: secondTurnId,
      item: compaction,
    });
    session!.pushEvent({
      type: "usage_updated",
      provider: "codex",
      turnId: secondTurnId,
      usage: { inputTokens: 1 },
    });
    await manager.flush();

    await manager.hydrateTimelineFromProvider(created.id, { force: true });
    const committedRows = await durableTimelineStore.getCommittedRows(agentId);
    expect(committedRows).toHaveLength(3);
    expect(committedRows.map((row) => row.item)).toEqual(providerItems);
    expect(committedRows.map((row) => row.turnId)).toEqual([
      firstTurnId,
      secondTurnId,
      secondTurnId,
    ]);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider history consumes ordered live timeline and child overlap exactly once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-overlap-"));
  const agentId = "00000000-0000-4000-8000-000000000183";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  let session: TestAgentSession | null = null;
  const turnId = "overlap-turn";
  const timelineItem = { type: "assistant_message", text: "overlapping event" } as const;
  const childEvent = {
    type: "upsert" as const,
    id: "overlap-child",
    title: "Overlap child",
    status: "completed" as const,
    timestamp: "2026-08-02T00:00:00.000Z",
  };

  class OverlapHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield { type: "timeline", provider: "codex", item: timelineItem };
      yield { type: "provider_subagent", provider: "codex", event: childEvent };
    }
  }
  class OverlapHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new OverlapHistorySession(config);
      return session;
    }
  }

  const manager = new AgentManager({
    clients: { codex: new OverlapHistoryClient() },
    logger,
    idFactory: () => agentId,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { agentId, replayState: false });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager.hydrateTimelineFromProvider(created.id, {
      force: true,
      broadcast: true,
    });
    await historyStarted.promise;
    session?.pushEvent({ type: "timeline", provider: "codex", turnId, item: timelineItem });
    session?.pushEvent({ type: "provider_subagent", provider: "codex", event: childEvent });
    releaseHistory.resolve();
    await hydration;
    await manager.flush();

    expect(manager.getTimeline(agentId)).toEqual([timelineItem]);
    await expect(manager.getTimelineRows(agentId)).resolves.toMatchObject([
      { seq: 1, turnId, item: timelineItem },
    ]);
    expect(manager.listProviderSubagents(agentId)).toEqual([
      expect.objectContaining({ id: "overlap-child", status: "completed" }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "agent_stream" &&
          event.event.type === "timeline" &&
          event.event.item.type === "assistant_message" &&
          event.event.item.text === timelineItem.text,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "provider_subagent" &&
          event.event.type === "upsert" &&
          event.event.subagent.id === "overlap-child",
      ),
    ).toHaveLength(1);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("overlap dedupe preserves user state and completed-shell workspace effects exactly once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-overlap-effects-"));
  const agentId = "00000000-0000-4000-8000-000000000196";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  const userItem = { type: "user_message", text: "overlapping user input" } as const;
  const shellItem = {
    type: "tool_call",
    callId: "overlap-shell",
    name: "bash",
    status: "completed",
    detail: { type: "shell", command: "gh pr merge 123 --squash" },
    error: null,
  } as const;
  let session: TestAgentSession | null = null;
  const onWorkspaceStateMayHaveChanged = vi.fn();
  class OverlapEffectsSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield { type: "timeline", provider: "codex", item: userItem };
      yield { type: "timeline", provider: "codex", item: shellItem };
    }
  }
  class OverlapEffectsClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new OverlapEffectsSession(config);
      return session;
    }
  }
  const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);
  const manager = new AgentManager({
    clients: { codex: new OverlapEffectsClient() },
    registry: agentStorage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
    onWorkspaceStateMayHaveChanged,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { agentId, replayState: false });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager.hydrateTimelineFromProvider(agentId, {
      force: true,
      broadcast: true,
    });
    await historyStarted.promise;
    session?.pushEvent({ type: "timeline", provider: "codex", item: userItem });
    session?.pushEvent({ type: "timeline", provider: "codex", item: shellItem });
    releaseHistory.resolve();
    await hydration;
    await manager.flush();

    expect(manager.getTimeline(agentId)).toEqual([userItem, shellItem]);
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toHaveLength(2);
    expect((await agentStorage.get(agentId))?.lastUserMessageAt).toBeTruthy();
    expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledTimes(1);
    expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledWith({ cwd: workdir });
    for (const item of [userItem, shellItem]) {
      expect(
        events.filter(
          (event) =>
            event.type === "agent_stream" &&
            event.event.type === "timeline" &&
            event.event.item.type === item.type,
        ),
      ).toHaveLength(1);
    }
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("timeline overlap dedupe still forwards the live turn event to its waiter", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-overlap-waiter-"));
  const agentId = "00000000-0000-4000-8000-000000000194";
  const turnId = "turn-overlap-waiter";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  const overlapItem = { type: "assistant_message", text: "overlap waiter result" } as const;
  let session: OverlapWaiterSession | null = null;

  class OverlapWaiterSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      return { turnId };
    }

    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield { type: "timeline", provider: "codex", item: overlapItem };
    }
  }
  class OverlapWaiterClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new OverlapWaiterSession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new OverlapWaiterClient() },
    logger,
    idFactory: () => agentId,
  });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const run = manager.runAgent(agentId, "exercise overlap waiter");
    await manager.waitForAgentRunStart(agentId);
    const hydration = manager.hydrateTimelineFromProvider(agentId, { force: true });
    await historyStarted.promise;
    session?.pushEvent({ type: "timeline", provider: "codex", turnId, item: overlapItem });
    releaseHistory.resolve();
    await hydration;
    session?.pushEvent({ type: "turn_completed", provider: "codex", turnId });

    await expect(run).resolves.toMatchObject({
      finalText: "overlap waiter result",
      timeline: [overlapItem],
    });
    expect(manager.getTimeline(agentId)).toEqual([overlapItem]);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("close cancels and joins an incarnation-bound provider history read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-close-join-"));
  const agentId = "00000000-0000-4000-8000-000000000184";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();

  class ClosingHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "stale close history" },
      };
    }
  }
  class ClosingHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ClosingHistorySession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ClosingHistoryClient() },
    logger,
    idFactory: () => agentId,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { agentId, replayState: false });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager
      .hydrateTimelineFromProvider(created.id, { force: true })
      .catch((error: unknown) => error);
    await historyStarted.promise;
    let closeSettled = false;
    const closing = manager.closeAgent(agentId).then(() => {
      closeSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseHistory.resolve();
    await closing;
    await expect(hydration).resolves.toBeInstanceOf(Error);
    expect(
      events.some(
        (event) =>
          event.type === "agent_stream" &&
          event.event.type === "timeline" &&
          event.event.item.type === "assistant_message" &&
          event.event.item.text === "stale close history",
      ),
    ).toBe(false);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("close fences a never-resolving provider history read after the rescue bound", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-close-timeout-"));
  const agentId = "00000000-0000-4000-8000-000000000192";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();

  class HungHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "late fenced history" },
      };
    }
  }
  class HungHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new HungHistorySession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new HungHistoryClient() },
    logger,
    idFactory: () => agentId,
    rescueTimeouts: { historyHydrationCancelMs: 10 },
  });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager
      .hydrateTimelineFromProvider(agentId, { force: true })
      .catch((error: unknown) => error);
    await historyStarted.promise;
    await manager.closeAgent(agentId);
    expect(manager.getAgent(agentId)).toBeNull();

    releaseHistory.resolve();
    await expect(hydration).resolves.toBeInstanceOf(Error);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("close rejects timeline and drops session ingress admitted after its drain fence", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-ingress-fence-"));
  const agentId = "00000000-0000-4000-8000-000000000193";
  const recheckEntered = deferred<void>();
  const releaseRecheck = deferred<void>();
  let recheckCount = 0;
  let session: TestAgentSession | null = null;
  class ClosingFenceClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new TestAgentSession(config);
      return session;
    }
  }
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);
  const manager = new AgentManager({
    clients: { codex: new ClosingFenceClient() },
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: "pre-close durable truth",
    });
    const closing = manager.closeAgent(agentId, async () => {
      recheckCount += 1;
      if (recheckCount === 1) {
        recheckEntered.resolve();
        await releaseRecheck.promise;
      }
    });
    await recheckEntered.promise;
    session?.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "late session ingress" },
    });
    await expect(
      manager.appendTimelineItem(agentId, {
        type: "assistant_message",
        text: "late public ingress",
      }),
    ).rejects.toThrow(`Agent ${agentId} is closing`);
    releaseRecheck.resolve();
    await closing;
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toMatchObject([
      { seq: 1, item: { text: "pre-close durable truth" } },
    ]);
  } finally {
    releaseRecheck.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("deleteAgentState cancels and joins provider history before deleting durable truth", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-delete-join-"));
  const agentId = "00000000-0000-4000-8000-000000000185";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger);

  class DeletingHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "stale delete history" },
      };
    }
  }
  class DeletingHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new DeletingHistorySession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new DeletingHistoryClient() },
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: "prior durable truth",
    });
    const hydration = manager
      .hydrateTimelineFromProvider(created.id, { force: true })
      .catch((error: unknown) => error);
    await historyStarted.promise;
    let deleteSettled = false;
    const deleting = manager.deleteAgentState(agentId).then(() => {
      deleteSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(deleteSettled).toBe(false);
    releaseHistory.resolve();
    await deleting;
    await expect(hydration).resolves.toBeInstanceOf(Error);
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toEqual([]);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("reload cancels and joins old-incarnation history and ignores old session events", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-reload-join-"));
  const agentId = "00000000-0000-4000-8000-000000000186";
  const historyStarted = deferred<void>();
  const releaseHistory = deferred<void>();
  let originalSession: TestAgentSession | null = null;

  class ReloadingHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyStarted.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "stale reload history" },
      };
    }
  }
  class ReloadingHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      originalSession = new ReloadingHistorySession(config);
      return originalSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new TestAgentSession({ provider: "codex", cwd: config?.cwd ?? workdir });
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ReloadingHistoryClient() },
    logger,
    idFactory: () => agentId,
  });
  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager
      .hydrateTimelineFromProvider(created.id, { force: true })
      .catch((error: unknown) => error);
    await historyStarted.promise;
    let reloadSettled = false;
    const reloading = manager.reloadAgentSession(agentId).then(() => {
      reloadSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(reloadSettled).toBe(false);
    releaseHistory.resolve();
    await reloading;
    await expect(hydration).resolves.toBeInstanceOf(Error);
    originalSession?.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "late old-incarnation event" },
    });
    await manager.flush();
    expect(manager.getTimeline(agentId)).toEqual([]);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a live event without a durable timeline persists the promoted history state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-history-primed-"));
  const agentId = "00000000-0000-4000-8000-000000000197";
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let session: TestAgentSession | null = null;
  class LiveHistoryPrimedClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new TestAgentSession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new LiveHistoryPrimedClient() },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    session?.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "user_message", text: "live state must persist as primed" },
    });
    await vi.waitFor(async () => {
      expect(manager.getTimeline(agentId)).toHaveLength(1);
      expect((await storage.get(agentId))?.lastUserMessageAt).toBeTruthy();
    });
    await manager.flush();

    expect(manager.getAgent(agentId)?.historyPrimed).toBe(true);
    expect((await storage.get(agentId))?.historyPrimed).toBe(true);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("write-ahead unprimed state survives a process-death append boundary and forces recovery", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-write-recovery-"));
  const agentId = "00000000-0000-4000-8000-000000000187";
  const storagePath = join(workdir, "agents");
  const timelinePath = join(workdir, "timelines");
  const storage = new AgentStorage(storagePath, logger);
  const writeStarted = deferred<void>();
  const abortWrite = deferred<void>();
  let simulateProcessDeath = false;
  const durableTimelineStore = new FileAgentTimelineStore(timelinePath, logger, {
    writeJson: async (filePath, value) => {
      if (simulateProcessDeath) {
        writeStarted.resolve();
        await abortWrite.promise;
        throw new Error("simulated process death before atomic timeline rename");
      }
      await writeJsonFileAtomic(filePath, value);
    },
  });

  class DurableFirstSession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "baseline durable truth" },
      };
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "provider event recovered after crash" },
      };
    }
  }
  class DurableFirstClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new DurableFirstSession(config);
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new DurableFirstSession({ provider: "codex", cwd: config?.cwd ?? workdir });
    }
  }
  const manager = new AgentManager({
    clients: { codex: new DurableFirstClient() },
    registry: storage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: "baseline durable truth",
    });
    await manager.flush();
    expect((await storage.get(agentId))?.historyPrimed).toBe(true);

    simulateProcessDeath = true;
    const interruptedAppend = manager
      .appendTimelineItem(agentId, {
        type: "assistant_message",
        text: "provider event recovered after crash",
      })
      .catch((error: unknown) => error);
    await writeStarted.promise;
    expect(manager.getTimeline(agentId)).toEqual([
      { type: "assistant_message", text: "baseline durable truth" },
    ]);
    expect((await storage.get(agentId))?.historyPrimed).toBe(false);
    await expect(
      new FileAgentTimelineStore(timelinePath, logger).getCommittedRows(agentId),
    ).resolves.toMatchObject([{ seq: 1, item: { text: "baseline durable truth" } }]);

    const restartedStorage = new AgentStorage(storagePath, logger);
    const restartedTimelineStore = new FileAgentTimelineStore(timelinePath, logger);
    const restartedManager = new AgentManager({
      clients: { codex: new DurableFirstClient() },
      registry: restartedStorage,
      durableTimelineStore: restartedTimelineStore,
      logger,
      idFactory: () => agentId,
    });
    try {
      await ensureAgentLoaded(agentId, {
        agentManager: restartedManager,
        agentStorage: restartedStorage,
        logger,
      });
      await restartedManager.flush();
      expect(restartedManager.getTimeline(agentId)).toEqual([
        { type: "assistant_message", text: "baseline durable truth" },
        { type: "assistant_message", text: "provider event recovered after crash" },
      ]);
      expect(restartedManager.getAgent(agentId)?.historyPrimed).toBe(true);
      expect((await restartedStorage.get(agentId))?.historyPrimed).toBe(true);
      await expect(restartedTimelineStore.getCommittedRows(agentId)).resolves.toMatchObject([
        { seq: 1, item: { text: "baseline durable truth" } },
        { seq: 2, item: { text: "provider event recovered after crash" } },
      ]);

      abortWrite.resolve();
      await expect(interruptedAppend).resolves.toBeInstanceOf(Error);
    } finally {
      await restartedManager.closeAgent(agentId).catch(() => undefined);
    }
  } finally {
    simulateProcessDeath = false;
    abortWrite.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("flush and close join the newest serialized live timeline obligation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-write-join-"));
  const agentId = "00000000-0000-4000-8000-000000000188";
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  let writeCount = 0;
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger, {
    writeJson: async (filePath, value) => {
      writeCount += 1;
      if (writeCount > 1) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      await writeJsonFileAtomic(filePath, value);
    },
  });
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const append = manager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: "joined durable live row",
    });
    await writeStarted.promise;
    let flushSettled = false;
    let closeSettled = false;
    const flushing = manager.flush().then(() => {
      flushSettled = true;
      return undefined;
    });
    const closing = manager.closeAgent(agentId).then(() => {
      closeSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    expect(closeSettled).toBe(false);

    releaseWrite.resolve();
    await append;
    await flushing;
    await closing;
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toMatchObject([
      { seq: 1, item: { text: "joined durable live row" } },
    ]);
  } finally {
    releaseWrite.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider import does not publish completion before its timeline seed is durable", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-import-seed-await-"));
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger, {
    writeJson: async (filePath, value) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      await writeJsonFileAtomic(filePath, value);
    },
  });
  const importedSession = new TestAgentSession({ provider: "codex", cwd: workdir });
  class AwaitedImportClient extends TestAgentClient {
    override async importSession(input: ImportProviderSessionInput) {
      return {
        session: importedSession,
        config: { provider: "codex" as const, cwd: workdir },
        persistence: { provider: "codex" as const, sessionId: input.providerHandleId },
        timeline: [
          {
            item: { type: "assistant_message" as const, text: "awaited imported history" },
            timestamp: "2026-08-02T00:00:00.000Z",
          },
        ],
      };
    }
  }
  const manager = new AgentManager({
    clients: { codex: new AwaitedImportClient() },
    durableTimelineStore,
    logger,
  });
  let importedAgentId: string | null = null;
  try {
    let importSettled = false;
    const importing = manager
      .importProviderSession({
        provider: "codex",
        providerHandleId: "awaited-import",
        cwd: workdir,
        workspaceId: undefined,
      })
      .then((agent) => {
        importSettled = true;
        importedAgentId = agent.id;
        return agent;
      });
    await writeStarted.promise;
    await Promise.resolve();
    expect(importSettled).toBe(false);
    releaseWrite.resolve();
    const imported = await importing;
    expect(imported.historyPrimed).toBe(true);
    await expect(durableTimelineStore.getCommittedRows(imported.id)).resolves.toMatchObject([
      { seq: 1, item: { text: "awaited imported history" } },
    ]);
  } finally {
    releaseWrite.resolve();
    if (importedAgentId) await manager.closeAgent(importedAgentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("failed durable import seed rolls back retained state and the same id retries cleanly", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-import-seed-rollback-"));
  const agentId = "00000000-0000-4000-8000-000000000191";
  let rejectSeed = true;
  const durableTimelineStore = new FileAgentTimelineStore(join(workdir, "timelines"), logger, {
    writeJson: async (filePath, value) => {
      if (rejectSeed) throw new Error("injected import seed failure");
      await writeJsonFileAtomic(filePath, value);
    },
  });
  const importedSessions: Array<TestAgentSession & { closeCalls: number }> = [];
  class RollbackImportClient extends TestAgentClient {
    override async importSession(input: ImportProviderSessionInput) {
      const session = new (class extends TestAgentSession {
        closeCalls = 0;
        override async close(): Promise<void> {
          this.closeCalls += 1;
        }
      })({ provider: "codex", cwd: workdir });
      importedSessions.push(session);
      return {
        session,
        config: { provider: "codex" as const, cwd: workdir },
        persistence: { provider: "codex" as const, sessionId: input.providerHandleId },
        timeline: [
          {
            item: { type: "assistant_message" as const, text: "retry-safe imported history" },
            timestamp: "2026-08-02T00:00:00.000Z",
          },
        ],
      };
    }
  }
  const manager = new AgentManager({
    clients: { codex: new RollbackImportClient() },
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });
  try {
    await expect(
      manager.importProviderSession({
        provider: "codex",
        providerHandleId: "seed-failure",
        cwd: workdir,
        workspaceId: undefined,
      }),
    ).rejects.toThrow("injected import seed failure");
    expect(manager.getAgent(agentId)).toBeNull();
    expect(importedSessions[0]?.closeCalls).toBe(1);
    rejectSeed = false;
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toEqual([]);

    const imported = await manager.importProviderSession({
      provider: "codex",
      providerHandleId: "seed-retry",
      cwd: workdir,
      workspaceId: undefined,
    });
    expect(imported.id).toBe(agentId);
    expect(manager.getTimeline(agentId)).toEqual([
      { type: "assistant_message", text: "retry-safe imported history" },
    ]);
    await expect(durableTimelineStore.getCommittedRows(agentId)).resolves.toMatchObject([
      { seq: 1, item: { text: "retry-safe imported history" } },
    ]);
  } finally {
    rejectSeed = false;
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("atomic provider hydration replays a live row after the complete replacement", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-live-replay-"));
  const timelineStoragePath = join(workdir, "timelines");
  const agentId = "00000000-0000-4000-8000-000000000156";
  const historyEntered = deferred<void>();
  const releaseHistory = deferred<void>();
  let activeSession: TestAgentSession | null = null;

  class LiveDuringHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      historyEntered.resolve();
      await releaseHistory.promise;
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "user_message", text: "complete provider history" },
      };
    }
  }

  class LiveDuringHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      activeSession = new LiveDuringHistorySession(config);
      return activeSession;
    }
  }

  const epochs = ["initial-live-epoch", "replacement-live-epoch"];
  const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
  const durableStore = new FileAgentTimelineStore(timelineStoragePath, logger, {
    epochFactory: () => epochs.shift() ?? "unexpected-live-epoch",
  });
  const manager = new AgentManager({
    clients: { codex: new LiveDuringHistoryClient() },
    registry: agentStorage,
    durableTimelineStore: durableStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const hydration = manager.hydrateTimelineFromProvider(created.id, { force: true });
    await historyEntered.promise;
    activeSession?.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "live after gate admission" },
    });
    releaseHistory.resolve();
    await hydration;
    await manager.flush();

    const inMemory = manager.fetchTimeline(created.id, { direction: "tail", limit: 0 });
    const durable = await durableStore.fetchCommitted(created.id, { limit: 0 });
    expect(inMemory.epoch).toBe("replacement-live-epoch");
    expect(durable).toEqual(inMemory);
    expect(inMemory.rows).toMatchObject([
      { seq: 1, item: { type: "user_message", text: "complete provider history" } },
      { seq: 2, item: { type: "assistant_message", text: "live after gate admission" } },
    ]);
    expect(manager.getAgent(agentId)?.historyPrimed).toBe(true);
    expect((await agentStorage.get(agentId))?.historyPrimed).toBe(true);
  } finally {
    releaseHistory.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("failed provider metadata refresh preserves prior file-backed timeline and children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-refresh-history-rollback-"));
  const agentId = "00000000-0000-4000-8000-000000000159";
  const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
  const timelineStoragePath = join(workdir, "timelines");
  const durableTimelineStore = new FileAgentTimelineStore(timelineStoragePath, logger);
  let activeSession: TestAgentSession | null = null;

  class FailingRefreshHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield* [];
      throw new Error("Failed to read OpenCode session metadata for history: Forbidden");
    }
  }

  class FailingRefreshHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      activeSession = new TestAgentSession(config);
      return activeSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new FailingRefreshHistorySession({ provider: "codex", cwd: config?.cwd ?? workdir });
    }
  }

  const manager = new AgentManager({
    clients: { codex: new FailingRefreshHistoryClient() },
    registry: agentStorage,
    durableTimelineStore,
    logger,
    idFactory: () => agentId,
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(created.id, {
      type: "assistant_message",
      text: "durable proof before refresh",
    });
    activeSession?.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: { type: "upsert", id: "prior-child", status: "running" },
    });
    await vi.waitFor(() => expect(manager.listProviderSubagents(agentId)).toHaveLength(1));
    await manager.flush();

    const timelineBefore = manager.fetchTimeline(agentId, { direction: "tail", limit: 0 });
    const childrenBefore = manager.listProviderSubagents(agentId);
    const durableBefore = await durableTimelineStore.fetchCommitted(agentId, { limit: 0 });

    await manager.reloadAgentSession(agentId, undefined, { rehydrateFromDisk: true });
    expect(manager.fetchTimeline(agentId, { direction: "tail", limit: 0 })).toEqual(timelineBefore);
    expect(manager.listProviderSubagents(agentId)).toEqual(childrenBefore);

    await expect(
      manager.hydrateTimelineFromProvider(agentId, { force: true, broadcast: true }),
    ).rejects.toThrow("Failed to read OpenCode session metadata for history: Forbidden");
    await manager.flush();

    expect(manager.fetchTimeline(agentId, { direction: "tail", limit: 0 })).toEqual(timelineBefore);
    expect(manager.listProviderSubagents(agentId)).toEqual(childrenBefore);
    await expect(
      new FileAgentTimelineStore(timelineStoragePath, logger).fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toEqual(durableBefore);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("reloadAgentSession preserves current title when config title is unset", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-title-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000126",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.setTitle(snapshot.id, "Generated title");

  const beforeReload = await storage.get(snapshot.id);
  expect(beforeReload?.title).toBe("Generated title");
  expect(beforeReload?.config?.title).toBeUndefined();

  await manager.reloadAgentSession(snapshot.id);

  const afterReload = await storage.get(snapshot.id);
  expect(afterReload?.title).toBe("Generated title");
  expect(afterReload?.config?.title).toBeUndefined();
});

test("setTitle bumps updatedAt and persists title in the same snapshot write", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-title-updated-at-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000127",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const before = await storage.get(snapshot.id);
  expect(before).not.toBeNull();

  await manager.setTitle(snapshot.id, "Generated title");

  const after = await storage.get(snapshot.id);
  expect(after?.title).toBe("Generated title");
  expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));

  const live = manager.getAgent(snapshot.id);
  expect(live).not.toBeNull();
  expect(live!.updatedAt.getTime()).toBeGreaterThan(Date.parse(before!.updatedAt));
});

test("updateAgentMetadata bumps updatedAt for stored agents", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-stored-metadata-updated-at-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000128",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(snapshot.id);

  const closed = await storage.get(snapshot.id);
  expect(closed).not.toBeNull();
  const before = { ...closed!, labels: { surface: "mobile" } };
  await storage.upsert(before);
  expect(manager.getAgent(snapshot.id)).toBeNull();

  const upsertSpy = vi.spyOn(storage, "upsert");

  await manager.updateAgentMetadata(snapshot.id, {
    title: "Stored title",
    labels: { role: "worker" },
  });

  expect(upsertSpy).toHaveBeenCalledTimes(1);
  const after = await storage.get(snapshot.id);
  expect(after?.title).toBe("Stored title");
  expect(after?.labels).toEqual({ surface: "mobile", role: "worker" });
  expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
});

test("persists live mode, model, and thinking changes without an external snapshot subscriber", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-persist-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000132",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
      model: "gpt-5.2-codex",
      thinkingOptionId: "low",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setAgentMode(snapshot.id, "build");
  await manager.setAgentModel(snapshot.id, "gpt-5.4");
  await manager.setAgentThinkingOption(snapshot.id, "high");
  await manager.flush();

  const persisted = await storage.get(snapshot.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastModeId).toBe("build");
  expect(persisted?.config?.model).toBe("gpt-5.4");
  expect(persisted?.config?.thinkingOptionId).toBe("high");
  expect(persisted?.runtimeInfo?.modeId).toBe("build");
  expect(persisted?.runtimeInfo?.model).toBe("gpt-5.4");
});

test("later explicit config mutations win over events emitted by earlier mutations", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-config-mutation-order-"));
  class ConfigMutationSession extends TestAgentSession {
    async setModel(): Promise<void> {
      this.pushEvent({
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "model changed" },
      });
      this.pushEvent({
        type: "thinking_option_changed",
        provider: "codex",
        thinkingOptionId: "low",
      });
    }

    async setThinkingOption(): Promise<void> {}
  }
  class ConfigMutationClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ConfigMutationSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new ConfigMutationClient() },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000134",
  });
  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.2-codex",
      thinkingOptionId: "off",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setAgentModel(snapshot.id, "gpt-5.4");
  await manager.setAgentThinkingOption(snapshot.id, "high");
  await manager.flush();

  expect(manager.getAgent(snapshot.id)?.config.thinkingOptionId).toBe("high");
});

test("session config drift events update state through the stream channel", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-session-config-events-"));
  let capturedSession: TestAgentSession | null = null;
  class ConfigEventClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      capturedSession = new TestAgentSession(config);
      return capturedSession;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ConfigEventClient(),
    },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
      model: "gpt-5.2-codex",
      thinkingOptionId: "low",
    },
    undefined,
    { workspaceId: undefined },
  );
  const streams: AgentStreamEvent[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") {
        streams.push(event.event);
      }
    },
    { agentId: snapshot.id, replayState: false },
  );

  capturedSession?.pushEvent({
    type: "mode_changed",
    provider: "codex",
    currentModeId: "build",
    availableModes: [
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
    ],
  });
  capturedSession?.pushEvent({
    type: "model_changed",
    provider: "codex",
    runtimeInfo: {
      provider: "codex",
      sessionId: capturedSession.id,
      model: "gpt-5.4",
      modeId: "build",
      thinkingOptionId: "low",
    },
  });
  capturedSession?.pushEvent({
    type: "thinking_option_changed",
    provider: "codex",
    thinkingOptionId: "high",
  });
  await manager.flush();

  const agent = manager.getAgent(snapshot.id);
  expect(agent?.currentModeId).toBe("build");
  expect(agent?.config.thinkingOptionId).toBe("high");
  expect(agent?.availableModes).toEqual([
    { id: "plan", label: "Plan" },
    { id: "build", label: "Build" },
  ]);
  expect(agent?.runtimeInfo).toMatchObject({
    model: "gpt-5.4",
    modeId: "build",
    thinkingOptionId: "high",
  });
  expect(streams.map((event) => event.type)).toEqual([]);
});

test("setLabels merges and persists labels", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-labels-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Label test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setLabels(snapshot.id, { surface: "mobile" });
  await manager.setLabels(snapshot.id, { phase: "1a" });

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.labels).toEqual({
    surface: "mobile",
    phase: "1a",
  });
});

test("detachAgent removes only the parent label from a live agent and emits state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-live-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    {
      labels: {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        team: "infra",
      },
      workspaceId: undefined,
    },
  );
  const emittedLabels: Array<Record<string, string>> = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === child.id) {
        emittedLabels.push(event.agent.labels);
      }
    },
    { agentId: child.id, replayState: false },
  );

  const result = await manager.detachAgent(child.id);
  await manager.flush();
  unsubscribe();

  expect(result.previousParentAgentId).toBe(parent.id);
  expect(result.live).toBe(true);
  expect(result.record.labels).toEqual({ team: "infra" });
  expect(manager.getAgent(child.id)?.labels).toEqual({ team: "infra" });
  expect((await storage.get(child.id))?.labels).toEqual({ team: "infra" });
  expect(emittedLabels).toContainEqual({ team: "infra" });
});

test("detachAgent removes the parent label from a stored-only agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-stored-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored child",
    },
    undefined,
    {
      labels: {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        role: "reviewer",
      },
      workspaceId: undefined,
    },
  );
  await manager.closeAgent(child.id);

  const result = await manager.detachAgent(child.id);

  expect(result.previousParentAgentId).toBe(parent.id);
  expect(result.live).toBe(false);
  expect(result.record.labels).toEqual({ role: "reviewer" });
  expect((await storage.get(child.id))?.labels).toEqual({ role: "reviewer" });
});

test("archiveAgent does not cascade to a detached former child", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-cascade-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );

  await manager.detachAgent(child.id);
  await manager.archiveAgent(parent.id);

  expect((await storage.get(parent.id))?.archivedAt).toEqual(expect.any(String));
  expect((await storage.get(child.id))?.archivedAt).toBeFalsy();
});

test.each([
  { mutation: "setLabels attach" as const, initiallyAttached: false },
  { mutation: "detachAgent" as const, initiallyAttached: true },
  { mutation: "updateAgentMetadata attach" as const, initiallyAttached: false },
  { mutation: "updateAgentMetadata reparent" as const, initiallyAttached: true },
])(
  "$mutation persistence failure keeps live and durable cascade membership aligned",
  async (testCase) => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-label-persist-failure-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const membershipGate = new DestructiveMembershipGate();
    const manager = new AgentManager({
      clients: { codex: new TestAgentClient() },
      registry: storage,
      membershipGate,
      logger,
    });
    const originalParent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Original parent" },
      undefined,
      { workspaceId: "workspace-original-parent" },
    );
    const nextParent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Next parent" },
      undefined,
      { workspaceId: "workspace-next-parent" },
    );
    const initialLabels = testCase.initiallyAttached
      ? { [PARENT_AGENT_ID_LABEL]: originalParent.id, team: "infra" }
      : { team: "infra" };
    const child = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Child" },
      undefined,
      { labels: initialLabels, workspaceId: "workspace-child" },
    );
    const emittedLabels: Array<Record<string, string>> = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === child.id) {
          emittedLabels.push(event.agent.labels);
        }
      },
      { agentId: child.id, replayState: false },
    );
    const membershipVersion = manager.getMembershipVersion();
    const persistenceFailure = new Error("injected label persistence failure");
    const originalApplySnapshot = storage.applySnapshot.bind(storage);
    let failedTargetSnapshot = false;
    vi.spyOn(storage, "applySnapshot").mockImplementation(async (agent, options) => {
      if (!failedTargetSnapshot && agent.id === child.id) {
        failedTargetSnapshot = true;
        throw persistenceFailure;
      }
      await originalApplySnapshot(agent, options);
    });

    const mutation = (() => {
      switch (testCase.mutation) {
        case "setLabels attach":
          return manager.setLabels(child.id, { [PARENT_AGENT_ID_LABEL]: nextParent.id });
        case "detachAgent":
          return manager.detachAgent(child.id);
        case "updateAgentMetadata attach":
          return manager.updateAgentMetadata(child.id, {
            labels: { [PARENT_AGENT_ID_LABEL]: nextParent.id },
          });
        case "updateAgentMetadata reparent":
          return manager.updateAgentMetadata(child.id, {
            labels: { [PARENT_AGENT_ID_LABEL]: nextParent.id },
          });
      }
    })();

    await expect(mutation).rejects.toBe(persistenceFailure);

    expect(failedTargetSnapshot).toBe(true);
    expect(manager.getMembershipVersion()).toBe(membershipVersion);
    expect(manager.getAgent(child.id)?.labels).toEqual(initialLabels);
    expect((await storage.get(child.id))?.labels).toEqual(initialLabels);
    expect(emittedLabels).toEqual([]);

    const parentWhoseArchiveTestsTheDurableGraph = testCase.initiallyAttached
      ? originalParent
      : nextParent;
    await manager.archiveAgent(parentWhoseArchiveTestsTheDurableGraph.id);

    if (testCase.initiallyAttached) {
      expect((await storage.get(child.id))?.archivedAt).toEqual(expect.any(String));
      expect(manager.getAgent(child.id)).toBeNull();
    } else {
      expect((await storage.get(child.id))?.archivedAt).toBeFalsy();
      expect(manager.getAgent(child.id)).not.toBeNull();
    }
  },
);

test("runAgent persists finished attention and idle status without an external snapshot subscriber", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-finished-attention-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000134",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Finished attention test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.runAgent(snapshot.id, "say hello");
  await manager.flush();

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.lastStatus).toBe("idle");
  expect(persisted?.requiresAttention).toBe(true);
  expect(persisted?.attentionReason).toBe("finished");
  expect(persisted?.attentionTimestamp).toEqual(expect.any(String));
});

test("archiveSnapshot clears persisted attention and normalizes running status", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-attention-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000135",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Archive attention test",
    },
    undefined,
    { workspaceId: undefined },
  );

  const live = manager.getAgent(snapshot.id);
  expect(live).not.toBeNull();
  live!.lifecycle = "running";
  live!.attention = {
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date("2025-01-02T00:00:00.000Z"),
  };

  const archivedAt = "2025-01-03T00:00:00.000Z";
  const archivedRecord = await manager.archiveSnapshot(snapshot.id, archivedAt);

  expect(archivedRecord.archivedAt).toBe(archivedAt);
  expect(archivedRecord.lastStatus).toBe("idle");
  expect(archivedRecord.requiresAttention).toBe(false);
  expect(archivedRecord.attentionReason).toBeNull();
  expect(archivedRecord.attentionTimestamp).toBeNull();

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.archivedAt).toBe(archivedAt);
  expect(persisted?.lastStatus).toBe("idle");
  expect(persisted?.requiresAttention).toBe(false);
  expect(persisted?.attentionReason).toBeNull();
  expect(persisted?.attentionTimestamp).toBeNull();
});

test("archiveSnapshot dispatches archived state for stored-only agents", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-snapshot-dispatch-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  const created = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored archive dispatch",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(created.id);

  const events: ManagedAgent[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === created.id) {
        events.push(event.agent);
      }
    },
    { agentId: created.id, replayState: false },
  );

  await manager.archiveSnapshot(created.id, new Date().toISOString());

  expect(events.length).toBeGreaterThanOrEqual(1);
  const last = events[events.length - 1];
  expect(last.id).toBe(created.id);
  expect(last.lifecycle).toBe("closed");
});

test("reloadAgentSession cancels active run and resumes existing session once thread_started is observed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-active-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class DelayedPersistenceSession extends TestAgentSession {
    private persistenceReady = false;
    private delayedInterrupted = false;
    private releaseGate: (() => void) | null = null;
    private readonly gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
    private activeTurnId: string | null = null;

    constructor(
      config: AgentSessionConfig,
      private readonly stableSessionId: string,
      initiallyReady = false,
    ) {
      super(config);
      this.persistenceReady = initiallyReady;
    }

    override async startTurn(): Promise<{ turnId: string }> {
      this.delayedInterrupted = false;
      const turnId = `delayed-turn-${Date.now()}`;
      this.activeTurnId = turnId;
      // Push turn_started, then thread_started, then wait on gate
      setTimeout(async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.persistenceReady = true;
        this.pushEvent({
          type: "thread_started",
          provider: this.provider,
          sessionId: this.stableSessionId,
        });
        await this.gate;
        if (this.delayedInterrupted) {
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "Interrupted",
            turnId,
          });
        } else {
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }
      }, 0);
      return { turnId };
    }

    async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.persistenceReady ? this.stableSessionId : null,
        model: null,
        modeId: null,
      };
    }

    describePersistence() {
      if (!this.persistenceReady) {
        return null;
      }
      return {
        provider: this.provider,
        sessionId: this.stableSessionId,
      };
    }

    override async interrupt(): Promise<void> {
      this.delayedInterrupted = true;
      this.releaseGate?.();
    }

    async close(): Promise<void> {
      this.delayedInterrupted = true;
      this.releaseGate?.();
    }
  }

  class DelayedPersistenceClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    createSessionCalls = 0;
    resumeSessionCalls = 0;
    private nextSessionNumber = 1;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const sessionId = `delayed-session-${this.nextSessionNumber++}`;
      this.createSessionCalls += 1;
      return new DelayedPersistenceSession(config, sessionId);
    }

    async resumeSession(
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      this.resumeSessionCalls += 1;
      const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
      const merged: AgentSessionConfig = {
        ...metadata,
        ...overrides,
        provider: "codex",
        cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      };
      return new DelayedPersistenceSession(merged, handle.sessionId, true);
    }
  }

  const client = new DelayedPersistenceClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000114",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
  expect(snapshot.persistence).toBeNull();

  const stream = manager.streamAgent(snapshot.id, "hello");
  const first = await stream.next();
  expect(first.done).toBe(false);
  expect(first.value?.type).toBe("turn_started");

  // Wait for the thread_started event to propagate through subscribe
  // (it's a session-level event, not forwarded to the foreground stream)
  await vi.waitFor(() => {
    const active = manager.getAgent(snapshot.id);
    expect(active?.persistence?.sessionId).toBe("delayed-session-1");
  });

  const active = manager.getAgent(snapshot.id);
  expect(active?.lifecycle).toBe("running");

  const reloaded = await manager.reloadAgentSession(snapshot.id, {
    systemPrompt: "voice mode on",
  });

  expect(client.createSessionCalls).toBe(1);
  expect(client.resumeSessionCalls).toBe(1);
  expect(reloaded.persistence?.sessionId).toBe("delayed-session-1");

  // Drain stream after cancellation to ensure clean shutdown.
  while (true) {
    const next = await stream.next();
    if (next.done) {
      break;
    }
  }
});

test("fetchTimeline returns a bounded reset window when cursor epoch is stale", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-stale-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000118",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "one",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "two",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "three",
  });

  const baseline = manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 2,
  });
  expect(baseline.rows).toHaveLength(2);

  const result = manager.fetchTimeline(snapshot.id, {
    direction: "after",
    cursor: {
      epoch: "stale-epoch",
      seq: baseline.rows[baseline.rows.length - 1].seq,
    },
    limit: 1,
  });

  expect(result.reset).toBe(true);
  expect(result.staleCursor).toBe(true);
  expect(result.gap).toBe(false);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.seq).toBe(3);
  expect(result.rows[result.rows.length - 1]?.seq).toBe(3);
  expect(result.hasOlder).toBe(true);

  const older = manager.fetchTimeline(snapshot.id, {
    direction: "before",
    cursor: {
      epoch: result.epoch,
      seq: result.rows[0]?.seq ?? 0,
    },
    limit: 1,
  });

  expect(older.reset).toBe(false);
  expect(older.rows).toHaveLength(1);
  expect(older.rows[0]?.seq).toBe(2);
  expect(older.hasOlder).toBe(true);
});

test("getTimelineRows falls back to the in-memory timeline when no durable store is configured", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-rows-fallback-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000140",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "row one",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "row two",
  });

  await expect(manager.getTimelineRows(snapshot.id)).resolves.toEqual([
    {
      seq: 1,
      timestamp: expect.any(String),
      item: {
        type: "assistant_message",
        text: "row one",
      },
    },
    {
      seq: 2,
      timestamp: expect.any(String),
      item: {
        type: "assistant_message",
        text: "row two",
      },
    },
  ]);
});

test("getAgent does not expose committed history internals once manager owns the seam", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-boundary-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000138",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "user_message",
    text: "hello boundary",
    messageId: "msg-boundary-1",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "history stays behind manager",
  });

  const live = manager.getAgent(snapshot.id) as Record<string, unknown>;
  expect(live).not.toBeNull();
  expect("timeline" in live).toBe(false);
  expect("timelineRows" in live).toBe(false);
  expect("timelineNextSeq" in live).toBe(false);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "user_message",
      text: "hello boundary",
      messageId: "msg-boundary-1",
    },
    {
      type: "assistant_message",
      text: "history stays behind manager",
    },
  ]);

  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows.map((row) => row.seq)).toEqual([1, 2]);
});

test("coalesces assistant chunks and persists the canonical row", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provisional-timeline-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new StreamingAssistantClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000120",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const streamEvents: Array<{
    seq?: number;
    epoch?: string;
    eventType?: string;
    itemType?: string;
    text?: string;
  }> = [];
  manager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") {
        return;
      }
      streamEvents.push({
        seq: event.seq,
        epoch: event.epoch,
        eventType: event.event.type,
        itemType: event.event.type === "timeline" ? event.event.item.type : undefined,
        text:
          event.event.type === "timeline" && event.event.item.type === "assistant_message"
            ? event.event.item.text
            : undefined,
      });
    },
    { agentId: snapshot.id, replayState: false },
  );

  const stream = manager.streamAgent(snapshot.id, "hello");
  while (true) {
    const next = await stream.next();
    if (next.done) {
      break;
    }
  }

  const assistantTimelineEvents = streamEvents.filter(
    (event) => event.itemType === "assistant_message",
  );
  expect(assistantTimelineEvents).toHaveLength(1);
  expect(assistantTimelineEvents[0]).toMatchObject({
    eventType: "timeline",
    itemType: "assistant_message",
    text: "final reply",
    seq: 1,
    epoch: expect.any(String),
  });

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "assistant_message",
      text: "final reply",
    },
  ]);
  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows).toHaveLength(1);
  expect(assistantTimelineEvents[0]?.epoch).toBe(fetched.epoch);
  expect(fetched.rows[0]?.item).toEqual({
    type: "assistant_message",
    text: "final reply",
  });
});

test("fetchTimeline supports older-history pagination with before seq", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-before-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000119",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "first",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "second",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "third",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "fourth",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "fifth",
  });

  const result = await manager.fetchTimeline(snapshot.id, {
    direction: "before",
    cursor: {
      seq: 5,
    },
    limit: 2,
  });

  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]?.seq).toBe(3);
  expect(result.rows[1]?.seq).toBe(4);
  expect(result.hasOlder).toBe(true);
  expect(result.hasNewer).toBe(true);
});

test("does not trim committed history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-unbounded-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000120",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "first",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "second",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "third",
  });

  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows).toHaveLength(3);
  expect(fetched.window.minSeq).toBe(1);
  expect(fetched.window.maxSeq).toBe(3);
});

test("hydrateTimeline preserves assistant chunk, reasoning, and tool timeline history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-canonical-assistant-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ChunkedAssistantHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "chunk one " },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "chunk two" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "reasoning", text: "internal" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: {
          type: "tool_call",
          callId: "call-history-1",
          name: "shell",
          status: "completed",
          detail: {
            type: "shell",
            command: "echo hi",
            output: "hi\n",
            exitCode: 0,
          },
          error: null,
        },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "final answer" },
      };
    }
  }

  class ChunkedAssistantHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ChunkedAssistantHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ChunkedAssistantHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000121",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    { type: "assistant_message", text: "chunk one " },
    { type: "assistant_message", text: "chunk two" },
    { type: "reasoning", text: "internal" },
    {
      type: "tool_call",
      callId: "call-history-1",
      name: "shell",
      status: "completed",
      detail: {
        type: "shell",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
      },
      error: null,
    },
    { type: "assistant_message", text: "final answer" },
  ]);
});

test("hydrateTimeline preserves reasoning between assistant chunks", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-reasoning-interleave-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ReasoningInterleavedHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "before reasoning " },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "reasoning", text: "internal step" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "after reasoning" },
      };
    }
  }

  class ReasoningInterleavedHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ReasoningInterleavedHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ReasoningInterleavedHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000122",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "assistant_message",
      text: "before reasoning ",
    },
    { type: "reasoning", text: "internal step" },
    { type: "assistant_message", text: "after reasoning" },
  ]);
});

test("createAgent fails when generated agent ID is not a UUID", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "not-a-uuid",
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("createAgent: agentId must be a UUID");
});

test("createAgent fails when explicit agent ID is not a UUID", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      "not-a-uuid",
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("createAgent: agentId must be a UUID");
});

test("createAgent persists provided title before returning", async () => {
  const agentId = "00000000-0000-4000-8000-000000000102";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.id).toBe(agentId);
  expect(snapshot.lifecycle).toBe("idle");

  const persisted = await storage.get(agentId);
  expect(persisted?.title).toBe("Fix Login Bug");
  expect(persisted?.id).toBe(agentId);
});

test("createAgent populates runtimeInfo after session creation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.2-codex",
      modeId: "full-access",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.runtimeInfo).toBeDefined();
  expect(snapshot.runtimeInfo?.model).toBe("gpt-5.2-codex");
  expect(snapshot.runtimeInfo?.sessionId).toBe(snapshot.persistence?.sessionId);
});

test("runAgent refreshes runtimeInfo after completion", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.runtimeInfo?.model).toBe("gpt-5.4");

  await manager.runAgent(snapshot.id, "hello");

  const refreshed = manager.getAgent(snapshot.id);
  expect(refreshed?.runtimeInfo?.model).toBe("gpt-5.2-codex");
});

test("waitForAgentEvent does not resolve idle until foreground turn is finalized", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-wait-coherence-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const releaseTurnCompleted = deferred<void>();

  class SlowTerminalSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      this.interrupted = false;
      const turnId = `turn-${++this.turnIdCounter}`;
      void (async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        await releaseTurnCompleted.promise;
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      })();
      return { turnId };
    }
  }

  class SlowTerminalClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new SlowTerminalSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new SlowTerminalClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000124",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const stream = manager.streamAgent(snapshot.id, "hello");
  const consumePromise = (async () => {
    for await (const _event of stream) {
      // Drain events so manager lifecycle progresses naturally.
    }
  })();

  // Wait for the turn to start
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const waitPromise = manager.waitForAgentEvent(snapshot.id);

  // Should still be pending because turn_completed hasn't arrived
  const earlyResolution = await Promise.race([
    waitPromise.then(() => "resolved"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(earlyResolution).toBe("pending");

  // Release the turn_completed event
  releaseTurnCompleted.resolve();
  const waited = await waitPromise;
  expect(waited.status).toBe("idle");

  await consumePromise;
});

test("waitForAgentRunStart resolves while a foreground run is still only pending", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-fast-start-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000124",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const run = manager.streamAgent(snapshot.id, "fast");
  const drainRun = (async () => {
    for await (const _event of run) {
      // Drain the fast foreground turn.
    }
  })();

  await expect(manager.waitForAgentRunStart(snapshot.id)).resolves.toBeUndefined();

  await drainRun;
  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
});

test("replaceAgentRun does not emit idle or resolve waiters between interrupted and replacement runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-replace-run-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const allowFirstRunToEnd = deferred<void>();
  const allowSecondRunToEnd = deferred<void>();

  class ReplaceRunSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      this.interrupted = false;
      const turnId = `turn-${++this.turnIdCounter}`;
      const turnNum = this.turnIdCounter;

      void (async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        if (turnNum === 1) {
          await allowFirstRunToEnd.promise;
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "interrupted",
            turnId,
          });
        } else {
          await allowSecondRunToEnd.promise;
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }
      })();
      return { turnId };
    }

    override async interrupt(): Promise<void> {
      this.interrupted = true;
      allowFirstRunToEnd.resolve();
    }
  }

  class ReplaceRunClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ReplaceRunSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ReplaceRunClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000125",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const lifecycleUpdates: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
        return;
      }
      lifecycleUpdates.push(event.agent.lifecycle);
    },
    { agentId: snapshot.id, replayState: false },
  );

  const firstRun = manager.streamAgent(snapshot.id, "first run");
  const firstRunDrain = (async () => {
    for await (const _event of firstRun) {
      // Drain events so lifecycle updates are applied.
    }
  })();

  await manager.waitForAgentRunStart(snapshot.id);

  const waitPromise = manager.waitForAgentEvent(snapshot.id);
  const secondRun = await manager.replaceAgentRun(snapshot.id, "second run");
  const secondRunDrain = (async () => {
    for await (const _event of secondRun) {
      // Drain replacement run.
    }
  })();

  await manager.waitForAgentRunStart(snapshot.id);

  const prematureResolution = await Promise.race([
    waitPromise.then(() => "resolved"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(prematureResolution).toBe("pending");

  const runningIndexes = lifecycleUpdates.reduce<number[]>((indexes, status, index) => {
    if (status === "running") {
      indexes.push(index);
    }
    return indexes;
  }, []);
  expect(runningIndexes.length).toBeGreaterThanOrEqual(2);

  const firstReplacementRunningIndex = runningIndexes[1];
  expect(lifecycleUpdates.slice(0, firstReplacementRunningIndex).includes("idle")).toBe(false);

  allowSecondRunToEnd.resolve();

  const waited = await waitPromise;
  expect(waited.status).toBe("idle");

  await firstRunDrain;
  await secondRunDrain;
  unsubscribe();
});

test("replaceAgentRun stays running when a stale old terminal arrives before the replacement turn is current", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-replace-stale-terminal-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const secondStartEntered = deferred<void>();
  const interruptStarted = deferred<void>();
  const allowInterruptToFinish = deferred<void>();
  const allowSecondStartToResolve = deferred<void>();
  let capturedSession: StaleReplacementSession | null = null;

  class StaleReplacementSession extends TestAgentSession {
    private localTurnCounter = 0;

    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = `turn-${++this.localTurnCounter}`;
      const turnNum = this.localTurnCounter;

      if (turnNum === 1) {
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }

      secondStartEntered.resolve();
      await allowSecondStartToResolve.promise;
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }

    override async interrupt(): Promise<void> {
      interruptStarted.resolve();
      await allowInterruptToFinish.promise;
      this.pushEvent({
        type: "turn_canceled",
        provider: this.provider,
        reason: "Interrupted",
        turnId: "turn-1",
      });
    }
  }

  class StaleReplacementClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      capturedSession = new StaleReplacementSession(config);
      return capturedSession;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new StaleReplacementClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000126",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const stateUpdates: Array<{ lifecycle: string; updatedAt: number }> = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
        return;
      }
      stateUpdates.push({
        lifecycle: event.agent.lifecycle,
        updatedAt: event.agent.updatedAt.getTime(),
      });
    },
    { agentId: snapshot.id, replayState: false },
  );

  const firstRun = manager.streamAgent(snapshot.id, "first run");
  const firstRunDrain = (async () => {
    for await (const _event of firstRun) {
      // Drain events so lifecycle updates are applied.
    }
  })();

  await manager.waitForAgentRunStart(snapshot.id);

  const replaceUpdatesStart = stateUpdates.length;
  const beforeReplaceUpdatedAt = manager.getAgent(snapshot.id)?.updatedAt.getTime() ?? 0;
  const secondRunPromise = manager.replaceAgentRun(snapshot.id, "replacement run");

  await interruptStarted.promise;
  const replacementUpdates = stateUpdates.slice(replaceUpdatesStart);
  expect(
    replacementUpdates.some(
      (update) => update.lifecycle === "running" && update.updatedAt > beforeReplaceUpdatedAt,
    ),
  ).toBe(true);
  expect(replacementUpdates.map((update) => update.lifecycle)).not.toContain("idle");
  allowInterruptToFinish.resolve();

  const secondRun = await secondRunPromise;
  const secondRunDrain = (async () => {
    for await (const _event of secondRun) {
      // Drain replacement run.
    }
  })();
  await secondStartEntered.promise;

  const replaceGapSnapshot = manager.getAgent(snapshot.id) as
    | {
        pendingReplacement: boolean;
        activeForegroundTurnId: string | null;
        lifecycle: string;
      }
    | undefined;
  expect(replaceGapSnapshot?.pendingReplacement).toBe(true);
  expect(replaceGapSnapshot?.activeForegroundTurnId).toBeNull();
  expect(replaceGapSnapshot?.lifecycle).toBe("running");

  const replacementStart = manager.waitForAgentRunStart(snapshot.id);
  const prematureStart = await Promise.race([
    replacementStart.then(() => "resolved"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(prematureStart).toBe("pending");

  capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("running");
  expect(stateUpdates.at(-1)?.lifecycle).toBe("running");
  expect(stateUpdates.slice(replaceUpdatesStart).map((update) => update.lifecycle)).not.toContain(
    "idle",
  );

  allowSecondStartToResolve.resolve();

  await replacementStart;
  await firstRunDrain;
  await secondRunDrain;
  unsubscribe();
});

test("applies live autonomous events and preserves usage omitted from completion", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-events-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  let capturedSession: TestAgentSession | null = null;

  class LiveEventClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      capturedSession = new TestAgentSession(config);
      return capturedSession;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new LiveEventClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000125",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const lifecycleUpdates: string[] = [];
  let sawRunningState = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === snapshot.id) {
        lifecycleUpdates.push(event.agent.lifecycle);
        if (event.agent.lifecycle === "running") {
          sawRunningState = true;
        }
        if (sawRunningState && event.agent.lifecycle === "idle") {
          resolveSettled();
        }
      }
    },
    { agentId: snapshot.id, replayState: false },
  );

  // Push autonomous events through the session's subscribe() callbacks
  const autonomousTurnId = "autonomous-turn-1";
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "usage_updated",
    provider: "codex",
    usage: {
      inputTokens: 10,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 175,
    },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "AUTONOMOUS_PUMP_MESSAGE" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  await settled;

  const updated = manager.getAgent(snapshot.id);
  expect(updated?.lifecycle).toBe("idle");
  expect(updated?.lastUsage).toEqual({
    inputTokens: 10,
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 175,
  });
  expect(manager.getTimeline(snapshot.id)).toContainEqual({
    type: "assistant_message",
    text: "AUTONOMOUS_PUMP_MESSAGE",
  });
  expect(lifecycleUpdates).toContain("running");
  expect(lifecycleUpdates).toContain("idle");
});

test("cancelAgentRun waits for an acknowledged autonomous interrupt to settle", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-cancel-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class LiveInterruptSession extends TestAgentSession {
    public interruptCount = 0;
    readonly interruptCalled = deferred<void>();

    override async interrupt(): Promise<void> {
      this.interruptCount += 1;
      this.interruptCalled.resolve(undefined);
    }
  }

  class LiveInterruptClient extends TestAgentClient {
    lastSession: LiveInterruptSession | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new LiveInterruptSession(config);
      this.lastSession = session;
      return session;
    }
  }

  const client = new LiveInterruptClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000129",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const capturedSession = client.lastSession!;

  await new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type !== "agent_state") {
          return;
        }
        if (event.agent.id !== snapshot.id) {
          return;
        }
        if (event.agent.lifecycle !== "running") {
          return;
        }
        unsubscribe();
        resolve();
      },
      { agentId: snapshot.id, replayState: false },
    );
    capturedSession.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "autonomous-cancel-1",
    });
  });

  const beforeCancel = manager.getAgent(snapshot.id);
  expect(beforeCancel?.lifecycle).toBe("running");
  expect(beforeCancel?.activeForegroundTurnId).toBeNull();

  let cancelSettled = false;
  const cancelPromise = manager.cancelAgentRun(snapshot.id).finally(() => {
    cancelSettled = true;
  });
  await capturedSession.interruptCalled.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(cancelSettled).toBe(false);
  expect(client.lastSession?.interruptCount).toBe(1);

  capturedSession.pushEvent({
    type: "turn_canceled",
    provider: "codex",
    turnId: "autonomous-cancel-1",
    reason: "interrupted",
  });

  await expect(cancelPromise).resolves.toEqual({ status: "settled" });
  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
});

test("failed replacement cancellation preserves an autonomous running state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-replace-rejected-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);

  class RejectingLiveInterruptSession extends TestAgentSession {
    override async interrupt(): Promise<void> {
      throw new Error("provider still owns the autonomous turn");
    }
  }

  class RejectingLiveInterruptClient extends TestAgentClient {
    readonly session = new RejectingLiveInterruptSession({
      provider: "codex",
      cwd: workdir,
    });

    override async createSession(): Promise<AgentSession> {
      return this.session;
    }
  }

  const client = new RejectingLiveInterruptClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    rescueTimeouts: { interruptSessionMs: 10 },
    idFactory: () => "00000000-0000-4000-8000-000000000130",
  });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const running = waitForAgentLifecycle(manager, agent.id, "running");

    client.session.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "autonomous-replace-1",
    });
    await running;

    await expect(manager.replaceAgentRun(agent.id, "replacement prompt")).rejects.toThrow(
      `Cannot replace agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
    expect(manager.getAgent(agent.id)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: null,
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("waitForAgentEvent waitForActive resolves for autonomous live-event run", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-wait-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  let capturedSession: TestAgentSession | null = null;

  class LiveEventClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new TestAgentSession(config);
      capturedSession = session;
      return session;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new LiveEventClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000126",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const autonomousTurnId = "autonomous-wait-1";
  const waitPromise = manager.waitForAgentEvent(snapshot.id, { waitForActive: true });
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

  const result = await waitPromise;
  expect(result.status).toBe("idle");
});

test("autonomous events arriving during foreground run are processed via subscribe", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-during-fg-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const releaseForeground = deferred<void>();

  let capturedSession: TestAgentSession | null = null;

  class ForegroundSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "fg-turn-1";
      setTimeout(async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        await releaseForeground.promise;
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class ForegroundClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new ForegroundSession(config);
      capturedSession = session;
      return session;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ForegroundClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000127",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const foreground = manager.streamAgent(snapshot.id, "foreground run");
  const foregroundResults = (async () => {
    const events: AgentStreamEvent[] = [];
    for await (const event of foreground) {
      events.push(event);
    }
    return events;
  })();

  // Wait for the foreground turn to start (lifecycle -> running)
  await new Promise<void>((resolve) => {
    const unsub = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === snapshot.id &&
          event.agent.lifecycle === "running"
        ) {
          unsub();
          resolve();
        }
      },
      { agentId: snapshot.id, replayState: true },
    );
  });

  // Push autonomous events while foreground is active
  const autonomousTurnId = "autonomous-during-fg-1";
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "AUTONOMOUS_DURING_FOREGROUND" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

  releaseForeground.resolve();
  const foregroundEvents = await foregroundResults;

  // Foreground stream should contain its own turn events but NOT autonomous events
  expect(foregroundEvents.some((event) => event.type === "turn_completed")).toBe(true);
  expect(
    foregroundEvents.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "assistant_message" &&
        event.item.text.includes("AUTONOMOUS_DURING_FOREGROUND"),
    ),
  ).toBe(false);

  // Autonomous timeline item should still be recorded in the agent timeline
  expect(manager.getTimeline(snapshot.id)).toContainEqual({
    type: "assistant_message",
    text: "AUTONOMOUS_DURING_FOREGROUND",
  });
});

test("subscribe error isolation: throwing subscriber does not break event flow", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-subscribe-isolation-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  let capturedSession: TestAgentSession | null = null;

  class IsolationClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new TestAgentSession(config);
      capturedSession = session;
      return session;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new IsolationClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000128",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const receivedEvents: string[] = [];
  const settled = new Promise<void>((resolve) => {
    manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === snapshot.id &&
          event.agent.lifecycle === "idle"
        ) {
          resolve();
        }
        if (event.type === "agent_stream" && event.agentId === snapshot.id) {
          receivedEvents.push(event.event.type);
        }
      },
      { agentId: snapshot.id, replayState: false },
    );
  });

  const autonomousTurnId = "autonomous-isolation-1";
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "EVENT_AFTER_ERROR" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

  await settled;

  expect(receivedEvents).toContain("turn_started");
  expect(receivedEvents).toContain("timeline");
  expect(receivedEvents).toContain("turn_completed");
  expect(manager.getTimeline(snapshot.id)).toContainEqual({
    type: "assistant_message",
    text: "EVENT_AFTER_ERROR",
  });
});

test("keeps updatedAt monotonic when user message and run start happen in the same millisecond", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000120",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
  try {
    await manager.appendTimelineItem(snapshot.id, { type: "user_message", text: "hello" });
    const afterMessage = manager.getAgent(snapshot.id);
    expect(afterMessage).toBeDefined();
    const messageUpdatedAt = afterMessage!.updatedAt.getTime();

    const stream = manager.streamAgent(snapshot.id, "hello");
    // Advance the generator so startTurn runs and lifecycle transitions to running
    await stream.next();
    const afterRunStart = manager.getAgent(snapshot.id);
    expect(afterRunStart).toBeDefined();
    expect(afterRunStart!.updatedAt.getTime()).toBeGreaterThan(messageUpdatedAt);

    // Drain the rest of the stream
    while (true) {
      const next = await stream.next();
      if (next.done) break;
    }
  } finally {
    nowSpy.mockRestore();
  }
});

test("runAgent assembles finalText from trailing assistant chunks", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const expectedFinalText =
    '```json\n{"message":"Reserve space for archive button in sidebar agent list"}\n```';

  class ChunkedAssistantSession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly id = randomUUID();
    private subs = new Set<(event: AgentStreamEvent) => void>();
    private turnCounter = 0;

    async run(): Promise<AgentRunResult> {
      return {
        sessionId: this.id,
        finalText: "",
        timeline: [],
      };
    }

    async startTurn(): Promise<{ turnId: string }> {
      const turnId = `chunked-turn-${++this.turnCounter}`;
      setTimeout(() => {
        for (const cb of this.subs) {
          cb({ type: "turn_started", provider: this.provider, turnId });
          cb({
            type: "timeline",
            provider: this.provider,
            item: {
              type: "assistant_message",
              text: '```json\n{"message":"Reserve space for archive button in side',
            },
            turnId,
          });
          cb({
            type: "timeline",
            provider: this.provider,
            item: {
              type: "assistant_message",
              text: 'bar agent list"}\n```',
            },
            turnId,
          });
          cb({ type: "turn_completed", provider: this.provider, turnId });
        }
      }, 0);
      return { turnId };
    }

    subscribe(callback: (event: AgentStreamEvent) => void): () => void {
      this.subs.add(callback);
      return () => {
        this.subs.delete(callback);
      };
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

    async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: null,
        modeId: null,
      };
    }

    async getAvailableModes() {
      return [];
    }

    async getCurrentMode() {
      return null;
    }

    async setMode(): Promise<void> {}

    getPendingPermissions() {
      return [];
    }

    async respondToPermission(): Promise<void> {}

    describePersistence() {
      return {
        provider: this.provider,
        sessionId: this.id,
      };
    }

    async interrupt(): Promise<void> {}

    async close(): Promise<void> {}
  }

  class ChunkedAssistantClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return new ChunkedAssistantSession();
    }

    async resumeSession(): Promise<AgentSession> {
      return new ChunkedAssistantSession();
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ChunkedAssistantClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000113",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const result = await manager.runAgent(snapshot.id, "generate commit message");
  expect(result.finalText).toBe(expectedFinalText);
});

test("listAgents excludes internal agents", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const generatedAgentIds = [
    "00000000-0000-4000-8000-000000000105",
    "00000000-0000-4000-8000-000000000106",
  ];
  let agentCounter = 0;
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
  });

  // Create a normal agent
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    },
    undefined,
    { workspaceId: undefined },
  );

  // Create an internal agent
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  const agents = manager.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0]?.config.title).toBe("Normal Agent");
});

test("getAgent returns internal agents by ID", async () => {
  const internalAgentId = "00000000-0000-4000-8000-000000000107";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => internalAgentId,
  });

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  const agent = manager.getAgent(internalAgentId);
  expect(agent).not.toBeNull();
  expect(agent?.internal).toBe(true);
});

test("subscribe does not emit state events for internal agents to global subscribers", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const generatedAgentIds = [
    "00000000-0000-4000-8000-000000000108",
    "00000000-0000-4000-8000-000000000109",
  ];
  let agentCounter = 0;
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
  });

  const receivedEvents: string[] = [];
  manager.subscribe((event) => {
    if (event.type === "agent_state") {
      receivedEvents.push(event.agent.id);
    }
  });

  // Create a normal agent - should emit
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    },
    undefined,
    { workspaceId: undefined },
  );

  // Create an internal agent - should NOT emit to global subscriber
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  // Should only have events from the normal agent
  expect(receivedEvents.filter((id) => id === generatedAgentIds[0]).length).toBeGreaterThan(0);
  expect(receivedEvents.filter((id) => id === generatedAgentIds[1]).length).toBe(0);
});

test("subscribe hides provider subagents of internal parents from global subscribers", async () => {
  const internalAgentId = "00000000-0000-4000-8000-000000000117";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-internal-provider-child-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const sessionHolder: { current: TestAgentSession | null } = { current: null };
  class InternalProviderChildClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      sessionHolder.current = new TestAgentSession(config);
      return sessionHolder.current;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new InternalProviderChildClient() },
    registry: storage,
    logger,
    idFactory: () => internalAgentId,
  });
  const globalEvents: AgentManagerEvent[] = [];
  const scopedEvents: AgentManagerEvent[] = [];
  manager.subscribe((event) => globalEvents.push(event), { replayState: false });
  await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Internal Agent", internal: true },
    undefined,
    { workspaceId: undefined },
  );
  manager.subscribe((event) => scopedEvents.push(event), {
    agentId: internalAgentId,
    replayState: false,
  });

  sessionHolder.current?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "hidden-child", title: "Hidden child", status: "running" },
  });
  await manager.flush();

  expect(globalEvents.filter((event) => event.type === "provider_subagent")).toEqual([]);
  expect(scopedEvents).toContainEqual(
    expect.objectContaining({
      type: "provider_subagent",
      event: expect.objectContaining({
        type: "upsert",
        subagent: expect.objectContaining({
          id: "hidden-child",
          parentAgentId: internalAgentId,
        }),
      }),
    }),
  );
  expect(() => manager.listProviderSubagents(internalAgentId)).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
  expect(() => manager.getProviderSubagent(internalAgentId, "hidden-child")).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
  expect(() => manager.fetchProviderSubagentTimeline(internalAgentId, "hidden-child")).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
});

test("membership version advances for user agents but ignores internal helper sessions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-membership-version-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentIds = ["00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000202"];
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
    idFactory: () => agentIds.shift()!,
  });
  const initialVersion = manager.getMembershipVersion();

  await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Internal Helper", internal: true },
    undefined,
    { workspaceId: undefined },
  );
  expect(manager.getMembershipVersion()).toBe(initialVersion);

  await manager.createAgent({ provider: "codex", cwd: workdir, title: "User Agent" }, undefined, {
    workspaceId: undefined,
  });
  expect(manager.getMembershipVersion()).toBe(initialVersion + 1);
});

test("subscribe emits state events for internal agents when subscribed by agentId", async () => {
  const internalAgentId = "00000000-0000-4000-8000-000000000110";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => internalAgentId,
  });

  const receivedEvents: string[] = [];
  // Subscribe specifically to the internal agent
  manager.subscribe(
    (event) => {
      if (event.type === "agent_state") {
        receivedEvents.push(event.agent.id);
      }
    },
    { agentId: internalAgentId, replayState: false },
  );

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  // Should receive events when subscribed by specific agentId
  expect(receivedEvents.filter((id) => id === internalAgentId).length).toBeGreaterThan(0);
});

test("subscribe fails when filter agentId is not a UUID", () => {
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    logger,
  });

  expect(() =>
    manager.subscribe(() => {}, {
      agentId: "invalid-agent-id",
    }),
  ).toThrow("subscribe: agentId must be a UUID");
});

test("onAgentAttention is not called for internal agents", async () => {
  const internalAgentId = "00000000-0000-4000-8000-000000000111";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const attentionCalls: string[] = [];
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => internalAgentId,
    onAgentAttention: ({ agentId }) => {
      attentionCalls.push(agentId);
    },
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  // Run and complete the agent (which normally triggers attention)
  await manager.runAgent(agent.id, "hello");

  // Should NOT have triggered attention callback for internal agent
  expect(attentionCalls).toHaveLength(0);
});

test("onAgentAttention is not called for delegated child agents", async () => {
  const childAgentId = "00000000-0000-4000-8000-000000000112";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const attentionCalls: string[] = [];
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => childAgentId,
    onAgentAttention: ({ agentId }) => {
      attentionCalls.push(agentId);
    },
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Delegated Child Agent",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: "parent-agent" }, workspaceId: undefined },
  );

  await manager.runAgent(agent.id, "hello");

  expect(attentionCalls).toEqual([]);
});

test("clearAgentAttention on errored agent stays cleared until a new error transition", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-attention-error-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class FailingSession extends TestAgentSession {
    private attempt = 0;

    override async startTurn(): Promise<{ turnId: string }> {
      this.attempt += 1;
      const attempt = this.attempt;
      const turnId = `fail-turn-${attempt}`;
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          error: `boom-${attempt}`,
          turnId,
        });
      }, 0);
      return { turnId };
    }
  }

  class FailingClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new FailingSession(config);
    }

    async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
      return new FailingSession({
        provider: "codex",
        cwd: config?.cwd ?? process.cwd(),
      });
    }
  }

  const attentionReasons: Array<"finished" | "error" | "permission"> = [];
  const manager = new AgentManager({
    clients: {
      codex: new FailingClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000130",
    onAgentAttention: ({ reason }) => {
      attentionReasons.push(reason);
    },
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Attention transition test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "fail once")).rejects.toThrow("boom-1");
  await manager.flush();

  const afterFirstFailure = manager.getAgent(agent.id);
  expect(afterFirstFailure?.lifecycle).toBe("error");
  expect(afterFirstFailure?.attention.requiresAttention).toBe(true);
  expect(afterFirstFailure?.attention).toMatchObject({
    requiresAttention: true,
    attentionReason: "error",
  });

  const persistedAfterFirstFailure = await storage.get(agent.id);
  expect(persistedAfterFirstFailure?.lastStatus).toBe("error");
  expect(persistedAfterFirstFailure?.requiresAttention).toBe(true);
  expect(persistedAfterFirstFailure?.attentionReason).toBe("error");

  await manager.clearAgentAttention(agent.id);
  manager.notifyAgentState(agent.id);
  await manager.flush();

  const afterClear = manager.getAgent(agent.id);
  expect(afterClear?.lifecycle).toBe("error");
  expect(afterClear?.attention).toEqual({ requiresAttention: false });

  const persistedAfterClear = await storage.get(agent.id);
  expect(persistedAfterClear?.lastStatus).toBe("error");
  expect(persistedAfterClear?.requiresAttention).toBe(false);
  expect(persistedAfterClear?.attentionReason).toBeNull();

  await expect(manager.runAgent(agent.id, "fail again")).rejects.toThrow("boom-2");
  await manager.flush();

  const afterSecondFailure = manager.getAgent(agent.id);
  expect(afterSecondFailure?.lifecycle).toBe("error");
  expect(afterSecondFailure?.attention).toMatchObject({
    requiresAttention: true,
    attentionReason: "error",
  });
  expect(attentionReasons).toEqual(["error", "error"]);

  const persistedAfterSecondFailure = await storage.get(agent.id);
  expect(persistedAfterSecondFailure?.lastStatus).toBe("error");
  expect(persistedAfterSecondFailure?.requiresAttention).toBe(true);
  expect(persistedAfterSecondFailure?.attentionReason).toBe("error");
});

test("streamAgent clears pending run when startTurn fails before a turn id exists", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-start-turn-failure-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class FailsOnceBeforeTurnSession extends TestAgentSession {
    private attempt = 0;

    override async startTurn(): Promise<{ turnId: string }> {
      this.attempt += 1;
      if (this.attempt === 1) {
        throw new Error("Invalid request: missing field `text`");
      }
      return super.startTurn();
    }
  }

  class FailsOnceClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly session = new FailsOnceBeforeTurnSession({
      provider: "codex",
      cwd: workdir,
    });

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return this.session;
    }

    async resumeSession(): Promise<AgentSession> {
      return this.session;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new FailsOnceClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000131",
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Start turn failure cleanup",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "fail before turn id")).rejects.toThrow(
    "Invalid request: missing field `text`",
  );

  await expect(manager.runAgent(agent.id, "second turn")).resolves.toEqual(
    expect.objectContaining({
      sessionId: expect.any(String),
      canceled: false,
    }),
  );
});

test("a pre-accept start failure preserves the prior accepted continuation progress", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-material-progress-rejection-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);

  class MaterialThenRejectSession extends TestAgentSession {
    private attempt = 0;

    override async startTurn(): Promise<{ turnId: string }> {
      this.attempt += 1;
      if (this.attempt === 2) {
        throw new Error("rejected before provider turn acceptance");
      }
      const turnId = "accepted-material-turn";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "tool_call",
            callId: "write-proof",
            name: "write",
            status: "completed",
            error: null,
            detail: { type: "write", filePath: "proof.txt", content: "material result" },
          },
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class MaterialThenRejectClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly session = new MaterialThenRejectSession({ provider: "codex", cwd: workdir });

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return this.session;
    }

    async resumeSession(): Promise<AgentSession> {
      return this.session;
    }
  }

  const manager = new AgentManager({
    clients: { codex: new MaterialThenRejectClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000132",
  });

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Material progress rejection" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.runAgent(agent.id, "accepted turn");
    const accepted = manager.getMaterialProgress(agent.id);
    expect(accepted).toMatchObject({
      state: "progressing",
      continuationBoundarySeq: 1,
      observedThroughSeq: 1,
      lastMaterialProgressKind: "write",
    });

    await expect(manager.runAgent(agent.id, "rejected turn")).rejects.toThrow(
      "rejected before provider turn acceptance",
    );
    const afterRejection = manager.getMaterialProgress(agent.id);
    expect(afterRejection).toMatchObject({
      state: accepted.state,
      timelineEpoch: accepted.timelineEpoch,
      continuationBoundarySeq: accepted.continuationBoundarySeq,
      completedCompactionsSinceMaterialProgress: accepted.completedCompactionsSinceMaterialProgress,
      lastMaterialProgressAt: accepted.lastMaterialProgressAt,
      lastMaterialProgressKind: accepted.lastMaterialProgressKind,
    });
    expect(afterRejection.observedThroughSeq).toBe(accepted.observedThroughSeq! + 1);

    await manager.flush();
    expect((await storage.get(agent.id))?.materialProgress).toMatchObject({
      timelineEpoch: afterRejection.timelineEpoch,
      continuationBoundarySeq: afterRejection.continuationBoundarySeq,
      observedThroughSeq: afterRejection.observedThroughSeq,
      lastMaterialProgressKind: "write",
    });
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("archiveAgent closes the runtime before committing the archived record", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000131",
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Archive target",
    },
    undefined,
    { workspaceId: undefined },
  );

  const lifecycles: string[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === agent.id) {
        lifecycles.push(event.agent.lifecycle);
      }
    },
    { agentId: agent.id, replayState: false },
  );

  const { archivedAt } = await manager.archiveAgent(agent.id);
  const stored = await storage.get(agent.id);

  expect(stored).toMatchObject({
    id: agent.id,
    archivedAt,
    lastStatus: "closed",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  });
  expect(
    Math.abs(new Date(stored!.updatedAt).getTime() - new Date(archivedAt).getTime()),
  ).toBeLessThanOrEqual(5);
  expect(lifecycles.slice(-2)).toEqual(["closed", "closed"]);
});

test("archiveAgent durably archives an otherwise-ephemeral internal agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-internal-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal archive target",
      internal: true,
    },
    undefined,
    { workspaceId: "workspace-internal" },
  );

  expect(await storage.get(agent.id)).toBeNull();

  const { archivedAt } = await manager.archiveAgent(agent.id);

  expect(await storage.get(agent.id)).toMatchObject({
    id: agent.id,
    workspaceId: "workspace-internal",
    internal: true,
    archivedAt,
  });
});

test("waits for an earlier workspace registration before checking ownership", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-release-pending-registration-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  const workspaceId = "wks_pending_registration";
  const finished = await manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000140",
    { workspaceId },
  );
  await manager.archiveAgent(finished.id);

  const heldClient = new HeldAgentCreationClient();
  manager.registerClient("codex", heldClient);
  const rivalCreation = manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000141",
    { workspaceId },
  );
  await heldClient.waitForCreationToStart();

  let released = false;
  const release = manager.releaseWorkspaceIfUnowned({
    workspaceId,
    finishedAgentId: finished.id,
    release: async () => {
      released = true;
    },
  });
  const laterCreation = manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000144",
    { workspaceId },
  );

  heldClient.finishCreating();

  const rival = await rivalCreation;
  await expect(laterCreation).rejects.toThrow(`Workspace ${workspaceId} is being released`);
  await expect(release).resolves.toBe(false);
  expect({ released, rivalWorkspaceId: rival.workspaceId }).toEqual({
    released: false,
    rivalWorkspaceId: workspaceId,
  });
  await manager.closeAgent(rival.id);
  rmSync(workdir, { recursive: true, force: true });
});

test("releases a workspace after an earlier registration fails", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-release-failed-registration-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const heldClient = new HeldAgentCreationClient();
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  const workspaceId = "wks_failed_registration";
  const finished = await manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000145",
    { workspaceId },
  );
  await manager.archiveAgent(finished.id);

  manager.registerClient("codex", heldClient);
  heldClient.creationFailure = new Error("provider creation failed");
  const rivalCreation = manager
    .createAgent({ provider: "codex", cwd: workdir }, "00000000-0000-4000-8000-000000000146", {
      workspaceId,
    })
    .catch((error: unknown) => error);
  await heldClient.waitForCreationToStart();

  let released = false;
  const release = manager.releaseWorkspaceIfUnowned({
    workspaceId,
    finishedAgentId: finished.id,
    release: async () => {
      released = true;
    },
  });
  heldClient.finishCreating();

  await expect(rivalCreation).resolves.toEqual(
    expect.objectContaining({ message: "provider creation failed" }),
  );
  await expect(release).resolves.toBe(true);
  expect({ released, agents: manager.listAgents() }).toEqual({ released: true, agents: [] });
  rmSync(workdir, { recursive: true, force: true });
});

test("rejects a workspace registration that starts during release", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-registration-during-release-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  const workspaceId = "wks_registration_during_release";
  const finished = await manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000142",
    { workspaceId },
  );
  await manager.archiveAgent(finished.id);

  const releaseStarted = deferred<void>();
  const releaseAllowed = deferred<void>();
  const release = manager.releaseWorkspaceIfUnowned({
    workspaceId,
    finishedAgentId: finished.id,
    release: async () => {
      releaseStarted.resolve();
      await releaseAllowed.promise;
    },
  });
  await releaseStarted.promise;

  const rivalCreation = manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000143",
    { workspaceId },
  );
  releaseAllowed.resolve();

  await expect(rivalCreation).rejects.toThrow(`Workspace ${workspaceId} is being released`);
  await expect(release).resolves.toBe(true);
  expect(manager.listAgents()).toEqual([]);
  rmSync(workdir, { recursive: true, force: true });
});

test("fires onAgentArchived for archived parent and cascaded children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-hook-cascade-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const archivedIds: string[] = [];
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  manager.setAgentArchivedCallback((agentId) => {
    archivedIds.push(agentId);
  });

  const liveParent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const liveChild = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Child" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: liveParent.id }, workspaceId: undefined },
  );

  await manager.archiveAgent(liveParent.id);
  expect([...archivedIds].sort()).toEqual([liveChild.id, liveParent.id].sort());
});

test("rejects a child registration after its parent is durably archived", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-late-child-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const membershipGate = new DestructiveMembershipGate();
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    membershipGate,
    logger,
  });
  const parent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Parent" },
    undefined,
    { workspaceId: "workspace-parent" },
  );
  let lateRegistrationError: unknown;
  manager.setAgentArchivedCallback(async (archivedAgentId) => {
    if (archivedAgentId !== parent.id) return;
    expect((await storage.get(parent.id))?.archivedAt).toEqual(expect.any(String));
    try {
      await manager.createAgent(
        { provider: "codex", cwd: workdir, title: "Late child" },
        undefined,
        {
          labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
          workspaceId: "workspace-child",
        },
      );
    } catch (error) {
      lateRegistrationError = error;
    }
  });

  await manager.archiveAgent(parent.id);

  expect(lateRegistrationError).toBeInstanceOf(DestructiveMembershipExcludedError);
  expect(manager.listAgents()).toEqual([]);
  expect(await storage.list()).toHaveLength(1);
});

test.each(["create", "resume"] as const)(
  "%s holds child membership through registration while parent archive waits",
  async (registrationKind) => {
    const workdir = mkdtempSync(join(tmpdir(), `agent-manager-${registrationKind}-archive-race-`));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const membershipGate = new DestructiveMembershipGate();
    const manager = new AgentManager({
      clients: { codex: new TestAgentClient() },
      registry: storage,
      membershipGate,
      logger,
    });
    const parentAgentId = "00000000-0000-4000-8000-000000000141";
    const childAgentId = "00000000-0000-4000-8000-000000000142";
    const parent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Parent" },
      parentAgentId,
      { workspaceId: "workspace-parent" },
    );

    const originalBeginMembershipMutation =
      membershipGate.beginMembershipMutation.bind(membershipGate);
    let childMembershipLeaseReleased = false;
    vi.spyOn(membershipGate, "beginMembershipMutation").mockImplementation((scope) => {
      const lease = originalBeginMembershipMutation(scope);
      if (!scope.agentIds?.includes(childAgentId)) return lease;
      return {
        release: () => {
          childMembershipLeaseReleased = true;
          lease.release();
        },
      };
    });

    const childRegistrationSuspended = deferred<void>();
    const continueChildRegistration = deferred<void>();
    const originalStorageGet = storage.get.bind(storage);
    let blockedChildRegistration = false;
    vi.spyOn(storage, "get").mockImplementation(async (agentId) => {
      if (agentId === childAgentId && !blockedChildRegistration) {
        blockedChildRegistration = true;
        childRegistrationSuspended.resolve();
        await continueChildRegistration.promise;
      }
      return originalStorageGet(agentId);
    });

    const parentArchiveAcquireStarted = deferred<void>();
    const originalAcquireDestructive = membershipGate.acquireDestructive.bind(membershipGate);
    let parentArchiveLeaseAcquired = false;
    vi.spyOn(membershipGate, "acquireDestructive").mockImplementation(async (scope) => {
      const targetsParent = scope.agentIds?.includes(parentAgentId) ?? false;
      if (targetsParent) parentArchiveAcquireStarted.resolve();
      const lease = await originalAcquireDestructive(scope);
      if (targetsParent) parentArchiveLeaseAcquired = true;
      return lease;
    });

    const labels = { [PARENT_AGENT_ID_LABEL]: parent.id };
    const childRegistration =
      registrationKind === "create"
        ? manager.createAgent({ provider: "codex", cwd: workdir, title: "Child" }, childAgentId, {
            labels,
            workspaceId: "workspace-child",
          })
        : manager.resumeAgentFromPersistence(
            {
              provider: "codex",
              sessionId: "child-resume-session",
              metadata: { provider: "codex", cwd: workdir },
            },
            { cwd: workdir, title: "Child" },
            childAgentId,
            { labels, workspaceId: "workspace-child" },
          );
    let parentArchive: Promise<{ archivedAt: string }> | undefined;

    try {
      await childRegistrationSuspended.promise;
      expect(manager.getAgent(childAgentId)).toBeNull();

      parentArchive = manager.archiveAgent(parent.id);
      await parentArchiveAcquireStarted.promise;

      expect(childMembershipLeaseReleased).toBe(false);
      expect(parentArchiveLeaseAcquired).toBe(false);

      continueChildRegistration.resolve();
      await childRegistration;
      await parentArchive;

      expect(childMembershipLeaseReleased).toBe(true);
      expect(parentArchiveLeaseAcquired).toBe(true);
      expect(manager.listAgents()).toEqual([]);
      expectArchivedAgentRecord(await storage.get(parentAgentId), "closed");
      expectArchivedAgentRecord(await storage.get(childAgentId), "closed");
    } finally {
      continueChildRegistration.resolve();
      await Promise.allSettled([childRegistration, ...(parentArchive ? [parentArchive] : [])]);
    }
  },
);

test.each([
  { registrationKind: "create" as const, cleanupFails: false },
  { registrationKind: "resume" as const, cleanupFails: true },
  { registrationKind: "import" as const, cleanupFails: false },
])(
  "$registrationKind restores durable state when registration fails after its first snapshot",
  async ({ registrationKind, cleanupFails }) => {
    const workdir = mkdtempSync(join(tmpdir(), `agent-manager-${registrationKind}-rollback-`));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const membershipGate = new DestructiveMembershipGate();
    const persistenceFailure = new Error("injected registration persistence failure");
    const cleanupFailure = cleanupFails
      ? new Error("injected registration session cleanup failure")
      : null;
    const sessions: RegistrationCleanupSession[] = [];
    const client = new (class extends TestAgentClient {
      private makeSession(config: AgentSessionConfig): RegistrationCleanupSession {
        const session = new RegistrationCleanupSession(config, cleanupFailure);
        sessions.push(session);
        return session;
      }

      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return this.makeSession(config);
      }

      override async resumeSession(
        _handle: AgentPersistenceHandle,
        config?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        return this.makeSession({
          provider: "codex",
          cwd: config?.cwd ?? workdir,
          ...config,
        });
      }

      override async importSession(input: ImportProviderSessionInput) {
        return {
          session: this.makeSession({ provider: "codex", cwd: workdir }),
          config: { provider: "codex" as const, cwd: workdir },
          persistence: { provider: "codex" as const, sessionId: input.providerHandleId },
          timeline: [],
        };
      }
    })();
    const agentId = "00000000-0000-4000-8000-000000000143";
    const manager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      membershipGate,
      idFactory: () => agentId,
      logger,
    });
    const priorRecord: StoredAgentRecord | null =
      registrationKind === "resume"
        ? {
            id: agentId,
            provider: "codex",
            cwd: workdir,
            workspaceId: "workspace-before-resume",
            createdAt: "2026-07-01T10:00:00.000Z",
            updatedAt: "2026-07-01T10:05:00.000Z",
            lastActivityAt: "2026-07-01T10:05:00.000Z",
            lastUserMessageAt: "2026-07-01T10:04:00.000Z",
            title: "Exact prior record",
            labels: { retained: "true" },
            lastStatus: "closed",
            lastModeId: "plan",
            config: { modeId: "plan", model: "gpt-5.4-mini" },
            persistence: {
              provider: "codex",
              sessionId: "prior-resume-session",
              metadata: { retained: true },
            },
          }
        : null;
    if (priorRecord) await storage.upsert(priorRecord);
    const capturedPrior = structuredClone(await storage.get(agentId));

    const originalApplySnapshot = storage.applySnapshot.bind(storage);
    let snapshotCalls = 0;
    const applySnapshotSpy = vi
      .spyOn(storage, "applySnapshot")
      .mockImplementation(async (agent, options) => {
        if (agent.id === agentId) {
          snapshotCalls += 1;
        }
        if (agent.id === agentId && snapshotCalls === 2) {
          expect(await storage.get(agentId)).not.toEqual(capturedPrior);
          expect(manager.getAgent(agentId)).not.toBeNull();
          throw persistenceFailure;
        }
        await originalApplySnapshot(agent, options);
      });
    const rollbackStarted = deferred<void>();
    const rollbackAllowed = deferred<void>();
    const originalRollbackRegistration = storage.rollbackRegistration.bind(storage);
    const rollbackSpy = vi
      .spyOn(storage, "rollbackRegistration")
      .mockImplementation(async (rollbackAgentId, previousRecord) => {
        rollbackStarted.resolve();
        await rollbackAllowed.promise;
        await originalRollbackRegistration(rollbackAgentId, previousRecord);
      });

    let registration: Promise<ManagedAgent> | null = null;
    let destructiveLease: Awaited<
      ReturnType<DestructiveMembershipGate["acquireDestructive"]>
    > | null = null;
    try {
      if (registrationKind === "create") {
        registration = manager.createAgent(
          { provider: "codex", cwd: workdir, title: "Failed registration" },
          agentId,
          { workspaceId: "workspace-registration-rollback" },
        );
      } else if (registrationKind === "resume") {
        registration = manager.resumeAgentFromPersistence(
          {
            provider: "codex",
            sessionId: "resume-registration-rollback",
            metadata: { provider: "codex", cwd: workdir },
          },
          { cwd: workdir, title: "Failed registration" },
          agentId,
          { workspaceId: "workspace-registration-rollback" },
        );
      } else {
        registration = manager.importProviderSession({
          provider: "codex",
          providerHandleId: "import-registration-rollback",
          cwd: workdir,
          workspaceId: "workspace-registration-rollback",
        });
      }

      await rollbackStarted.promise;
      let destructiveLeaseAcquired = false;
      const destructiveLeasePromise = membershipGate
        .acquireDestructive({ agentIds: [agentId] })
        .then((lease) => {
          destructiveLeaseAcquired = true;
          return lease;
        });
      await Promise.resolve();
      expect(destructiveLeaseAcquired).toBe(false);
      expect(() => membershipGate.beginMembershipMutation({ agentIds: [agentId] })).toThrow(
        DestructiveMembershipExcludedError,
      );

      rollbackAllowed.resolve();
      const rejection = await registration.then(
        () => null,
        (error: unknown) => error,
      );
      destructiveLease = await destructiveLeasePromise;

      expect(snapshotCalls).toBe(2);
      if (cleanupFailure) {
        expect(rejection).toBeInstanceOf(AggregateError);
        expect((rejection as AggregateError).errors).toEqual([persistenceFailure, cleanupFailure]);
      } else {
        expect(rejection).toBe(persistenceFailure);
      }
      expect(manager.getAgent(agentId)).toBeNull();
      expect(manager.getAgentCallerIdentity(agentId)).toBeNull();
      expect(manager.listAgents()).toEqual([]);
      expect(await storage.get(agentId)).toEqual(capturedPrior);
      expect(await storage.list()).toEqual(capturedPrior ? [capturedPrior] : []);
      const reloadedStorage = new AgentStorage(storagePath, logger);
      expect(await reloadedStorage.get(agentId)).toEqual(capturedPrior);
      expect(await reloadedStorage.list()).toEqual(capturedPrior ? [capturedPrior] : []);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.closeCalls).toBe(1);
      expect(sessions[0]?.activeSubscriptions).toBe(0);

      destructiveLease.release();
      destructiveLease = null;

      if (registrationKind === "create") {
        await expect(
          ensureAgentLoaded(agentId, {
            agentManager: manager,
            agentStorage: storage,
            logger,
          }),
        ).rejects.toThrow(`Agent not found: ${agentId}`);

        applySnapshotSpy.mockRestore();
        rollbackSpy.mockRestore();
        const retry = await manager.createAgent(
          { provider: "codex", cwd: workdir, title: "Same-ID retry" },
          agentId,
          { workspaceId: "workspace-registration-retry" },
        );
        expect(retry.id).toBe(agentId);
      }
    } finally {
      rollbackAllowed.resolve();
      await registration?.catch(() => undefined);
      destructiveLease?.release();
      applySnapshotSpy.mockRestore();
      rollbackSpy.mockRestore();
      await manager.closeAgent(agentId).catch(() => undefined);
      await storage.flush().catch(() => undefined);
      rmSync(workdir, { recursive: true, force: true });
    }
  },
);

test("registration reports storage rollback failure with the original snapshot failure", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-registration-rollback-error-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const membershipGate = new DestructiveMembershipGate();
  const persistenceFailure = new Error("injected second snapshot failure");
  const rollbackFailure = new Error("injected storage rollback failure");
  const session = new RegistrationCleanupSession({ provider: "codex", cwd: workdir });
  const client = new (class extends TestAgentClient {
    override async createSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    membershipGate,
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000144";
  const originalApplySnapshot = storage.applySnapshot.bind(storage);
  let snapshotCalls = 0;
  vi.spyOn(storage, "applySnapshot").mockImplementation(async (agent, options) => {
    if (agent.id === agentId) snapshotCalls += 1;
    if (agent.id === agentId && snapshotCalls === 2) {
      throw persistenceFailure;
    }
    await originalApplySnapshot(agent, options);
  });
  vi.spyOn(storage, "rollbackRegistration").mockRejectedValue(rollbackFailure);

  try {
    const rejection = await manager
      .createAgent({ provider: "codex", cwd: workdir }, agentId, {
        workspaceId: "workspace-registration-rollback-error",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([persistenceFailure, rollbackFailure]);
    expect(manager.getAgent(agentId)).toBeNull();
    expect(session.closeCalls).toBe(1);
    const destructiveLease = await membershipGate.acquireDestructive({ agentIds: [agentId] });
    destructiveLease.release();
  } finally {
    vi.restoreAllMocks();
    await storage.rollbackRegistration(agentId, null).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("fires onAgentArchived for stored-only snapshot archives", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-hook-snapshot-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const archivedIds: string[] = [];
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  manager.setAgentArchivedCallback((agentId) => {
    archivedIds.push(agentId);
  });

  const storedOnly = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored only",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(storedOnly.id);

  await manager.archiveSnapshot(storedOnly.id, new Date().toISOString());
  expect(archivedIds).toEqual([storedOnly.id]);
});

test("unarchiveSnapshot skips native provider unarchive for active records", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-unarchive-active-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Active unarchive target",
    },
    undefined,
    { workspaceId: undefined },
  );

  const unarchived = await manager.unarchiveSnapshot(agent.id);

  expect(unarchived).toBe(false);
  expect(client.unarchivedHandles).toEqual([]);
});

test("unarchiveSnapshot unarchives native provider storage before clearing archivedAt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive target",
    },
    undefined,
    {
      workspaceId: undefined,
      labels: { [PARENT_AGENT_ID_LABEL]: "archived-parent", retained: "yes" },
    },
  );
  await manager.archiveAgent(agent.id);
  client.readArchivedAtDuringUnarchive = async () => (await storage.get(agent.id))?.archivedAt;

  const unarchived = await manager.unarchiveSnapshot(agent.id, {
    workspaceId: "ws-restored",
    labels: { [PARENT_AGENT_ID_LABEL]: null, source: "reimport" },
  });
  const stored = await storage.get(agent.id);

  expect(unarchived).toBe(true);
  expect(client.archivedHandles).toHaveLength(1);
  expect(client.unarchivedHandles).toEqual(client.archivedHandles);
  expect(client.archivedAtDuringUnarchive).toEqual(expect.any(String));
  expect(stored?.archivedAt).toBeNull();
  expect(stored?.workspaceId).toBe("ws-restored");
  expect(stored?.labels).toEqual({ retained: "yes", source: "reimport" });
});

test("unarchiveSnapshotByHandle unarchives native provider storage for the matched snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-handle-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive by handle target",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.archiveAgent(agent.id);
  const archived = await storage.get(agent.id);
  if (!archived?.persistence) {
    throw new Error("expected archived snapshot to have persistence");
  }

  await manager.unarchiveSnapshotByHandle(archived.persistence);

  const stored = await storage.get(agent.id);
  expect(client.unarchivedHandles).toEqual(client.archivedHandles);
  expect(stored?.archivedAt).toBeNull();
});

test("unarchiveSnapshot keeps the stored record archived when native unarchive fails", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-failure-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive failure target",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.archiveAgent(agent.id);
  client.unarchiveFailure = new Error("provider still archived");

  await expect(manager.unarchiveSnapshot(agent.id)).rejects.toThrow("provider still archived");

  const stored = await storage.get(agent.id);
  expect(stored?.archivedAt).toEqual(expect.any(String));
  expect(client.unarchivedHandles).toHaveLength(1);
});

test("an earlier archived restore prevents workspace release", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-restore-before-release-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const workspaceId = "wks_restore_before_release";
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000147",
    { workspaceId },
  );
  await manager.archiveAgent(agent.id);
  client.holdNativeUnarchive();

  const restore = manager.unarchiveSnapshot(agent.id);
  await client.waitForNativeUnarchive();
  let released = false;
  const release = manager.releaseWorkspaceIfUnowned({
    workspaceId,
    finishedAgentId: agent.id,
    release: async () => {
      released = true;
    },
  });
  const laterRestore = manager.unarchiveSnapshot(agent.id);
  client.finishNativeUnarchive();

  await expect(laterRestore).rejects.toThrow(`Workspace ${workspaceId} is being released`);
  await expect(restore).resolves.toBe(true);
  await expect(release).resolves.toBe(false);
  expect({ released, archivedAt: (await storage.get(agent.id))?.archivedAt }).toEqual({
    released: false,
    archivedAt: null,
  });
  rmSync(workdir, { recursive: true, force: true });
});

test("a release-first archived restore cannot revive provider or persisted state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-release-before-restore-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const workspaceId = "wks_release_before_restore";
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir },
    "00000000-0000-4000-8000-000000000148",
    { workspaceId },
  );
  await manager.archiveAgent(agent.id);
  const releaseStarted = deferred<void>();
  const releaseAllowed = deferred<void>();

  const release = manager.releaseWorkspaceIfUnowned({
    workspaceId,
    finishedAgentId: agent.id,
    release: async () => {
      releaseStarted.resolve();
      await releaseAllowed.promise;
    },
  });
  await releaseStarted.promise;
  const priorNativeUnarchives = client.unarchivedHandles.length;
  const restore = manager.unarchiveSnapshot(agent.id);
  releaseAllowed.resolve();

  await expect(restore).rejects.toThrow(`Workspace ${workspaceId} is being released`);
  await expect(release).resolves.toBe(true);
  expect(client.unarchivedHandles).toHaveLength(priorNativeUnarchives);
  expect((await storage.get(agent.id))?.archivedAt).toEqual(expect.any(String));
  expect(manager.getAgent(agent.id)).toBeNull();
  rmSync(workdir, { recursive: true, force: true });
});

test("archiveAgent cascade archives in-memory children with the full archive contract", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-contract-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const unrelated = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Unrelated",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.archiveAgent(parent.id);

  const storedParent = await storage.get(parent.id);
  const storedChild = await storage.get(child.id);
  const storedUnrelated = await storage.get(unrelated.id);

  expectArchivedAgentRecord(storedParent, "closed");
  expectArchivedAgentRecord(storedChild, "closed");
  expect(storedUnrelated?.archivedAt).toBeUndefined();
});

test("archiveAgentCommand retries a child failure before committing the parent archive", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-retry-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const membershipGate = new DestructiveMembershipGate();
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    membershipGate,
    logger,
  });
  const parent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Parent" },
    undefined,
    { workspaceId: "workspace-parent" },
  );
  const child = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Child" },
    undefined,
    {
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      workspaceId: "workspace-child",
    },
  );
  const archivedCallbacks: string[] = [];
  manager.setAgentArchivedCallback((agentId) => {
    archivedCallbacks.push(agentId);
  });
  const childArchiveFailure = new Error("injected child archive failure");
  const originalArchiveAgent = manager.archiveAgent.bind(manager);
  let failChildArchive = true;
  vi.spyOn(manager, "archiveAgent").mockImplementation(async (agentId, recheck, cascadePlan) => {
    if (agentId === child.id && failChildArchive) {
      failChildArchive = false;
      throw childArchiveFailure;
    }
    return originalArchiveAgent(agentId, recheck, cascadePlan);
  });

  await expect(
    archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, parent.id, {
      caller: createCoordinatorDestructiveCaller(),
    }),
  ).rejects.toBe(childArchiveFailure);

  expect((await storage.get(parent.id))?.lastStatus).toBe("closed");
  expect((await storage.get(parent.id))?.archivedAt).toBeUndefined();
  expect((await storage.get(child.id))?.archivedAt).toBeUndefined();
  expect(manager.getAgent(parent.id)).toBeNull();
  expect(manager.getAgent(child.id)).not.toBeNull();
  expect(archivedCallbacks).toEqual([]);

  await archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, parent.id, {
    caller: createCoordinatorDestructiveCaller(),
  });

  expectArchivedAgentRecord(await storage.get(parent.id), "closed");
  expectArchivedAgentRecord(await storage.get(child.id), "closed");
  expect(manager.getAgent(child.id)).toBeNull();
  expect(archivedCallbacks).toEqual([child.id, parent.id]);
});

test.each([
  { mutation: "detach" as const, nextParentAgentId: undefined },
  { mutation: "update" as const, nextParentAgentId: "unrelated-parent" },
])(
  "archiveAgentCommand sees only the durable graph during a concurrent $mutation",
  async ({ mutation, nextParentAgentId }) => {
    const workdir = mkdtempSync(join(tmpdir(), `agent-manager-cascade-${mutation}-race-`));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: { codex: new TestAgentClient() },
      registry: storage,
      membershipGate: new DestructiveMembershipGate(),
      logger,
    });
    const root = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Root" },
      undefined,
      { workspaceId: "workspace-root" },
    );
    const middle = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Middle" },
      undefined,
      {
        labels: { [PARENT_AGENT_ID_LABEL]: root.id },
        workspaceId: "workspace-middle",
      },
    );
    const callerAgent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Caller" },
      undefined,
      {
        labels: { [PARENT_AGENT_ID_LABEL]: middle.id },
        workspaceId: "workspace-caller",
      },
    );
    const callerIdentity = manager.getAgentCallerIdentity(callerAgent.id);
    if (!callerIdentity) {
      throw new Error("expected caller identity");
    }

    const persistenceReached = deferred<void>();
    const releasePersistence = deferred<void>();
    const originalApplySnapshot = storage.applySnapshot.bind(storage);
    let holdMutationPersistence = true;
    vi.spyOn(storage, "applySnapshot").mockImplementation(async (agent, options) => {
      const parentAgentId = agent.labels?.[PARENT_AGENT_ID_LABEL];
      if (
        holdMutationPersistence &&
        agent.id === callerAgent.id &&
        parentAgentId === nextParentAgentId
      ) {
        holdMutationPersistence = false;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      await originalApplySnapshot(agent, options);
    });

    const mutationPromise =
      mutation === "detach"
        ? manager.detachAgent(callerAgent.id)
        : manager.updateAgentMetadata(callerAgent.id, {
            labels: { [PARENT_AGENT_ID_LABEL]: nextParentAgentId! },
          });
    await persistenceReached.promise;
    expect(manager.getAgent(callerAgent.id)?.labels[PARENT_AGENT_ID_LABEL]).toBe(middle.id);
    expect((await storage.get(callerAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(middle.id);

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, root.id, {
        caller: createAgentDestructiveCaller(callerIdentity),
      }),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });

    releasePersistence.resolve();
    await mutationPromise;
    await archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, root.id, {
      caller: createAgentDestructiveCaller(callerIdentity),
    });

    expectArchivedAgentRecord(await storage.get(root.id), "closed");
    expectArchivedAgentRecord(await storage.get(middle.id), "closed");
    expect((await storage.get(callerAgent.id))?.archivedAt).toBeUndefined();
    expect(manager.getAgent(callerAgent.id)?.labels[PARENT_AGENT_ID_LABEL]).toBe(nextParentAgentId);
  },
);

test("archiveAgent cascade closes a running child runtime", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-running-child-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const finishRun = deferred<void>();

  class RunningChildSession extends TestAgentSession {
    closeCalled = false;

    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "running-child-turn";
      void (async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        await finishRun.promise;
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      })();
      return { turnId };
    }

    override async close(): Promise<void> {
      this.closeCalled = true;
    }
  }

  class RunningChildClient extends TestAgentClient {
    readonly sessions: RunningChildSession[] = [];

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new RunningChildSession(config);
      this.sessions.push(session);
      return session;
    }
  }

  const client = new RunningChildClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Running Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const childSession = client.sessions[1];
  const childLifecycleEvents: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === child.id) {
        childLifecycleEvents.push(event.agent.lifecycle);
      }
    },
    { agentId: child.id, replayState: false },
  );
  const childRun = manager.streamAgent(child.id, "keep running");
  const drainChildRun = (async () => {
    for await (const _event of childRun) {
      // Drain the foreground turn while archive closes it.
    }
  })();

  await manager.waitForAgentRunStart(child.id);

  await manager.archiveAgent(parent.id);
  finishRun.resolve();
  await drainChildRun;
  unsubscribe();

  expect(childSession?.closeCalled).toBe(true);
  expect(manager.getAgent(child.id)).toBeNull();
  expect(childLifecycleEvents).toContain("closed");
});

test("archiveAgent cascade archives off-memory children with the full archive contract", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-off-memory-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Off-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const managerInternals = manager as unknown as {
    agents: Map<string, unknown>;
  };
  managerInternals.agents.delete(child.id);

  await manager.archiveAgent(parent.id);

  expectArchivedAgentRecord(await storage.get(child.id), "idle");
});

test("archiveAgent cascade notifies subscribers for in-memory and off-memory children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-notifications-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const inMemoryChild = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "In-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const offMemoryChild = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Off-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const managerInternals = manager as unknown as {
    agents: Map<string, unknown>;
  };
  managerInternals.agents.delete(offMemoryChild.id);
  const cascadedChildEvents: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_state") {
        return;
      }
      if (event.agent.id === inMemoryChild.id || event.agent.id === offMemoryChild.id) {
        cascadedChildEvents.push(event.agent.id);
      }
    },
    { replayState: false },
  );

  await manager.archiveAgent(parent.id);
  unsubscribe();

  expect({
    inMemoryChildNotified: cascadedChildEvents.includes(inMemoryChild.id),
    offMemoryChildNotified: cascadedChildEvents.includes(offMemoryChild.id),
  }).toEqual({
    inMemoryChildNotified: true,
    offMemoryChildNotified: true,
  });
});

test("archiveAgent cascade surfaces partial child archive failures", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-partial-failure-"));
  const storagePath = join(workdir, "agents");
  let failingChildId: string | null = null;

  class FailingChildArchiveStorage extends AgentStorage {
    override async upsert(record: StoredAgentRecord): Promise<void> {
      if (record.id === failingChildId && record.archivedAt) {
        throw new Error(`Injected cascade archive failure for ${record.id}`);
      }
      await super.upsert(record);
    }
  }

  const storage = new FailingChildArchiveStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Failing Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  failingChildId = child.id;

  await expect(manager.archiveAgent(parent.id)).rejects.toThrow(
    `Injected cascade archive failure for ${child.id}`,
  );
});

test("turn_failed emits a system error assistant timeline message and keeps error lifecycle", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-turn-failed-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class TurnFailedSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-failed-1";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          error: "invalid model id",
          turnId,
        });
      }, 0);
      return { turnId };
    }
  }

  class TurnFailedClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new TurnFailedSession(config);
    }

    async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
      return new TurnFailedSession({
        provider: "codex",
        cwd: config?.cwd ?? process.cwd(),
      });
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new TurnFailedClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000131",
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Turn failed test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "hello")).rejects.toThrow("invalid model id");

  const snapshot = manager.getAgent(agent.id);
  expect(snapshot?.lifecycle).toBe("error");
  expect(snapshot?.lastError).toBe("invalid model id");

  const systemErrors = manager
    .getTimeline(agent.id)
    .filter(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message" && item.text.includes("[System Error]"),
    );
  expect(systemErrors).toHaveLength(1);
  expect(systemErrors[0]?.text).toContain("invalid model id");
});

test("turn_failed surfaces provider code and diagnostic in system error message", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-turn-failed-detail-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class DetailedFailureSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-detailed-fail-1";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          error: "Provider execution failed",
          code: "126",
          diagnostic: "No preset version installed for command claude",
          turnId,
        });
      }, 0);
      return { turnId };
    }
  }

  class DetailedFailureClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new DetailedFailureSession(config);
    }

    async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
      return new DetailedFailureSession({
        provider: "codex",
        cwd: config?.cwd ?? process.cwd(),
      });
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new DetailedFailureClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000132",
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Detailed failure test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "hello")).rejects.toThrow("Provider execution failed");

  expect(manager.getAgent(agent.id)?.lastError).toBe("Provider execution failed");

  const systemError = manager
    .getTimeline(agent.id)
    .find(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message" && item.text.includes("[System Error]"),
    );
  expect(systemError?.text).toContain("Provider execution failed");
  expect(systemError?.text).toContain("code: 126");
  expect(systemError?.text).toContain("No preset version installed for command claude");
});

test("permission request notifies once without forcing unread attention state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-attention-permission-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const releasePermissionResolution = deferred<void>();

  class PermissionSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-perm-1";
      setTimeout(async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "permission_requested",
          provider: this.provider,
          request: {
            id: "perm-1",
            provider: this.provider,
            kind: "tool",
            name: "Read file",
          },
          turnId,
        });
        await releasePermissionResolution.promise;
        this.pushEvent({
          type: "permission_resolved",
          provider: this.provider,
          requestId: "perm-1",
          resolution: { behavior: "allow" },
          turnId,
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class PermissionClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new PermissionSession(config);
    }

    async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
      return new PermissionSession({
        provider: "codex",
        cwd: config?.cwd ?? process.cwd(),
      });
    }
  }

  const attentionReasons: Array<"finished" | "error" | "permission"> = [];
  const manager = new AgentManager({
    clients: {
      codex: new PermissionClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000131",
    onAgentAttention: ({ reason }) => {
      attentionReasons.push(reason);
    },
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Permission transition test",
    },
    undefined,
    { workspaceId: undefined },
  );

  const stream = manager.streamAgent(agent.id, "permission flow");
  await stream.next(); // turn_started
  await stream.next(); // permission_requested

  const withPermissionPending = manager.getAgent(agent.id);
  expect(withPermissionPending?.pendingPermissions.size).toBe(1);
  expect(withPermissionPending?.attention).toEqual({ requiresAttention: false });

  // Release permission resolution and drain the rest of the stream
  releasePermissionResolution.resolve();
  while (!(await stream.next()).done) {
    // no-op
  }

  expect(attentionReasons).toContain("permission");
});

test("respondToPermission updates currentModeId after plan approval", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  // Create a session that simulates plan approval mode change
  let sessionMode = "plan";
  class PlanModeTestSession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly id = randomUUID();
    private subs = new Set<(event: AgentStreamEvent) => void>();
    private turnCounter = 0;

    async run(): Promise<AgentRunResult> {
      return { sessionId: this.id, finalText: "", timeline: [] };
    }

    async startTurn(): Promise<{ turnId: string }> {
      const turnId = `plan-turn-${++this.turnCounter}`;
      setTimeout(() => {
        for (const cb of this.subs) {
          cb({ type: "turn_started", provider: this.provider, turnId });
          cb({ type: "turn_completed", provider: this.provider, turnId });
        }
      }, 0);
      return { turnId };
    }

    subscribe(callback: (event: AgentStreamEvent) => void): () => void {
      this.subs.add(callback);
      return () => {
        this.subs.delete(callback);
      };
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

    async getRuntimeInfo() {
      return { provider: this.provider, sessionId: this.id, model: null, modeId: sessionMode };
    }

    async getAvailableModes() {
      return [
        { id: "plan", label: "Plan" },
        { id: "acceptEdits", label: "Accept Edits" },
      ];
    }

    async getCurrentMode() {
      return sessionMode;
    }

    async setMode(modeId: string): Promise<void> {
      sessionMode = modeId;
    }

    getPendingPermissions() {
      return [];
    }

    async respondToPermission(_requestId: string, response: { behavior: string }): Promise<void> {
      // Simulate what claude-agent.ts does: when plan permission is approved,
      // it calls setMode("acceptEdits") internally
      if (response.behavior === "allow") {
        sessionMode = "acceptEdits";
      }
    }

    describePersistence() {
      return { provider: this.provider, sessionId: this.id };
    }

    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  class PlanModeTestClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return new PlanModeTestSession();
    }

    async resumeSession(): Promise<AgentSession> {
      return new PlanModeTestSession();
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new PlanModeTestClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000112",
  });

  // Create agent in plan mode
  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.currentModeId).toBe("plan");

  // Simulate a pending plan permission request
  const agent = manager.getAgent(snapshot.id)!;
  const permissionRequest = {
    id: "perm-123",
    provider: "codex" as const,
    name: "ExitPlanMode",
    kind: "plan" as const,
    input: { plan: "Test plan" },
  };
  agent.pendingPermissions.set(permissionRequest.id, permissionRequest);

  // Approve the plan permission
  await manager.respondToPermission(snapshot.id, "perm-123", {
    behavior: "allow",
  });

  // The session's mode has changed to "acceptEdits" internally
  // The manager should have updated currentModeId to reflect this
  const updatedAgent = manager.getAgent(snapshot.id);
  expect(updatedAgent?.currentModeId).toBe("acceptEdits");

  await manager.flush();
  const persisted = await storage.get(snapshot.id);
  expect(persisted?.lastModeId).toBe("acceptEdits");
});

test("respondToPermission refreshes features and runtime info after provider-managed plan approval", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class RefreshingPermissionSession extends TestAgentSession {
    private featureState: AgentFeature[] = [
      createFeature({ id: "fast_mode", label: "Fast", value: true }),
      createFeature({ id: "plan_mode", label: "Plan", value: true }),
    ];
    private modeId = "auto";
    private pending = [
      {
        id: "perm-plan-1",
        provider: "codex" as const,
        name: "CodexPlanApproval",
        kind: "plan" as const,
        input: { plan: "- Implement the feature" },
      },
    ];

    get features(): AgentFeature[] {
      return this.featureState;
    }

    override async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: "gpt-5.4",
        modeId: this.modeId,
        extra: { collaborationMode: this.features[1]?.value ? "Plan" : "Code" },
      };
    }

    override async getCurrentMode() {
      return this.modeId;
    }

    override getPendingPermissions() {
      return this.pending;
    }

    override async respondToPermission(): Promise<void> {
      this.modeId = "auto";
      this.pending = [];
      this.featureState = [
        createFeature({ id: "fast_mode", label: "Fast", value: true }),
        createFeature({ id: "plan_mode", label: "Plan", value: false }),
      ];
    }
  }

  class RefreshingPermissionClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new RefreshingPermissionSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new RefreshingPermissionClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const agent = manager.getAgent(snapshot.id);
  if (!agent) {
    throw new Error("Expected managed agent");
  }
  agent.pendingPermissions.set("perm-plan-1", {
    id: "perm-plan-1",
    provider: "codex",
    name: "CodexPlanApproval",
    kind: "plan",
    input: { plan: "- Implement the feature" },
  });

  await manager.respondToPermission(snapshot.id, "perm-plan-1", {
    behavior: "allow",
    selectedActionId: "implement",
  });

  const updated = manager.getAgent(snapshot.id);
  expect(updated?.pendingPermissions.size).toBe(0);
  expect(updated?.features).toEqual([
    createFeature({ id: "fast_mode", label: "Fast", value: true }),
    createFeature({ id: "plan_mode", label: "Plan", value: false }),
  ]);
  expect(updated?.runtimeInfo).toMatchObject({
    model: "gpt-5.4",
    extra: { collaborationMode: "Code" },
  });

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.features).toEqual([
    createFeature({ id: "fast_mode", label: "Fast", value: true }),
    createFeature({ id: "plan_mode", label: "Plan", value: false }),
  ]);
});

test("respondToPermission emits refreshed state before permission_resolved", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-permission-order-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class OrderedPermissionSession extends TestAgentSession {
    private featureState: AgentFeature[] = [
      createFeature({ id: "fast_mode", label: "Fast", value: true }),
    ];
    private modeId = "plan";
    private pending = [
      {
        id: "perm-order-1",
        provider: "codex" as const,
        name: "ExitPlanMode",
        kind: "plan" as const,
        input: { plan: "- Do the work" },
      },
    ];

    get features(): AgentFeature[] {
      return this.featureState;
    }

    override async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: "gpt-5.4",
        modeId: this.modeId,
      };
    }

    override async getCurrentMode() {
      return this.modeId;
    }

    override getPendingPermissions() {
      return this.pending;
    }

    override async respondToPermission(): Promise<void> {
      this.pushEvent({
        type: "permission_resolved",
        provider: this.provider,
        requestId: "perm-order-1",
        resolution: { behavior: "allow" },
      });
      this.modeId = "acceptEdits";
      this.featureState = [createFeature({ id: "fast_mode", label: "Fast", value: false })];
      this.pending = [];
    }
  }

  class OrderedPermissionClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new OrderedPermissionSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new OrderedPermissionClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000134",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const seen: string[] = [];
  manager.subscribe((event) => {
    if ("agentId" in event && event.agentId !== snapshot.id) {
      return;
    }
    if (event.type === "agent_state" && event.agent.id === snapshot.id) {
      const fastMode = event.agent.features?.find((feature) => feature.id === "fast_mode");
      seen.push(
        `state:${event.agent.currentModeId}:${String(fastMode?.type === "toggle" ? fastMode.value : null)}`,
      );
      return;
    }
    if (event.type === "agent_stream" && event.event.type === "permission_resolved") {
      seen.push(`resolved:${event.event.requestId}`);
    }
  });

  await manager.respondToPermission(snapshot.id, "perm-order-1", {
    behavior: "allow",
  });

  const refreshedStateIndex = seen.findIndex((entry) => entry === "state:acceptEdits:false");
  const resolvedIndex = seen.findIndex((entry) => entry === "resolved:perm-order-1");
  expect(refreshedStateIndex).toBeGreaterThanOrEqual(0);
  expect(resolvedIndex).toBeGreaterThan(refreshedStateIndex);
});

test("a retired permission response cannot mutate a recreated agent with the same ID", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-retired-permission-"));
  const agentId = "00000000-0000-4000-8000-000000000224";
  const responseStarted = deferred<void>();
  const releaseResponse = deferred<void>();
  let sessionGeneration = 0;

  class RecordingPermissionStorage extends AgentStorage {
    recording = false;
    readonly appliedSessionIds: string[] = [];

    override async applySnapshot(
      agent: ManagedAgent,
      options?: Parameters<AgentStorage["applySnapshot"]>[1],
    ): Promise<void> {
      if (this.recording) {
        this.appliedSessionIds.push(agent.persistence?.sessionId ?? "missing");
      }
      await super.applySnapshot(agent, options);
    }
  }

  class GatedPermissionSession extends TestAgentSession {
    override async respondToPermission(): Promise<void> {
      responseStarted.resolve();
      await releaseResponse.promise;
    }
  }

  class IncarnationPermissionClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      sessionGeneration += 1;
      return sessionGeneration === 1
        ? new GatedPermissionSession(config)
        : new TestAgentSession(config);
    }
  }

  const storage = new RecordingPermissionStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new IncarnationPermissionClient() },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    const first = await manager.createAgent({ provider: "codex", cwd: workdir }, agentId, {
      workspaceId: undefined,
    });
    const firstSessionId = first.persistence?.sessionId;
    if (!firstSessionId) {
      throw new Error("Expected first permission session persistence");
    }
    manager.getAgent(first.id)?.pendingPermissions.set("permission-1", {
      id: "permission-1",
      provider: "codex",
      name: "write",
      kind: "tool",
      input: { path: "proof.txt" },
    });

    const response = manager.respondToPermission(first.id, "permission-1", {
      behavior: "allow",
    });
    await responseStarted.promise;

    await manager.closeAgent(first.id);
    const second = await manager.createAgent({ provider: "codex", cwd: workdir }, agentId, {
      workspaceId: undefined,
    });
    const secondSessionId = second.persistence?.sessionId;
    if (!secondSessionId) {
      throw new Error("Expected successor permission session persistence");
    }
    expect(secondSessionId).not.toBe(firstSessionId);
    await manager.flush();
    await storage.flush();

    const emitted: AgentManagerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => emitted.push(event), {
      agentId,
      replayState: false,
    });
    storage.recording = true;
    releaseResponse.resolve();
    await response;
    await manager.flush();
    await storage.flush();
    unsubscribe();

    expect(storage.appliedSessionIds).toEqual([]);
    expect(emitted).toEqual([]);
    expect(manager.getAgent(agentId)?.persistence?.sessionId).toBe(secondSessionId);
    await expect(storage.get(agentId)).resolves.toMatchObject({
      persistence: { sessionId: secondSessionId },
    });
  } finally {
    releaseResponse.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("close during in-flight stream does not clear persistence sessionId", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CloseRaceSession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly id = randomUUID();
    private threadId: string | null = this.id;
    private closed = false;
    private subscribers = new Set<(event: AgentStreamEvent) => void>();
    private turnIdCounter = 0;

    async run(): Promise<AgentRunResult> {
      return { sessionId: this.id, finalText: "", timeline: [] };
    }

    async startTurn(): Promise<{ turnId: string }> {
      const turnId = `turn-${++this.turnIdCounter}`;
      // Push turn_started, then block until closed
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        // The turn will be canceled when close() is called
      }, 0);
      return { turnId };
    }

    subscribe(callback: (event: AgentStreamEvent) => void): () => void {
      this.subscribers.add(callback);
      return () => {
        this.subscribers.delete(callback);
      };
    }

    private pushEvent(event: AgentStreamEvent): void {
      for (const cb of this.subscribers) {
        try {
          cb(event);
        } catch {
          /* isolation */
        }
      }
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

    async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.threadId,
        model: null,
        modeId: null,
      };
    }

    async getAvailableModes() {
      return [];
    }

    async getCurrentMode() {
      return null;
    }

    async setMode(): Promise<void> {}

    getPendingPermissions() {
      return [];
    }

    async respondToPermission(): Promise<void> {}

    describePersistence() {
      if (!this.threadId) {
        return null;
      }
      return { provider: this.provider, sessionId: this.threadId };
    }

    async interrupt(): Promise<void> {
      this.closed = true;
      // Push turn_canceled for any active turn
      if (this.turnIdCounter > 0) {
        this.pushEvent({
          type: "turn_canceled",
          provider: this.provider,
          reason: "interrupted",
          turnId: `turn-${this.turnIdCounter}`,
        });
      }
    }

    async close(): Promise<void> {
      this.closed = true;
      this.threadId = null;
      // Push turn_canceled for any active turn
      if (this.turnIdCounter > 0) {
        this.pushEvent({
          type: "turn_canceled",
          provider: this.provider,
          reason: "closed",
          turnId: `turn-${this.turnIdCounter}`,
        });
      }
    }
  }

  class CloseRaceClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return new CloseRaceSession();
    }

    async resumeSession(): Promise<AgentSession> {
      return new CloseRaceSession();
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new CloseRaceClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000113",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const stream = manager.streamAgent(snapshot.id, "hello");
  await stream.next();

  await manager.closeAgent(snapshot.id);

  // Drain stream finalizer path after close().
  while (true) {
    const next = await stream.next();
    if (next.done) {
      break;
    }
  }

  await manager.flush();
  await storage.flush();

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.persistence?.sessionId).toBe(snapshot.persistence?.sessionId);
});

test("closeAgent persists one final closed snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-no-persist-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const applySnapshotSpy = vi.spyOn(storage, "applySnapshot");
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000112",
  });

  try {
    const snapshot = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );

    await manager.flush();
    const persistCountBeforeClose = applySnapshotSpy.mock.calls.length;

    await manager.closeAgent(snapshot.id);
    await manager.flush();

    expect(applySnapshotSpy).toHaveBeenCalledTimes(persistCountBeforeClose + 1);
  } finally {
    applySnapshotSpy.mockRestore();
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("closeAgent does not commit its final snapshot after authority is revoked during session close", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-revoked-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  let sessionClosed = false;
  let postCloseRecheckCount = 0;
  const client = new (class extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const markClosed = () => {
        sessionClosed = true;
      };
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          markClosed();
        }
      })(config);
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000113",
  });

  try {
    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.flush();
    const beforeClose = await storage.get(snapshot.id);

    await expect(
      manager.closeAgent(snapshot.id, () => {
        if (sessionClosed) {
          postCloseRecheckCount += 1;
          if (postCloseRecheckCount === 4) {
            throw new Error("close authority revoked after final snapshot temporary write");
          }
        }
      }),
    ).rejects.toThrow("close authority revoked after final snapshot temporary write");

    expect((await storage.get(snapshot.id))?.lastStatus).toBe(beforeClose?.lastStatus);
    const reloaded = new AgentStorage(storagePath, logger);
    expect((await reloaded.get(snapshot.id))?.lastStatus).toBe(beforeClose?.lastStatus);
    expect((await reloaded.get(snapshot.id))?.lastStatus).not.toBe("closed");
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("idle agents remain resident until an explicit lifecycle action closes them", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-idle-residency-"));
  let closeCount = 0;
  let resumeCount = 0;
  const client = new (class extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const recordClose = () => {
        closeCount += 1;
      };
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          recordClose();
        }
      })(config);
    }

    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      resumeCount += 1;
      return super.resumeSession(handle, config, launchContext);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(closeCount).toBe(0);

    await manager.runAgent(agent.id, "Continue on the resident runtime");

    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(resumeCount).toBe(0);
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("archiving a closed parent still cascades to its managed children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-closed-parent-archive-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  try {
    const parent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Closed parent" },
      undefined,
      { workspaceId: undefined },
    );
    const child = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Managed child" },
      undefined,
      {
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
        workspaceId: undefined,
      },
    );

    await manager.closeAgent(parent.id);
    await manager.archiveSnapshot(parent.id, new Date().toISOString());

    expect((await storage.get(parent.id))?.archivedAt).toEqual(expect.any(String));
    expect((await storage.get(child.id))?.archivedAt).toEqual(expect.any(String));
    expect(manager.getAgent(child.id)).toBeNull();
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded does not resume an archived agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-load-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);
    await manager.archiveSnapshot(agent.id, new Date().toISOString());

    await expect(
      ensureUnarchivedAgentLoaded(agent.id, {
        agentManager: manager,
        agentStorage: storage,
        logger,
      }),
    ).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
  } finally {
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded closes a runtime archived while it resumes", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-resume-race-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const resumeStarted = deferred<void>();
  const resumeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      resumeStarted.resolve();
      await resumeAllowed.promise;
      return super.resumeSession(handle, config, launchContext);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);

    const load = ensureUnarchivedAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await resumeStarted.promise;
    await manager.archiveSnapshot(agent.id, new Date().toISOString());
    resumeAllowed.resolve();

    await expect(load).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect((await storage.get(agent.id))?.archivedAt).toEqual(expect.any(String));
  } finally {
    resumeAllowed.resolve();
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded fences an archived agent after joining a shared resume", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-shared-resume-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const resumeStarted = deferred<void>();
  const resumeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      resumeStarted.resolve();
      await resumeAllowed.promise;
      return super.resumeSession(handle, config, launchContext);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);

    const sharedLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await resumeStarted.promise;
    const protectedLoad = ensureUnarchivedAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await manager.archiveSnapshot(agent.id, new Date().toISOString());
    resumeAllowed.resolve();

    await sharedLoad;
    await expect(protectedLoad).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect((await storage.get(agent.id))?.archivedAt).toEqual(expect.any(String));
  } finally {
    resumeAllowed.resolve();
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a shared agent load upgrades provider history hydration to broadcast", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-shared-load-broadcast-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const historyStarted = deferred<void>();
  const historyAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
          historyStarted.resolve();
          await historyAllowed.promise;
          yield {
            type: "timeline",
            provider: "codex",
            item: { type: "assistant_message", text: "Recovered history" },
          };
        }
      })({ provider: "codex", cwd: config?.cwd ?? workdir });
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);
    await manager.deleteAgentState(agent.id);
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event), { agentId: agent.id, replayState: false });

    const quietLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await historyStarted.promise;
    const broadcastingLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      broadcastTimeline: true,
      logger,
    });
    historyAllowed.resolve();
    await Promise.all([quietLoad, broadcastingLoad]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_stream",
        agentId: agent.id,
        event: expect.objectContaining({
          type: "timeline",
          item: { type: "assistant_message", text: "Recovered history" },
        }),
      }),
    );
  } finally {
    historyAllowed.resolve();
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("explicit close cancels running provider subagents before resume", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-closed-provider-child-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new SessionRecordingAgentClient();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const parent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    client.sessions[0]!.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "provider-child-running",
        title: "Provider child",
        status: "running",
      },
    });
    client.sessions[0]!.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "provider-child-finishing",
        title: "Finishing provider child",
        status: "running",
      },
    });
    await manager.flush();

    client.sessions[0]!.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "provider-child-finishing",
        status: "completed",
      },
    });
    await manager.closeAgent(parent.id);
    await ensureAgentLoaded(parent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(manager.getProviderSubagent(parent.id, "provider-child-running")?.status).toBe(
      "canceled",
    );
    expect(manager.getProviderSubagent(parent.id, "provider-child-finishing")?.status).toBe(
      "completed",
    );
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("load waits for an in-flight explicit close and creates one resumed runtime", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-explicit-close-race-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const closeStarted = deferred<void>();
  const closeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    resumeCount = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          closeStarted.resolve();
          await closeAllowed.promise;
        }
      })(config);
    }

    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      this.resumeCount += 1;
      return super.resumeSession(handle, config);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const created = await manager.createAgent(
      { provider: "codex", cwd: workdir },
      "00000000-0000-4000-8000-000000000216",
      { workspaceId: undefined },
    );
    const close = manager.closeAgent(created.id);
    await closeStarted.promise;
    const loads = Promise.all([
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
    ]);

    expect(client.resumeCount).toBe(0);
    closeAllowed.resolve();
    const [first, second] = await loads;
    await close;

    expect(first.id).toBe(created.id);
    expect(second.id).toBe(created.id);
    expect(client.resumeCount).toBe(1);
  } finally {
    closeAllowed.resolve();
    await manager.closeAgent("00000000-0000-4000-8000-000000000216").catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("load joins a close that starts after its barrier but before runtime lookup", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-start-gap-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldReloadCloseClient();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000218";
  let closeTask: Promise<void> | null = null;

  try {
    await manager.createAgent({ provider: "codex", cwd: workdir }, agentId, {
      workspaceId: undefined,
    });
    const waitForAgentClose = manager.waitForAgentClose.bind(manager);
    vi.spyOn(manager, "waitForAgentClose")
      .mockImplementation(async (id) => waitForAgentClose(id))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => {
          closeTask = manager.closeAgent(agentId);
        });
      });

    let loadSettled = false;
    const load = ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    }).then((agent) => {
      loadSettled = true;
      return agent;
    });

    await client.waitForCloseToStart();
    await Promise.resolve();
    expect(loadSettled).toBe(false);
    expect(client.resumeCount).toBe(0);

    client.finishClosing();
    const resumed = await load;
    await closeTask;

    expect(resumed).toMatchObject({ id: agentId, lifecycle: "idle" });
    expect(client.originalSessionClosed).toBe(true);
    expect(client.resumeCount).toBe(1);
  } finally {
    client.finishClosing();
    await closeTask?.catch(() => undefined);
    await manager.closeAgent(agentId).catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("concurrent explicit closes tear down the runtime once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-concurrent-close-"));
  const closeStarted = deferred<void>();
  const closeAllowed = deferred<void>();
  let closeCount = 0;
  const client = new (class extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const recordClose = () => {
        closeCount += 1;
      };
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          recordClose();
          closeStarted.resolve();
          await closeAllowed.promise;
        }
      })(config);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const firstClose = manager.closeAgent(agent.id);
    await closeStarted.promise;
    const secondClose = manager.closeAgent(agent.id);

    closeAllowed.resolve();
    await Promise.all([firstClose, secondClose]);

    expect(closeCount).toBe(1);
  } finally {
    closeAllowed.resolve();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider close failure still persists and emits a resumable closed agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-failure-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new (class extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          throw new Error("provider cleanup failed");
        }
      })(config);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const created = await manager.createAgent(
      { provider: "codex", cwd: workdir },
      "00000000-0000-4000-8000-000000000217",
      { workspaceId: undefined },
    );
    const closed = waitForAgentLifecycle(manager, created.id, "closed");

    await expect(manager.closeAgent(created.id)).rejects.toThrow("provider cleanup failed");
    await closed;
    const stored = await storage.get(created.id);
    expect(stored).toMatchObject({ lastStatus: "closed" });
    expect(stored?.archivedAt).toBeFalsy();

    await expect(
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
    ).resolves.toMatchObject({ id: created.id, lifecycle: "idle" });
  } finally {
    await manager.closeAgent("00000000-0000-4000-8000-000000000217").catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("hydrateTimeline keeps provider user_message items when no canonical user history exists", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-keep-user-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class HistoryWithUserMessagesSession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "user_message", text: "hello from user", messageId: "msg_history_1" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "hi there" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "user_message", text: "second question", messageId: "msg_history_2" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "second answer" },
      };
    }
  }

  class HistoryUserMessageClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new HistoryWithUserMessagesSession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new HistoryUserMessageClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000203",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");
  const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
  expect(userMessages).toHaveLength(2);
  expect(assistantMessages).toHaveLength(2);
});

test("hydrateTimeline preserves provider replay timestamps and marks missing ones untrusted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-timestamps-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class TimestampedHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        timestamp: "2026-05-01T10:00:00.000Z",
        item: { type: "user_message", text: "hello", messageId: "msg_history_1" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "no original timestamp" },
      };
    }
  }

  class TimestampedHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new TimestampedHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new TimestampedHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000204",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);
  const timeline = manager.fetchTimeline(snapshot.id, { direction: "tail", limit: 0 }).rows;

  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toMatchObject({
    timestamp: "2026-05-01T10:00:00.000Z",
    item: { type: "user_message", text: "hello", messageId: "msg_history_1" },
  });
  expect(timeline[1]?.timestamp).toEqual(expect.any(String));
});

test("provider user_message is recorded from the live stream", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-no-prior-record-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  // Session whose live turn yields a user_message without prior canonical recording
  class UnexpectedUserMessageSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-unexpected-1";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        // Provider yields user_message (e.g., system continuation)
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "continuation prompt" },
          turnId,
        });
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "continuation reply" },
          turnId,
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class UnexpectedUserMsgClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    async isAvailable(): Promise<boolean> {
      return true;
    }
    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new UnexpectedUserMessageSession(config);
    }
    async resumeSession(): Promise<AgentSession> {
      throw new Error("unused");
    }
  }

  const manager = new AgentManager({
    clients: { codex: new UnexpectedUserMsgClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000401",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "do something" });

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  // Provider's user_message should be recorded (no canonical to dedup against)
  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("continuation prompt");
});

test("authoritative timeline includes provider-emitted submitted user prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-submitted-prompt-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class SubmittedUserMessageSession extends TestAgentSession {
    override async startTurn(
      prompt: AgentPromptInput,
      options?: AgentRunOptions,
    ): Promise<{ turnId: string }> {
      const turnId = "turn-submitted-user-message";
      const text = typeof prompt === "string" ? prompt : "";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "user_message",
            text,
            messageId: "provider-message-1",
            clientMessageId: options?.clientMessageId,
          },
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class SubmittedUserMessageClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new SubmittedUserMessageSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new SubmittedUserMessageClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000402",
  });

  try {
    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    await manager.runAgent(snapshot.id, "hello from composer", {
      clientMessageId: "msg-client-1",
    });

    const timeline = manager.fetchTimeline(snapshot.id, { direction: "tail", limit: 20 }).rows;
    expect(timeline.map((row) => row.item)).toContainEqual({
      type: "user_message",
      text: "hello from composer",
      messageId: "provider-message-1",
      clientMessageId: "msg-client-1",
    });
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("replaceAgentRun succeeds when foreground turn terminal event is never delivered", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-stale-fg-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const allowSecondRunToEnd = deferred<void>();

  // Session where the first foreground turn never emits a terminal event
  // (simulates the claude-agent pendingInterruptAbort suppression bug),
  // and interrupt() does not produce events either.
  class StaleForegroundSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      this.interrupted = false;
      const turnId = `turn-${++this.turnIdCounter}`;
      const turnNum = this.turnIdCounter;

      setTimeout(async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        if (turnNum === 1) {
          // First turn: emit turn_started but NEVER emit a terminal event.
          // This simulates the provider suppressing the result.
        } else {
          // Subsequent turns: complete normally
          await allowSecondRunToEnd.promise;
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }
      }, 0);
      return { turnId };
    }

    override async interrupt(): Promise<void> {
      this.interrupted = true;
      // No events produced — the terminal event was suppressed
    }
  }

  class StaleForegroundClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new StaleForegroundSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new StaleForegroundClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000500",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  // Start first foreground run — it will hang (no terminal event)
  const firstRun = manager.streamAgent(snapshot.id, "hanging prompt");
  const firstRunDrain = (async () => {
    for await (const _event of firstRun) {
      // Draining — will hang until force-cleaned
    }
  })();

  await manager.waitForAgentRunStart(snapshot.id);

  const beforeReplace = manager.getAgent(snapshot.id);
  expect(beforeReplace?.lifecycle).toBe("running");
  expect(beforeReplace?.activeForegroundTurnId).toBe("turn-1");

  // Replace the hung run. cancelAgentRun will time out after 2s because
  // no terminal event arrives. After the fix, it should force-clear the
  // stale foreground state so streamAgent can proceed.
  const secondRun = await manager.replaceAgentRun(snapshot.id, "replacement prompt");
  const collectedEvents: AgentStreamEvent[] = [];
  const secondRunDrain = (async () => {
    for await (const event of secondRun) {
      collectedEvents.push(event);
    }
  })();

  await manager.waitForAgentRunStart(snapshot.id);
  allowSecondRunToEnd.resolve();

  await secondRunDrain;
  await firstRunDrain;

  expect(collectedEvents.some((e) => e.type === "turn_completed")).toBe(true);
  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
  expect(manager.getAgent(snapshot.id)?.activeForegroundTurnId).toBeNull();
}, 10_000);

class RecordingPersistedAgentsClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  calls = 0;

  constructor(public readonly provider: AgentProvider) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    throw new Error(`unexpected createSession for ${this.provider}`);
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error(`unexpected resumeSession for ${this.provider}`);
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async listImportableSessions() {
    this.calls += 1;
    return [
      {
        providerHandleId: `${this.provider}-session`,
        cwd: "/tmp/recent",
        title: null,
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
        firstPromptPreview: null,
        lastPromptPreview: null,
      },
    ];
  }
}

test.each([
  [
    "disabled",
    "claude",
    "codex",
    {
      claude: { enabled: true, derivedFromProviderId: null },
      codex: { enabled: false, derivedFromProviderId: null },
    },
  ],
])(
  "listImportableSessions skips %s providers in fan-out",
  async (_reason, includedProvider, skippedProvider, providerDefinitions) => {
    const includedClient = new RecordingPersistedAgentsClient(includedProvider);
    const skippedClient = new RecordingPersistedAgentsClient(skippedProvider);
    const manager = new AgentManager({
      clients: { [includedProvider]: includedClient, [skippedProvider]: skippedClient },
      providerDefinitions,
      logger,
    });

    const result = await manager.listImportableSessions();

    expect(includedClient.calls).toBe(1);
    expect(skippedClient.calls).toBe(0);
    expect(result.map((d) => d.provider)).toEqual([includedProvider]);
  },
);

test("listImportableSessions includes derived providers that list persisted agents", async () => {
  const claudeClient = new RecordingPersistedAgentsClient("claude");
  const ompClient = new RecordingPersistedAgentsClient("omp");
  const manager = new AgentManager({
    clients: { claude: claudeClient, omp: ompClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      omp: { enabled: true, derivedFromProviderId: "pi" },
    },
    logger,
  });

  const result = await manager.listImportableSessions();

  expect(claudeClient.calls).toBe(1);
  expect(ompClient.calls).toBe(1);
  expect(result.map((d) => d.provider).sort()).toEqual(["claude", "omp"]);
});

test("listImportableSessions narrows to the providerFilter when supplied", async () => {
  const claudeClient = new RecordingPersistedAgentsClient("claude");
  const codexClient = new RecordingPersistedAgentsClient("codex");
  const manager = new AgentManager({
    clients: { claude: claudeClient, codex: codexClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      codex: { enabled: true, derivedFromProviderId: null },
    },
    logger,
  });

  const result = await manager.listImportableSessions({
    providerFilter: new Set(["claude"]),
  });

  expect(claudeClient.calls).toBe(1);
  expect(codexClient.calls).toBe(0);
  expect(result.map((d) => d.provider)).toEqual(["claude"]);
});

test("listImportableSessions skips providers that lack supportsSessionListing even when row listing is defined", async () => {
  const listableClient = new RecordingPersistedAgentsClient("claude");
  const nonListableClient = new RecordingPersistedAgentsClient("acp");
  // Override capabilities to remove session listing support
  Object.defineProperty(nonListableClient, "capabilities", {
    value: {
      ...TEST_CAPABILITIES,
      supportsSessionListing: false,
    },
  });

  const manager = new AgentManager({
    clients: { claude: listableClient, acp: nonListableClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      acp: { enabled: true, derivedFromProviderId: null },
    },
    logger,
  });

  const result = await manager.listImportableSessions();

  expect(listableClient.calls).toBe(1);
  expect(nonListableClient.calls).toBe(0);
  expect(result.map((d) => d.provider)).toEqual(["claude"]);
});

test("user_message events wrapping a paseo-system envelope are not added to the timeline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-envelope-live-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "user_message",
        text: formatSystemNotificationPrompt("child finished"),
      },
      { type: "user_message", text: "plain user message" },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000005a1",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "do something" });

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("plain user message");
});

test("user_message events wrapping a paseo-system envelope are not restored during history replay", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-envelope-history-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const codex = fakeCodexEmitting({
    historyItems: [
      {
        type: "user_message",
        text: formatSystemNotificationPrompt("schedule fired"),
        messageId: "msg_history_envelope",
      },
      {
        type: "user_message",
        text: "real user message",
        messageId: "msg_history_real",
      },
      { type: "assistant_message", text: "reply" },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000005a2",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id);

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("real user message");
});

test("commandMayHaveChangedExternalState matches remote-state commands", () => {
  // GitHub PR operations (remote, no local file changes)
  expect(commandMayHaveChangedExternalState("gh pr merge 123")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr close 123")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr create")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr edit 123")).toBe(true);
  expect(commandMayHaveChangedExternalState('gh pr comment 123 -b "lgtm"')).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr review 123 -a")).toBe(true);
  // Git remote operations (local refs unchanged)
  expect(commandMayHaveChangedExternalState("git push origin main")).toBe(true);
  expect(commandMayHaveChangedExternalState("git fetch origin")).toBe(true);
});

test("commandMayHaveChangedExternalState ignores local or read-only commands", () => {
  // Local git mutations — already caught by file watchers on .git/HEAD
  expect(commandMayHaveChangedExternalState("git commit -m 'hello'")).toBe(false);
  expect(commandMayHaveChangedExternalState("git checkout main")).toBe(false);
  expect(commandMayHaveChangedExternalState("git merge feature")).toBe(false);
  expect(commandMayHaveChangedExternalState("git rebase main")).toBe(false);
  expect(commandMayHaveChangedExternalState("git reset --hard HEAD~1")).toBe(false);
  // git pull includes a merge/rebase that changes local refs → watchers catch it
  expect(commandMayHaveChangedExternalState("git pull origin main")).toBe(false);
  // Read-only gh commands
  expect(commandMayHaveChangedExternalState("gh pr view 123")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh pr list")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh auth status")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh repo view")).toBe(false);
  // Miscellaneous local commands
  expect(commandMayHaveChangedExternalState("git status")).toBe(false);
  expect(commandMayHaveChangedExternalState("ls -la")).toBe(false);
  expect(commandMayHaveChangedExternalState("cat file.txt")).toBe(false);
  expect(commandMayHaveChangedExternalState("npm install")).toBe(false);
  expect(commandMayHaveChangedExternalState("npm publish")).toBe(false);
});

test("onWorkspaceStateMayHaveChanged is called when a completed shell tool call may have changed external state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        status: "completed",
        detail: { type: "shell", command: "gh pr merge 123 --squash" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "merge it" });

  expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledTimes(1);
  expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledWith({ cwd: workdir });
});

test("onWorkspaceStateMayHaveChanged is not called for non-shell tool calls", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "read",
        status: "completed",
        detail: { type: "read", filePath: "/tmp/foo.txt" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "read it" });

  expect(onWorkspaceStateMayHaveChanged).not.toHaveBeenCalled();
});

test("onWorkspaceStateMayHaveChanged is not called for running shell tool calls", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        status: "running",
        detail: { type: "shell", command: "gh pr merge 123 --squash" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "merge it" });

  expect(onWorkspaceStateMayHaveChanged).not.toHaveBeenCalled();
});

const MANAGED_WRITER_AGENT_IDS = [
  "00000000-0000-4000-8000-000000001001",
  "00000000-0000-4000-8000-000000001002",
  "00000000-0000-4000-8000-000000001003",
  "00000000-0000-4000-8000-000000001004",
] as const;

class ManagedWriterTestClient extends TestAgentClient {
  readonly sessions: TestAgentSession[] = [];
  createCalls = 0;
  importCalls = 0;
  private readonly firstCreateStarted = deferred<void>();
  private readonly firstCreateAllowed = deferred<void>();

  constructor(private readonly holdFirstCreate = false) {
    super();
  }

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createCalls += 1;
    if (this.createCalls === 1) {
      this.firstCreateStarted.resolve();
      if (this.holdFirstCreate) {
        await this.firstCreateAllowed.promise;
      }
    }
    const session = (await super.createSession(config)) as TestAgentSession;
    this.sessions.push(session);
    return session;
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    this.importCalls += 1;
    const session = new TestAgentSession(context.storedConfig);
    this.sessions.push(session);
    return {
      session,
      config: context.storedConfig,
      persistence: {
        provider: "codex" as const,
        sessionId: input.providerHandleId,
      },
      timeline: [],
    };
  }

  waitForFirstCreate(): Promise<void> {
    return this.firstCreateStarted.promise;
  }

  allowFirstCreate(): void {
    this.firstCreateAllowed.resolve();
  }
}

function createManagedWriterWorkspace(cwd: string): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_managed_writer",
    projectId: "prj_managed_writer",
    cwd,
    kind: "worktree",
    displayName: "managed-writer",
    worktreeRoot: cwd,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: join(cwd, "..", "main"),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
}

function createManagedWriterManager(input: {
  cwd: string;
  storage: AgentStorage;
  client: ManagedWriterTestClient;
  agentIds?: readonly string[];
}): AgentManager {
  const agentIds = [...(input.agentIds ?? MANAGED_WRITER_AGENT_IDS)];
  const workspace = createManagedWriterWorkspace(input.cwd);
  return new AgentManager({
    clients: { codex: input.client },
    registry: input.storage,
    workspaceRegistry: { list: async () => [workspace] },
    idFactory: () => {
      const agentId = agentIds.shift();
      if (!agentId) throw new Error("Managed writer test exhausted agent IDs");
      return agentId;
    },
    logger,
  });
}

function createManagedWriterAgent(manager: AgentManager, cwd: string): Promise<ManagedAgent> {
  return manager.createAgent({ provider: "codex", cwd }, undefined, {
    workspaceId: "wks_managed_writer",
  });
}

test("managed worktree writer fence serializes concurrent creates before provider launch", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-concurrent-"));
  try {
    const client = new ManagedWriterTestClient(true);
    const manager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(join(workdir, "agents"), logger),
      client,
    });

    const first = createManagedWriterAgent(manager, workdir);
    await client.waitForFirstCreate();
    const second = createManagedWriterAgent(manager, workdir);
    await Promise.resolve();
    expect(client.createCalls).toBe(1);

    client.allowFirstCreate();
    await first;
    await expect(second).rejects.toBeInstanceOf(ManagedWorktreeWriterConflictError);
    expect(client.createCalls).toBe(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence keeps an idle agent as owner", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-idle-"));
  try {
    const client = new ManagedWriterTestClient();
    const manager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(join(workdir, "agents"), logger),
      client,
    });
    const owner = await createManagedWriterAgent(manager, workdir);

    await expect(createManagedWriterAgent(manager, workdir)).rejects.toMatchObject({
      code: "managed_worktree_writer_conflict",
      ownerAgentId: owner.id,
      ownerWorkspaceId: "wks_managed_writer",
      requestedWorkspaceId: "wks_managed_writer",
      worktreeRoot: workdir,
    });
    expect(client.createCalls).toBe(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence permits isolated auto-name generation but rejects a competing writer", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-auto-name-"));
  const generationDir = mkdtempSync(join(tmpdir(), "managed-writer-auto-name-generation-"));
  try {
    const client = new ManagedWriterTestClient();
    const manager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(join(workdir, "agents"), logger),
      client,
    });
    await createManagedWriterAgent(manager, workdir);

    const generator = await manager.createAgent(
      { provider: "codex", cwd: generationDir, internal: true },
      undefined,
      { workspaceId: undefined },
    );
    await manager.closeAgent(generator.id);

    await expect(createManagedWriterAgent(manager, workdir)).rejects.toBeInstanceOf(
      ManagedWorktreeWriterConflictError,
    );
    expect(client.createCalls).toBe(2);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(generationDir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence permits same-agent same-session recovery", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-recovery-"));
  try {
    const storagePath = join(workdir, "agents");
    const firstClient = new ManagedWriterTestClient();
    const firstManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: firstClient,
    });
    const owner = await createManagedWriterAgent(firstManager, workdir);
    expect(owner.persistence).not.toBeNull();

    const recoveryClient = new ManagedWriterTestClient();
    const recoveryManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: recoveryClient,
    });
    const recovered = await recoveryManager.resumeAgentFromPersistence(
      owner.persistence!,
      { cwd: workdir },
      owner.id,
      { workspaceId: "wks_managed_writer" },
    );

    expect(recovered.id).toBe(owner.id);
    expect(recoveryClient.resumeOverrides).toHaveLength(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence leaves provider-native children on the owning root", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-provider-child-"));
  try {
    const client = new ManagedWriterTestClient();
    const manager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(join(workdir, "agents"), logger),
      client,
    });
    const owner = await createManagedWriterAgent(manager, workdir);
    const childPublished = new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe((event) => {
        if (
          event.type === "provider_subagent" &&
          event.event.type === "upsert" &&
          event.event.subagent.id === "provider-child"
        ) {
          unsubscribe();
          resolve();
        }
      });
    });

    client.sessions[0].pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "provider-child",
        title: "Provider child with parentID",
        status: "running",
      },
    });
    await childPublished;

    expect(manager.listProviderSubagents(owner.id)).toMatchObject([
      { id: "provider-child", status: "running" },
    ]);
    expect(client.createCalls).toBe(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence transfers ownership after close", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-release-"));
  try {
    const client = new ManagedWriterTestClient();
    const manager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(join(workdir, "agents"), logger),
      client,
    });
    const owner = await createManagedWriterAgent(manager, workdir);
    await manager.closeAgent(owner.id);

    const successor = await createManagedWriterAgent(manager, workdir);

    expect(successor.id).not.toBe(owner.id);
    expect(client.createCalls).toBe(2);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence reconstructs an active owner after daemon restart", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-restart-"));
  try {
    const storagePath = join(workdir, "agents");
    const firstManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: new ManagedWriterTestClient(),
    });
    const owner = await createManagedWriterAgent(firstManager, workdir);

    const contenderClient = new ManagedWriterTestClient();
    const restartedManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: contenderClient,
    });

    await expect(createManagedWriterAgent(restartedManager, workdir)).rejects.toMatchObject({
      ownerAgentId: owner.id,
    });
    expect(contenderClient.createCalls).toBe(0);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("managed worktree writer fence rejects create, resume, and import before provider calls", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "managed-writer-side-effects-"));
  try {
    const storagePath = join(workdir, "agents");
    const ownerManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: new ManagedWriterTestClient(),
    });
    await createManagedWriterAgent(ownerManager, workdir);

    const contenderClient = new ManagedWriterTestClient();
    const contenderManager = createManagedWriterManager({
      cwd: workdir,
      storage: new AgentStorage(storagePath, logger),
      client: contenderClient,
      agentIds: MANAGED_WRITER_AGENT_IDS.slice(1),
    });
    const conflict = ManagedWorktreeWriterConflictError;

    await expect(createManagedWriterAgent(contenderManager, workdir)).rejects.toBeInstanceOf(
      conflict,
    );
    await expect(
      contenderManager.resumeAgentFromPersistence(
        { provider: "codex", sessionId: "different-provider-session" },
        { cwd: workdir },
        MANAGED_WRITER_AGENT_IDS[2],
        { workspaceId: "wks_managed_writer" },
      ),
    ).rejects.toBeInstanceOf(conflict);
    await expect(
      contenderManager.importProviderSession({
        provider: "codex",
        providerHandleId: "imported-provider-session",
        cwd: workdir,
        workspaceId: "wks_managed_writer",
      }),
    ).rejects.toBeInstanceOf(conflict);

    expect(contenderClient.createCalls).toBe(0);
    expect(contenderClient.resumeOverrides).toHaveLength(0);
    expect(contenderClient.importCalls).toBe(0);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
