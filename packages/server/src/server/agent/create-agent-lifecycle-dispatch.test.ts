import { expect, test, vi } from "vitest";

import type { AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import {
  CreateAgentLifecycleDispatch,
  registerAgentAutoArchive,
  requireExactWorkspaceArchive,
} from "./create-agent-lifecycle-dispatch.js";

class AgentLifecycleEvents {
  private readonly listeners = new Set<AgentSubscriber>();

  subscribe(listener: AgentSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  completeTurn(agentId: string): void {
    const event: AgentManagerEvent = {
      type: "agent_stream",
      agentId,
      event: { type: "turn_completed", provider: "codex" },
    };
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

test("auto-archive self-releases once and later cancellation waits harmlessly", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e3";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
    },
  });

  agents.completeTurn(agentId);
  await registration.cancel();
  await registration.cancel();
  agents.completeTurn(agentId);

  expect(archiveCount).toBe(1);
  expect(agents.listenerCount()).toBe(0);
});

test("auto-archive autonomously retries after an observable failure", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e4";
  const agents = new AgentLifecycleEvents();
  const onError = vi.fn();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
      if (archiveCount === 1) throw new Error("archive transport failed");
    },
    onError,
    retryDelayMs: 1,
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(archiveCount).toBe(2));
  await registration.cancel();

  expect(archiveCount).toBe(2);
  expect(agents.listenerCount()).toBe(0);
});

test("cleanup-only pending waits for a lifecycle rearm without a retry loop", async () => {
  vi.useFakeTimers();
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e5";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  let rearm: (() => void) | null = null;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
      if (archiveCount === 1) throw new Error("cleanup-only pending");
    },
    shouldRetry: () => false,
    subscribeToRearm: (callback) => {
      rearm = callback;
      return () => {
        rearm = null;
      };
    },
    retryDelayMs: 1,
  });

  try {
    agents.completeTurn(agentId);
    await vi.waitFor(() => expect(archiveCount).toBe(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(archiveCount).toBe(1);
    expect(rearm).not.toBeNull();

    rearm?.();
    await vi.waitFor(() => expect(archiveCount).toBe(2));
    expect(agents.listenerCount()).toBe(0);
  } finally {
    await registration.cancel();
    vi.useRealTimers();
  }
});

test("a registry mutation during cleanup failure cannot be lost before rearm waiting", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e6";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  let publishMutation: (() => void) | null = null;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
      if (archiveCount === 1) {
        publishMutation?.();
        throw new Error("cleanup-only pending after concurrent removal");
      }
    },
    shouldRetry: () => false,
    subscribeToRearm: (callback) => {
      publishMutation = callback;
      return () => {
        publishMutation = null;
      };
    },
  });

  agents.completeTurn(agentId);
  await expect(registration.settled).resolves.toBe("completed");

  expect(archiveCount).toBe(2);
  expect(agents.listenerCount()).toBe(0);
  expect(publishMutation).toBeNull();
});

