import { expect, test, vi } from "vitest";

import type { AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import {
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
