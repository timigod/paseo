import pino from "pino";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { Session, type SessionOptions } from "./session.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { AgentTimelineRow } from "./agent/agent-manager.js";
import type { AgentRecordUpdater, StoredAgentRecord } from "./agent/agent-storage.js";
import { handleCreatePaseoWorktreeRequest } from "./worktree-session.js";

const LegacyTimelineEntryPayloadSchema = z.object({
  provider: z.enum(["claude", "codex", "opencode"]),
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(
    z.object({
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    }),
  ),
  // Copied from v0.1.65-beta.3: no reasoning_merge on the wire yet.
  collapsed: z.array(z.enum(["assistant_merge", "tool_lifecycle"])),
});

const LegacyFetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_response"),
  payload: FetchAgentTimelineResponseMessageSchema.shape.payload.extend({
    entries: z.array(LegacyTimelineEntryPayloadSchema),
  }),
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

interface SessionInternals {
  handleListCommandsRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "list_commands_request" }
    >,
  ) => Promise<void>;
  handleFetchAgentTimelineRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "fetch_agent_timeline_request" }
    >,
  ) => Promise<void>;
  handleClearAgentAttention: (agentId: string | string[], requestId?: string) => Promise<void>;
  handleProviderSubagentListRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "agent.provider_subagents.list.request" }
    >,
  ) => Promise<void>;
  handleProviderSubagentTimelineRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "agent.provider_subagents.timeline.get.request" }
    >,
  ) => Promise<void>;
}

class InMemoryAgentManager {
  constructor(private readonly rows: AgentTimelineRow[]) {}

  getAgent() {
    return {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      lastRuntimeActivityAt: new Date("2026-05-02T00:00:00.000Z"),
      lastUserMessageAt: null,
      lifecycle: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      },
      config: { provider: "codex", cwd: "/tmp/project" },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: null,
      historyPrimed: true,
      lastUsage: undefined,
      lastError: undefined,
      attention: { requiresAttention: false, attentionReason: null, attentionTimestamp: null },
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      session: null,
      activeForegroundTurnId: null,
      labels: {},
    };
  }

  async waitForAgentLifecycleHandoff() {}

  async fetchRetainedOrDurableTimeline() {
    return {
      epoch: "epoch-1",
      direction: "tail" as const,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      rows: this.rows,
      hasOlder: false,
      hasNewer: false,
    };
  }

  listAgents() {
    return [];
  }

  subscribe() {
    return () => {};
  }
}

class EmptyAgentStorage {
  async list() {
    return [];
  }

  async get() {
    return null;
  }
}

class EmptyProjectRegistry {
  async list() {
    return [];
  }

  async get() {
    return null;
  }

  async upsert() {}
  async archive() {}
  async remove() {}
  async initialize() {}
  async existsOnDisk() {
    return false;
  }
}

class EmptyWorkspaceRegistry {
  get() {
    return null;
  }

  list() {
    return [];
  }
}

class EmptyDaemonConfigStore {
  get() {
    return {
      mcp: { injectIntoAgents: false },
      providers: {},
    };
  }

  onChange() {
    return () => {};
  }
}

class InMemoryWorktreeWorkflow {
  readonly capturedInputs: unknown[] = [];

  async create(input: unknown) {
    this.capturedInputs.push(input);
    return {} as never;
  }
}

