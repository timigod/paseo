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

test("auto-archive remains subscribed and retries after an observable failure", async () => {
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
  });

  agents.completeTurn(agentId);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(agents.listenerCount()).toBe(1);
  agents.completeTurn(agentId);
  await registration.cancel();

  expect(archiveCount).toBe(2);
  expect(agents.listenerCount()).toBe(0);
});

test("actual-target auto-archive rejects a swallowed workspace teardown failure", () => {
  expect(() =>
    requireExactWorkspaceArchive(
      { archivedAgentIds: [], archivedWorkspaceIds: [], removedDirectory: false },
      "ws-requested",
    ),
  ).toThrow("Auto-archive did not archive requested workspace ws-requested");

  expect(() =>
    requireExactWorkspaceArchive(
      {
        archivedAgentIds: ["agent-1"],
        archivedWorkspaceIds: ["ws-requested"],
        removedDirectory: false,
      },
      "ws-requested",
    ),
  ).not.toThrow();
});
