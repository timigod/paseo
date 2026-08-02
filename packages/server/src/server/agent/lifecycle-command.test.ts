import { describe, expect, test, vi } from "vitest";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
  type LifecycleAgentSnapshot,
  type LifecycleAgentManager,
  type LifecycleAgentStorage,
} from "./lifecycle-command.js";
import {
  createAgentDestructiveCaller,
  createCoordinatorDestructiveCaller,
  revokeDestructiveCaller,
} from "./destructive-action-authority.js";

class FakeLifecycleAgentStorage implements LifecycleAgentStorage {
  readonly records = new Map<string, StoredAgentRecord>();
  readonly upserts: StoredAgentRecord[] = [];

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.upserts.push(record);
    this.records.set(record.id, record);
  }
}

class FakeLifecycleAgentManager implements LifecycleAgentManager {
  readonly liveAgents = new Map<string, LifecycleAgentSnapshot>();
  readonly cancelledAgentIds: string[] = [];
  readonly clearedAttentionAgentIds: string[] = [];
  readonly archivedAgentIds: string[] = [];
  readonly closedAgentIds: string[] = [];
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: { title?: string; labels?: Record<string, string> };
  }> = [];
  readonly labelUpdates: Array<{ agentId: string; labels: Record<string, string> }> = [];
  readonly notifiedAgentIds: string[] = [];
  readonly modeUpdates: Array<{ agentId: string; modeId: string }> = [];
  readonly detachedAgentIds: string[] = [];
  readonly cancelOptions: Array<{ assumeRunning?: boolean } | undefined> = [];
  inFlightAgentIds = new Set<string>();
  readonly settledDuringCancellationAgentIds = new Set<string>();
  readonly rejectedCancellationAgentIds = new Set<string>();
  readonly incarnations = new Map<string, string>();

  constructor(private readonly storage: FakeLifecycleAgentStorage) {}

  getAgent(agentId: string): LifecycleAgentSnapshot | null {
    return this.liveAgents.get(agentId) ?? null;
  }

  isCurrentAgentIncarnation(agentId: string, incarnation: string): boolean {
    return this.incarnations.get(agentId) === incarnation;
  }

  hasInFlightRun(agentId: string): boolean {
    return this.inFlightAgentIds.has(agentId);
  }

  async cancelAgentRun(agentId: string, options?: { assumeRunning?: boolean }) {
    this.cancelledAgentIds.push(agentId);
    this.cancelOptions.push(options);
    if (this.settledDuringCancellationAgentIds.delete(agentId)) {
      this.inFlightAgentIds.delete(agentId);
      return { status: "not_running" } as const;
    }
    if (this.rejectedCancellationAgentIds.has(agentId)) {
      return { status: "refused" } as const;
    }
    return this.inFlightAgentIds.delete(agentId) || options?.assumeRunning
      ? ({ status: "settled" } as const)
      : ({ status: "not_running" } as const);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    this.clearedAttentionAgentIds.push(agentId);
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    this.archivedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
    const archivedAt = "2026-05-10T10:00:00.000Z";
    const existing = this.storage.records.get(agentId) ?? storedAgent(agentId);
    this.storage.records.set(agentId, {
      ...existing,
      archivedAt,
    });
    return { archivedAt };
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const archived = {
      ...existing,
      archivedAt,
    };
    this.storage.records.set(agentId, archived);
    return archived;
  }

  async closeAgent(agentId: string): Promise<void> {
    this.closedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    this.labelUpdates.push({ agentId, labels });
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    this.detachedAgentIds.push(agentId);
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(existing.labels);
    if (!previousParentAgentId) {
      return {
        record: existing,
        live: this.liveAgents.has(agentId),
        previousParentAgentId: null,
      };
    }
    const labels = { ...existing.labels };
    delete labels[PARENT_AGENT_ID_LABEL];
    const record = {
      ...existing,
      labels,
      updatedAt: "2026-05-10T10:30:00.000Z",
    };
    this.storage.records.set(agentId, record);
    return {
      record,
      live: this.liveAgents.has(agentId),
      previousParentAgentId,
    };
  }

  notifyAgentState(agentId: string): void {
    this.notifiedAgentIds.push(agentId);
  }

  async setAgentMode(agentId: string, modeId: string) {
    this.modeUpdates.push({ agentId, modeId });
    return null;
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }
}

const logger = createTestLogger();