function createSessionForWireCompatTest(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  messages?: SessionOutboundMessage[];
  agentManager?: SessionOptions["agentManager"];
  agentStorage?: SessionOptions["agentStorage"];
}): Session {
  const messages = options?.messages ?? [];
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-05-02T00:00:00.000Z",
      item: { type: "reasoning", text: "Step " },
    },
    {
      seq: 2,
      timestamp: "2026-05-02T00:00:00.100Z",
      item: { type: "reasoning", text: "by step" },
    },
    {
      seq: 3,
      timestamp: "2026-05-02T00:00:00.200Z",
      item: { type: "assistant_message", text: "done" },
    },
  ];

  const session = new Session({
    clientId: "wire-compat-client",
    clientCapabilities: options?.clientCapabilities ?? null,
    onMessage: (message) => messages.push(message),
    logger: pino({ level: "silent" }),
    downloadTokenStore: {} as SessionOptions["downloadTokenStore"],
    pushTokenStore: {} as SessionOptions["pushTokenStore"],
    paseoHome: "/tmp/paseo-home",
    agentManager:
      options?.agentManager ??
      (new InMemoryAgentManager(rows) as unknown as SessionOptions["agentManager"]),
    agentStorage:
      options?.agentStorage ??
      (new EmptyAgentStorage() as unknown as SessionOptions["agentStorage"]),
    projectRegistry: new EmptyProjectRegistry() as unknown as SessionOptions["projectRegistry"],
    workspaceRegistry:
      new EmptyWorkspaceRegistry() as unknown as SessionOptions["workspaceRegistry"],
    chatService: {} as SessionOptions["chatService"],
    scheduleService: {} as SessionOptions["scheduleService"],
    loopService: {} as SessionOptions["loopService"],
    checkoutDiffManager: {
      scheduleRefreshForCwd() {},
      onWorkspaceStateMayHaveChanged() {},
    } as unknown as SessionOptions["checkoutDiffManager"],
    github: {
      invalidate() {},
      async searchIssuesAndPrs() {
        return [];
      },
      async createPullRequest() {
        return null;
      },
    } as unknown as SessionOptions["github"],
    workspaceGitService: {
      async getCheckoutDiff() {
        return null;
      },
      async getSnapshot() {
        return null;
      },
      async suggestBranchesForCwd() {
        return [];
      },
      async listStashes() {
        return [];
      },
      peekSnapshot() {
        return null;
      },
      async validateBranchRef() {
        return { ok: false, error: "not found" };
      },
      async hasLocalBranch() {
        return false;
      },
      async resolveRepoRemoteUrl() {
        return null;
      },
      async getWorkspaceGitMetadata() {
        return null;
      },
    } as unknown as SessionOptions["workspaceGitService"],
    daemonConfigStore:
      new EmptyDaemonConfigStore() as unknown as SessionOptions["daemonConfigStore"],
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });

  return session;
}

async function emitTimelineResponse(
  clientCapabilities?: Record<string, unknown> | null,
): Promise<Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>> {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({ clientCapabilities, messages });
  const internals = session as unknown as SessionInternals;

  await internals.handleFetchAgentTimelineRequest({
    type: "fetch_agent_timeline_request",
    requestId: "req-timeline",
    agentId: "agent-1",
    projection: "projected",
  });

  const response = messages[0];
  expect(response?.type).toBe("fetch_agent_timeline_response");
  if (!response || response.type !== "fetch_agent_timeline_response") {
    throw new Error("Expected fetch_agent_timeline_response");
  }
  return response;
}