test("lifecycle shutdown cancels listeners and truthfully awaits an active archive", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e7";
  const agents = new AgentLifecycleEvents();
  let releaseArchive!: () => void;
  let markArchiveStarted!: () => void;
  const archiveStarted = new Promise<void>((resolve) => {
    markArchiveStarted = resolve;
  });
  const archiveFinished = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const completeStep = vi.fn(async () => undefined);
  const dispatch = new CreateAgentLifecycleDispatch({
    paseoHome: "/tmp/paseo",
    agentManager: agents,
    agentStorage: { completePendingCreateContinuationStep: completeStep },
    github: {} as never,
    workspaceGitService: {} as never,
    createPaseoWorktreeWorkflow: vi.fn() as never,
    archiveAgentForClose: async () => {
      markArchiveStarted();
      await archiveFinished;
    },
    findWorkspaceIdForCwd: async () => null,
    listActiveWorkspaces: async () => [],
    archiveWorkspaceRecord: async () => undefined,
    emit: () => undefined,
    emitAgentRemove: () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: async () => undefined,
    markWorkspaceArchiving: () => undefined,
    clearWorkspaceArchiving: () => undefined,
    killTerminalsForWorkspace: async () => undefined,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });
  dispatch.registerPersistedAutoArchive(
    agentId,
    { kind: "agent-only" },
    {
      startImmediately: true,
    },
  );
  await archiveStarted;

  let shutdownSettled = false;
  const shutdown = dispatch.shutdown({ timeoutMs: 5_000 }).then((result) => {
    shutdownSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(shutdownSettled).toBe(false);
  expect(agents.listenerCount()).toBe(0);

  releaseArchive();
  await expect(shutdown).resolves.toEqual({ completed: true, pendingAgentIds: [] });
  expect(completeStep).toHaveBeenCalledWith(agentId, "autoArchive");
});

test("lifecycle shutdown reports an active archive at its deadline instead of completing early", async () => {
  vi.useFakeTimers();
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e8";
  const agents = new AgentLifecycleEvents();
  let releaseArchive!: () => void;
  const archiveFinished = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const dispatch = new CreateAgentLifecycleDispatch({
    paseoHome: "/tmp/paseo",
    agentManager: agents as never,
    agentStorage: {
      completePendingCreateContinuationStep: vi.fn(async () => undefined),
    } as never,
    github: {} as never,
    workspaceGitService: {} as never,
    createPaseoWorktreeWorkflow: vi.fn() as never,
    archiveAgentForClose: async () => archiveFinished,
    findWorkspaceIdForCwd: async () => null,
    listActiveWorkspaces: async () => [],
    archiveWorkspaceRecord: async () => undefined,
    emit: () => undefined,
    emitAgentRemove: () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: async () => undefined,
    markWorkspaceArchiving: () => undefined,
    clearWorkspaceArchiving: () => undefined,
    killTerminalsForWorkspace: async () => undefined,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });
  const registration = dispatch.registerPersistedAutoArchive(
    agentId,
    { kind: "agent-only" },
    { startImmediately: true },
  );
  await Promise.resolve();

  const shutdown = dispatch.shutdown({ timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  await expect(shutdown).resolves.toEqual({ completed: false, pendingAgentIds: [agentId] });
  expect(agents.listenerCount()).toBe(0);

  releaseArchive();
  await expect(registration.settled).resolves.toBe("completed");
  await expect(dispatch.shutdown({ timeoutMs: 100 })).resolves.toEqual({
    completed: true,
    pendingAgentIds: [],
  });
  vi.useRealTimers();
});

test("actual-target auto-archive rejects a swallowed workspace teardown failure", () => {
  expect(() =>
    requireExactWorkspaceArchive(
      {
        archivedAgentIds: [],
        archivedWorkspaceIds: [],
        removedDirectory: false,
        cleanupPending: true,
      },
      "ws-requested",
      "agent-1",
    ),
  ).toThrow("Auto-archive cleanup remains pending for workspace ws-requested");

  expect(() =>
    requireExactWorkspaceArchive(
      {
        archivedAgentIds: ["agent-1"],
        archivedWorkspaceIds: ["ws-requested"],
        removedDirectory: true,
        cleanupPending: false,
      },
      "ws-requested",
      "agent-1",
    ),
  ).not.toThrow();
});

test("auto-archive rejects partial agent and directory receipts", () => {
  expect(() =>
    requireExactWorkspaceArchive(
      {
        archivedAgentIds: [],
        archivedWorkspaceIds: ["ws-requested"],
        removedDirectory: true,
        cleanupPending: false,
      },
      "ws-requested",
      "agent-1",
    ),
  ).toThrow("Auto-archive did not archive requested agent agent-1");

  expect(() =>
    requireExactWorkspaceArchive(
      {
        archivedAgentIds: ["agent-1"],
        archivedWorkspaceIds: ["ws-requested"],
        removedDirectory: false,
        cleanupPending: false,
      },
      "ws-requested",
      "agent-1",
    ),
  ).toThrow("Auto-archive did not remove workspace directory ws-requested");
});