describe("agent lifecycle commands", () => {
  test("cancels only when the agent has an in-flight run", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");

    const result = await cancelAgentRunCommand(cancelDependencies(manager, storage), "agent-1");

    expect(result).toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: true,
      outcome: "cancelled",
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
  });

  test("accepts a stop when the run settles during cancellation", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.settledDuringCancellationAgentIds.add("agent-1");

    await expect(
      cancelAgentRunCommand(cancelDependencies(manager, storage), "agent-1"),
    ).resolves.toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: false,
      outcome: "not_running",
    });
  });

  test.each([
    { name: "missing", record: null, outcome: "not_found" },
    {
      name: "archived",
      record: { ...storedAgent("agent-1"), archivedAt: "2026-05-10T10:00:00.000Z" },
      outcome: "archived",
    },
    { name: "idle", record: storedAgent("agent-1"), outcome: "not_running" },
    {
      name: "non-resumable",
      record: { ...storedAgent("agent-1"), lastStatus: "running" as const },
      outcome: "not_resumable",
    },
  ])("classifies an unloaded $name agent without loading it", async ({ record, outcome }) => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    if (record) {
      storage.records.set("agent-1", record);
    }
    const loadAgent = vi.fn();

    await expect(
      cancelAgentRunCommand(
        { agentManager: manager, agentStorage: storage, loadAgent, logger },
        "agent-1",
      ),
    ).resolves.toEqual({ agent: null, cancelled: false, outcome });
    expect(loadAgent).not.toHaveBeenCalled();
    expect(manager.cancelledAgentIds).toEqual([]);
  });

  test.each([
    { terminalLifecycle: "idle" as const, terminalName: "completion" },
    { terminalLifecycle: "error" as const, terminalName: "failure" },
  ])("does not interrupt after restoration-time $terminalName", async ({ terminalLifecycle }) => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    const record = {
      ...storedAgent("agent-1"),
      lastStatus: "running" as const,
      persistence: {
        provider: "codex",
        sessionId: "provider-session-1",
      },
    };
    storage.records.set("agent-1", record);
    const restoredAgent = managedAgent("agent-1", terminalLifecycle);
    const loadAgent = vi.fn(async () => {
      manager.liveAgents.set(restoredAgent.id, restoredAgent);
      return restoredAgent;
    });

    await expect(
      cancelAgentRunCommand(
        { agentManager: manager, agentStorage: storage, loadAgent, logger },
        "agent-1",
      ),
    ).resolves.toEqual({
      agent: restoredAgent,
      cancelled: false,
      outcome: "not_running",
    });
    expect(loadAgent).toHaveBeenCalledWith("agent-1");
    expect(manager.cancelledAgentIds).toEqual([]);
    expect(manager.inFlightAgentIds).toEqual(new Set());
    expect(manager.liveAgents.get("agent-1")?.lifecycle).toBe(terminalLifecycle);
  });

  test("resumes and interrupts an unloaded persisted-running agent with a tracked run", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    const record = {
      ...storedAgent("agent-1"),
      lastStatus: "running" as const,
      persistence: {
        provider: "codex",
        sessionId: "provider-session-1",
      },
    };
    storage.records.set("agent-1", record);
    const resumedAgent = managedAgent("agent-1", "running");
    const loadAgent = vi.fn(async () => {
      const agent = resumedAgent;
      manager.liveAgents.set(agent.id, agent);
      manager.inFlightAgentIds.add(agent.id);
      return agent;
    });

    await expect(
      cancelAgentRunCommand(
        { agentManager: manager, agentStorage: storage, loadAgent, logger },
        "agent-1",
      ),
    ).resolves.toEqual({
      agent: resumedAgent,
      cancelled: true,
      outcome: "cancelled",
    });
    expect(loadAgent).toHaveBeenCalledWith("agent-1");
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.cancelOptions).toEqual([undefined]);
  });

  test("preserves the exact provider resume error", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    storage.records.set("agent-1", {
      ...storedAgent("agent-1"),
      lastStatus: "running",
      persistence: {
        provider: "codex",
        sessionId: "provider-session-1",
      },
    });
    const loadAgent = vi.fn(async () => {
      throw new Error("provider session provider-session-1 no longer exists");
    });

    await expect(
      cancelAgentRunCommand(
        { agentManager: manager, agentStorage: storage, loadAgent, logger },
        "agent-1",
      ),
    ).rejects.toThrow("provider session provider-session-1 no longer exists");
    expect(manager.cancelledAgentIds).toEqual([]);
  });

  test("archives a live agent after canceling and clearing attention", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-05-10T10:00:00.000Z",
      record: {
        ...storedAgent("agent-1"),
        archivedAt: "2026-05-10T10:00:00.000Z",
      },
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.clearedAttentionAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("blocks archive and kill aliases before mutating the caller agent", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.incarnations.set("agent-1", "incarnation-1");
    storage.records.set("agent-1", storedAgent("agent-1"));
    const caller = createAgentDestructiveCaller({
      agentId: "agent-1",
      incarnation: "incarnation-1",
    });

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-1", {
        caller,
      }),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });
    await expect(
      closeAgentCommand({ agentManager: manager }, "agent-1", { caller }),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });

    expect(manager.cancelledAgentIds).toEqual([]);
    expect(manager.clearedAttentionAgentIds).toEqual([]);
    expect(manager.archivedAgentIds).toEqual([]);
    expect(manager.closedAgentIds).toEqual([]);
  });

  test("rejects a stale incarnation before archiving another live agent", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "idle"));
    manager.liveAgents.set("agent-2", managedAgent("agent-2", "idle"));
    manager.incarnations.set("agent-1", "incarnation-after-restart");
    storage.records.set("agent-2", storedAgent("agent-2"));

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-2", {
        caller: createAgentDestructiveCaller({
          agentId: "agent-1",
          incarnation: "incarnation-before-restart",
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_IDENTITY" });
    expect(manager.archivedAgentIds).toEqual([]);
  });

  test("rechecks a caller after awaited cleanup and before archiving", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "idle"));
    storage.records.set("agent-1", storedAgent("agent-1"));
    const caller = createCoordinatorDestructiveCaller();
    let releaseAttention = () => {};
    let attentionStarted = () => {};
    const attentionReached = new Promise<void>((resolve) => {
      attentionStarted = resolve;
    });
    vi.spyOn(manager, "clearAgentAttention").mockImplementation(async (agentId) => {
      manager.clearedAttentionAgentIds.push(agentId);
      attentionStarted();
      await new Promise<void>((resolve) => {
        releaseAttention = resolve;
      });
    });

    const archive = archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
      { caller },
    );
    await attentionReached;
    revokeDestructiveCaller(caller);
    releaseAttention();

    await expect(archive).rejects.toMatchObject({ code: "INVALID_CALLER_IDENTITY" });
    expect(manager.archivedAgentIds).toEqual([]);
    expect(manager.liveAgents.has("agent-1")).toBe(true);
  });

  test("archives a live agent when its graceful cancellation is rejected", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.rejectedCancellationAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-1"),
    ).resolves.toMatchObject({ agentId: "agent-1" });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a stored agent when no live agent exists", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.archivedAt).toEqual(expect.any(String));
    expect(result.record.archivedAt).toBe(result.archivedAt);
    expect(manager.archivedAgentIds).toEqual([]);
  });

  test("normalizes metadata updates and rejects empty updates", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      updateAgentCommand(
        { agentManager: manager },
        {
          agentId: "agent-1",
          name: "  Renamed agent  ",
          labels: { team: "infra" },
        },
      ),
    ).resolves.toEqual({ accepted: true, error: null });
    await expect(
      updateAgentCommand({ agentManager: manager }, { agentId: "agent-1", name: "   " }),
    ).resolves.toEqual({
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    });

    expect(storage.upserts).toHaveLength(0);
    expect(manager.metadataUpdates).toEqual([
      {
        agentId: "agent-1",
        updates: {
          title: "Renamed agent",
          labels: { team: "infra" },
        },
      },
    ]);
  });

  test("detaches an agent by clearing only the parent relationship", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", {
      ...storedAgent("agent-1"),
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        team: "infra",
      },
    });
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: "parent-agent",
      record: {
        ...storedAgent("agent-1"),
        labels: { team: "infra" },
        updatedAt: "2026-05-10T10:30:00.000Z",
      },
    });

    expect(manager.detachedAgentIds).toEqual(["agent-1"]);
  });

  test("detach is accepted when the agent is already detached", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: null,
      record: storedAgent("agent-1"),
    });
  });

  test("sets an agent mode and returns the accepted mode", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      setAgentModeCommand({ agentManager: manager }, { agentId: "agent-1", modeId: "plan" }),
    ).resolves.toEqual({ modeId: "plan", notice: null });

    expect(manager.modeUpdates).toEqual([{ agentId: "agent-1", modeId: "plan" }]);
  });
});

function managedAgent(
  id: string,
  lifecycle: LifecycleAgentSnapshot["lifecycle"],
): LifecycleAgentSnapshot {
  return {
    id,
    cwd: "/workspace/project",
    lifecycle,
  };
}

function storedAgent(id: string): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: null,
    archivedAt: null,
  };
}

function cancelDependencies(
  agentManager: FakeLifecycleAgentManager,
  agentStorage: FakeLifecycleAgentStorage,
) {
  return {
    agentManager,
    agentStorage,
    loadAgent: async (agentId: string) => {
      const agent = agentManager.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }
      return agent;
    },
    logger,
  };
}