describe("wire compatibility", () => {
  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("downgrades reasoning_merge for clients that do not declare the capability", async () => {
    const response = await emitTimelineResponse();

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).not.toContain("reasoning_merge");

    const legacyParsed = LegacyFetchAgentTimelineResponseMessageSchema.parse(response);
    expect(legacyParsed.payload.entries[0]?.collapsed).toEqual([]);
  });

  test("preserves reasoning_merge for clients that declare the capability", async () => {
    const response = await emitTimelineResponse({
      [CLIENT_CAPS.reasoningMergeEnum]: true,
    });

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).toContain("reasoning_merge");
  });

  test("reads a collected unarchived timeline without resuming its provider runtime", async () => {
    const messages: SessionOutboundMessage[] = [];
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-05-02T00:00:00.000Z",
        item: { type: "assistant_message", text: "collected result" },
      },
    ];
    let resumeCount = 0;
    const manager = {
      getAgent: () => null,
      listAgents: () => [],
      subscribe: () => () => {},
      waitForAgentLifecycleHandoff: async () => {},
      fetchRetainedOrDurableTimeline: async () => ({
        epoch: "collected-epoch",
        direction: "tail" as const,
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        rows,
        hasOlder: false,
        hasNewer: false,
      }),
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: async () => {
        resumeCount += 1;
        throw new Error("timeline reads must not resume provider runtimes");
      },
    } as unknown as SessionOptions["agentManager"];
    const stored = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      lastActivityAt: "2026-05-02T00:00:00.000Z",
      lastRuntimeActivityAt: "2026-05-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: "Collected agent",
      labels: {},
      lastStatus: "closed" as const,
      lastModeId: null,
      config: { model: null },
      persistence: { provider: "codex", sessionId: "persisted-agent-1" },
      internal: false,
      archivedAt: null,
    };
    const storage = {
      list: async () => [stored],
      get: async () => stored,
    } as unknown as SessionOptions["agentStorage"];
    const session = createSessionForWireCompatTest({
      messages,
      agentManager: manager,
      agentStorage: storage,
    });
    const internals = session as unknown as SessionInternals;

    await internals.handleFetchAgentTimelineRequest({
      type: "fetch_agent_timeline_request",
      requestId: "collected-timeline",
      agentId: "agent-1",
      projection: "projected",
    });

    const response = messages.find(
      (message) =>
        message.type === "fetch_agent_timeline_response" &&
        message.payload.requestId === "collected-timeline",
    );
    expect(response).toMatchObject({
      type: "fetch_agent_timeline_response",
      payload: {
        error: null,
        entries: [
          expect.objectContaining({
            item: { type: "assistant_message", text: "collected result" },
          }),
        ],
      },
    });
    expect(resumeCount).toBe(0);
  });

  test("projects hasOlder assistant, reasoning, and tool pages from retained full history", async () => {
    const parentRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      lastActivityAt: "2026-05-02T00:00:00.000Z",
      lastRuntimeActivityAt: "2026-05-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: "Collected projection agent",
      labels: {},
      lastStatus: "closed" as const,
      lastModeId: null,
      config: { model: null },
      persistence: { provider: "codex", sessionId: "persisted-agent-1" },
      internal: false,
      archivedAt: null,
    };
    const storage = {
      list: async () => [parentRecord],
      get: async () => parentRecord,
    } as unknown as SessionOptions["agentStorage"];
    const cases: Array<{
      label: string;
      rows: AgentTimelineRow[];
      expectedItemType: "assistant_message" | "reasoning" | "tool_call";
    }> = [
      {
        label: "assistant",
        rows: [
          {
            seq: 2,
            timestamp: "2026-05-02T00:00:01.000Z",
            item: { type: "assistant_message", text: "part " },
          },
          {
            seq: 3,
            timestamp: "2026-05-02T00:00:02.000Z",
            item: { type: "assistant_message", text: "two" },
          },
        ],
        expectedItemType: "assistant_message",
      },
      {
        label: "reasoning",
        rows: [
          {
            seq: 2,
            timestamp: "2026-05-02T00:00:01.000Z",
            item: { type: "reasoning", text: "step " },
          },
          {
            seq: 3,
            timestamp: "2026-05-02T00:00:02.000Z",
            item: { type: "reasoning", text: "two" },
          },
        ],
        expectedItemType: "reasoning",
      },
      {
        label: "tool",
        rows: [
          {
            seq: 2,
            timestamp: "2026-05-02T00:00:01.000Z",
            item: {
              type: "tool_call",
              callId: "call-1",
              name: "shell",
              status: "running",
              error: null,
              detail: { type: "unknown", input: { cmd: "pwd" }, output: null },
            },
          },
          {
            seq: 3,
            timestamp: "2026-05-02T00:00:02.000Z",
            item: {
              type: "tool_call",
              callId: "call-1",
              name: "shell",
              status: "completed",
              error: null,
              detail: {
                type: "unknown",
                input: { cmd: "pwd" },
                output: { stdout: "/tmp" },
              },
            },
          },
        ],
        expectedItemType: "tool_call",
      },
    ];

    for (const testCase of cases) {
      const messages: SessionOutboundMessage[] = [];
      let fetchCount = 0;
      const fullRows: AgentTimelineRow[] = [
        {
          seq: 1,
          timestamp: "2026-05-02T00:00:00.000Z",
          item: { type: "user_message", text: `older ${testCase.label} context` },
        },
        ...testCase.rows,
      ];
      const manager = {
        getAgent: () => null,
        listAgents: () => [],
        subscribe: () => () => {},
        waitForAgentLifecycleHandoff: async () => {},
        fetchRetainedOrDurableTimeline: async () => {
          fetchCount += 1;
          return {
            epoch: `${testCase.label}-epoch`,
            direction: "tail" as const,
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
            rows: fetchCount === 1 ? testCase.rows : fullRows,
            hasOlder: fetchCount === 1,
            hasNewer: false,
          };
        },
      } as unknown as SessionOptions["agentManager"];
      const session = createSessionForWireCompatTest({
        messages,
        agentManager: manager,
        agentStorage: storage,
      });
      const internals = session as unknown as SessionInternals;

      await internals.handleFetchAgentTimelineRequest({
        type: "fetch_agent_timeline_request",
        requestId: `project-${testCase.label}`,
        agentId: "agent-1",
        projection: "projected",
      });

      const response = messages.find(
        (message) =>
          message.type === "fetch_agent_timeline_response" &&
          message.payload.requestId === `project-${testCase.label}`,
      );
      expect(response, testCase.label).toMatchObject({
        type: "fetch_agent_timeline_response",
        payload: {
          error: null,
          hasOlder: false,
          entries: [
            expect.objectContaining({
              item: {
                type: "user_message",
                text: `older ${testCase.label} context`,
              },
            }),
            expect.objectContaining({
              item: expect.objectContaining({ type: testCase.expectedItemType }),
            }),
          ],
        },
      });
      expect(fetchCount, testCase.label).toBe(2);
    }
  });

  test("clears attention on a collected agent without resuming its provider runtime", async () => {
    const messages: SessionOutboundMessage[] = [];
    let resumeCount = 0;
    let clearLiveCount = 0;
    const manager = {
      getAgent: () => null,
      listAgents: () => [],
      subscribe: () => () => {},
      waitForAgentLifecycleHandoff: async () => {},
      clearAgentAttention: async () => {
        clearLiveCount += 1;
      },
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: async () => {
        resumeCount += 1;
        throw new Error("attention clear must not resume provider runtimes");
      },
    } as unknown as SessionOptions["agentManager"];
    let stored: StoredAgentRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      lastActivityAt: "2026-05-02T00:00:00.000Z",
      lastRuntimeActivityAt: "2026-05-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: "Collected attention agent",
      labels: {},
      lastStatus: "closed" as const,
      lastModeId: null,
      config: { model: null },
      persistence: { provider: "codex", sessionId: "persisted-agent-1" },
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2026-05-02T00:00:00.000Z",
      internal: false,
      archivedAt: null,
    };
    const storage = {
      list: async () => [stored],
      get: async () => stored,
      update: async (_agentId: string, updater: AgentRecordUpdater) => {
        stored = updater(stored) ?? stored;
        return stored;
      },
    } as unknown as SessionOptions["agentStorage"];
    const session = createSessionForWireCompatTest({
      messages,
      agentManager: manager,
      agentStorage: storage,
    });
    const internals = session as unknown as SessionInternals;

    await internals.handleClearAgentAttention("agent-1", "clear-collected-attention");

    const response = messages.find(
      (message) =>
        message.type === "clear_agent_attention_response" &&
        message.payload.requestId === "clear-collected-attention",
    );
    expect(response).toMatchObject({
      type: "clear_agent_attention_response",
      payload: {
        agents: [
          expect.objectContaining({
            id: "agent-1",
            status: "closed",
            requiresAttention: false,
          }),
        ],
      },
    });
    expect(stored).toMatchObject({
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    });
    expect(resumeCount).toBe(0);
    expect(clearLiveCount).toBe(0);
  });

  test("returns runtime-neutral slash autocomplete unavailability for a collected agent", async () => {
    const messages: SessionOutboundMessage[] = [];
    let resumeCount = 0;
    let draftSpawnCount = 0;
    const manager = {
      getAgent: () => null,
      listAgents: () => [],
      subscribe: () => () => {},
      listDraftCommands: async () => {
        draftSpawnCount += 1;
        return [];
      },
      resumeAgentFromPersistence: async () => {
        resumeCount += 1;
        throw new Error("slash autocomplete must not resume collected agents");
      },
    } as unknown as SessionOptions["agentManager"];
    const stored: StoredAgentRecord = {
      id: "agent-1",
      provider: "opencode",
      cwd: "/tmp/project",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      lastActivityAt: "2026-05-02T00:00:00.000Z",
      lastRuntimeActivityAt: "2026-05-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: "Collected command agent",
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: { model: "gpt-5.6-terra" },
      persistence: { provider: "opencode", sessionId: "persisted-command-agent" },
      internal: false,
      archivedAt: null,
    };
    const storage = {
      list: async () => [stored],
      get: async () => stored,
      update: async () => {
        throw new Error("slash autocomplete must not mutate the stored activity clock");
      },
    } as unknown as SessionOptions["agentStorage"];
    const session = createSessionForWireCompatTest({
      messages,
      agentManager: manager,
      agentStorage: storage,
    });
    const internals = session as unknown as SessionInternals;

    await internals.handleListCommandsRequest({
      type: "list_commands_request",
      requestId: "collected-command-autocomplete",
      agentId: stored.id,
      draftConfig: {
        provider: stored.provider,
        cwd: stored.cwd,
        model: stored.config?.model ?? undefined,
      },
    });

    expect(
      messages.find(
        (message) =>
          message.type === "list_commands_response" &&
          message.payload.requestId === "collected-command-autocomplete",
      ),
    ).toMatchObject({
      payload: {
        agentId: stored.id,
        commands: [],
        error: "Agent is not active; slash-command autocomplete is unavailable",
      },
    });
    expect(stored.lastRuntimeActivityAt).toBe("2026-05-02T00:00:00.000Z");
    expect(stored.updatedAt).toBe("2026-05-02T00:00:00.000Z");
    expect(resumeCount).toBe(0);
    expect(draftSpawnCount).toBe(0);
  });

  test("continues listing slash commands from an active agent runtime", async () => {
    const messages: SessionOutboundMessage[] = [];
    const manager = {
      getAgent: () => ({
        id: "agent-1",
        session: {
          listCommands: async () => [
            {
              name: "review",
              description: "Review the current change",
              argumentHint: "",
              kind: "command" as const,
            },
          ],
        },
      }),
      listAgents: () => [],
      subscribe: () => () => {},
    } as unknown as SessionOptions["agentManager"];
    const storage = {
      list: async () => [],
      get: async () => {
        throw new Error("active command listing must not read stored fallback state");
      },
    } as unknown as SessionOptions["agentStorage"];
    const session = createSessionForWireCompatTest({
      messages,
      agentManager: manager,
      agentStorage: storage,
    });
    const internals = session as unknown as SessionInternals;

    await internals.handleListCommandsRequest({
      type: "list_commands_request",
      requestId: "active-command-autocomplete",
      agentId: "agent-1",
    });

    expect(
      messages.find(
        (message) =>
          message.type === "list_commands_response" &&
          message.payload.requestId === "active-command-autocomplete",
      ),
    ).toMatchObject({
      payload: {
        agentId: "agent-1",
        commands: [
          {
            name: "review",
            description: "Review the current change",
            argumentHint: "",
            kind: "command",
          },
        ],
        error: null,
      },
    });
  });

  test("reads retained provider subagents without resuming the collected parent runtime", async () => {
    const messages: SessionOutboundMessage[] = [];
    const parentAgentId = "00000000-0000-4000-8000-000000000701";
    let resumeCount = 0;
    let restoreCount = 0;
    let restored = false;
    const descriptor = {
      id: "child-1",
      parentAgentId,
      provider: "codex" as const,
      title: "Retained child",
      description: null,
      status: "completed" as const,
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:01:00.000Z",
      toolCallId: null,
      cwd: "/tmp/project",
    };
    const manager = {
      getAgent: () => null,
      listAgents: () => [],
      subscribe: () => () => {},
      waitForAgentLifecycleHandoff: async () => {},
      restoreProviderSubagents: (
        restoredParentAgentId: string,
        snapshots: StoredAgentRecord["providerSubagents"],
      ) => {
        restoreCount += 1;
        expect(restoredParentAgentId).toBe(parentAgentId);
        expect(snapshots).toHaveLength(1);
        restored = true;
      },
      listProviderSubagents: () => (restored ? [descriptor] : []),
      getProviderSubagent: () => (restored ? descriptor : null),
      fetchProviderSubagentTimeline: () => ({
        epoch: "provider-child-epoch",
        direction: "tail" as const,
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        rows: [
          {
            seq: 1,
            timestamp: "2026-05-02T00:00:30.000Z",
            item: { type: "assistant_message" as const, text: "retained child result" },
          },
        ],
        hasOlder: false,
        hasNewer: false,
      }),
      getRegisteredProviderIds: () => ["codex"],
      resumeAgentFromPersistence: async () => {
        resumeCount += 1;
        throw new Error("provider-subagent reads must not resume the parent runtime");
      },
    } as unknown as SessionOptions["agentManager"];
    const stored: StoredAgentRecord = {
      id: parentAgentId,
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      lastActivityAt: "2026-05-02T00:00:00.000Z",
      lastRuntimeActivityAt: "2026-05-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: "Collected parent",
      labels: {},
      lastStatus: "closed" as const,
      lastModeId: null,
      config: { model: null },
      persistence: { provider: "codex", sessionId: "persisted-parent" },
      internal: false,
      archivedAt: null,
      providerSubagents: [
        {
          descriptor,
          timeline: {
            epoch: "provider-child-epoch",
            nextSeq: 2,
            rows: [
              {
                seq: 1,
                timestamp: "2026-05-02T00:00:30.000Z",
                item: { type: "assistant_message", text: "retained child result" },
              },
            ],
          },
        },
      ],
    };
    const storage = {
      list: async () => [stored],
      get: async () => stored,
    } as unknown as SessionOptions["agentStorage"];
    const session = createSessionForWireCompatTest({
      messages,
      agentManager: manager,
      agentStorage: storage,
    });
    const internals = session as unknown as SessionInternals;

    await internals.handleProviderSubagentListRequest({
      type: "agent.provider_subagents.list.request",
      requestId: "retained-child-list",
      parentAgentId,
    });
    await internals.handleProviderSubagentTimelineRequest({
      type: "agent.provider_subagents.timeline.get.request",
      requestId: "retained-child-timeline",
      parentAgentId,
      subagentId: "child-1",
      direction: "tail",
    });

    expect(
      messages.find(
        (message) =>
          message.type === "agent.provider_subagents.list.response" &&
          message.payload.requestId === "retained-child-list",
      ),
    ).toMatchObject({
      payload: {
        error: null,
        subagents: [expect.objectContaining({ id: "child-1", status: "completed" })],
      },
    });
    expect(
      messages.find(
        (message) =>
          message.type === "agent.provider_subagents.timeline.get.response" &&
          message.payload.requestId === "retained-child-timeline",
      ),
    ).toMatchObject({
      payload: {
        error: null,
        rows: [
          expect.objectContaining({
            item: { type: "assistant_message", text: "retained child result" },
          }),
        ],
      },
    });
    expect(resumeCount).toBe(0);
    expect(restoreCount).toBe(2);
  });

  test("sub_agent tool-call payload still parses against the v0.1.65-beta.3 schema", () => {
    const parsed = LegacySubAgentToolCallSchema.parse({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "[Read] README.md",
        actions: [],
      },
    });

    expect(parsed.detail.actions).toEqual([]);
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  test("legacy worktree request shape normalizes to the same internal input as the new shape", async () => {
    const workflow = new InMemoryWorktreeWorkflow();

    const dependencies = {
      paseoHome: "/tmp/paseo-home",
      describeWorkspaceRecord: async () =>
        ({
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "repo",
          cwd: "/tmp/repo",
          status: "ready",
          activityAt: null,
          scripts: [],
        }) as never,
      emit() {},
      sessionLogger: pino({ level: "silent" }),
      createPaseoWorktreeWorkflow: workflow.create.bind(workflow),
    };

    const legacyRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-legacy",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      nameContext: "Investigate flaky test",
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 55,
          title: "Improve startup error details",
          url: "https://github.com/getpaseo/paseo/issues/55",
        },
      ],
    });

    const newRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-new",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
    });

    if (legacyRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected legacy worktree request");
    }
    if (newRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected new worktree request");
    }

    await handleCreatePaseoWorktreeRequest(dependencies, legacyRequest);
    await handleCreatePaseoWorktreeRequest(dependencies, newRequest);

    expect(workflow.capturedInputs).toHaveLength(2);
    expect(workflow.capturedInputs[0]).toEqual(workflow.capturedInputs[1]);
    expect(workflow.capturedInputs[0]).toEqual({
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
      refName: undefined,
      action: undefined,
      githubPrNumber: undefined,
      runSetup: false,
      paseoHome: "/tmp/paseo-home",
    });
  });
});
