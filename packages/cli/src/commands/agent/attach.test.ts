import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import {
  runAttachSession,
  type AttachAgentState,
  type AttachAgentUpdate,
  type AttachSessionClient,
  type AttachSignal,
  type AttachSignalSource,
} from "./attach.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

class FakeAttachClient implements AttachSessionClient {
  readonly streamListeners = new Set<(agentId: string, event: AgentStreamEventPayload) => void>();
  readonly updateListeners = new Set<(update: AttachAgentUpdate) => void>();
  readonly startAgentUpdates = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly fetchAgent: AttachSessionClient["fetchAgent"];

  constructor(readback: AttachAgentState | null = runningAgent(TARGET_ID)) {
    this.fetchAgent = vi.fn(async () => readback);
  }

  onAgentStream(listener: (agentId: string, event: AgentStreamEventPayload) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  onAgentUpdate(listener: Parameters<AttachSessionClient["onAgentUpdate"]>[0]): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  emitStream(agentId: string, event: AgentStreamEventPayload): void {
    for (const listener of this.streamListeners) listener(agentId, event);
  }

  emitRemove(agentId: string): void {
    for (const listener of this.updateListeners) listener({ kind: "remove", agentId });
  }

  emitUpsert(agent: AttachAgentState): void {
    for (const listener of this.updateListeners) listener({ kind: "upsert", agent });
  }
}

class FakeSignalSource implements AttachSignalSource {
  private readonly listeners = new Map<AttachSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);

  on(signal: AttachSignal, listener: () => void): void {
    this.listeners.get(signal)?.add(listener);
  }

  removeListener(signal: AttachSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: AttachSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  listenerCount(signal: AttachSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function runningAgent(id: string): AttachAgentState {
  return { id, status: "running", archivedAt: null };
}

function createSession(client: FakeAttachClient, signalSource = new FakeSignalSource()) {
  const effects = {
    fetchTimelineItems: vi.fn(async () => []),
    printTimelineItem: vi.fn(),
    printStreamEvent: vi.fn(),
    warnTimeline: vi.fn(),
    printDetach: vi.fn(),
  };
  const promise = runAttachSession({
    agentId: TARGET_ID,
    client,
    signalSource,
    ...effects,
  });
  return { promise, signalSource, ...effects };
}

describe("runAttachSession", () => {
  it("exits when the exact target emits a terminal turn", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitStream(TARGET_ID, { type: "turn_completed", provider: "mock" });

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("exits when the exact target is archived", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitRemove(TARGET_ID);

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("exits when the exact target reports a closed state", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitUpsert({ id: TARGET_ID, status: "closed", archivedAt: null });

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("ignores terminal and archive events for unrelated agents", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);
    let settled = false;
    void session.promise.then(() => {
      settled = true;
      return undefined;
    });

    client.emitStream(OTHER_ID, { type: "turn_completed", provider: "mock" });
    client.emitRemove(OTHER_ID);
    client.emitUpsert({ id: OTHER_ID, status: "closed", archivedAt: null });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(client.close).not.toHaveBeenCalled();

    client.emitStream(TARGET_ID, { type: "turn_completed", provider: "mock" });
    await session.promise;
  });

  it.each(["SIGINT", "SIGTERM"] satisfies AttachSignal[])(
    "detaches and cleans up on %s",
    async (signal) => {
      const client = new FakeAttachClient();
      const session = createSession(client);

      session.signalSource.emit(signal);

      await session.promise;
      expect(session.printDetach).toHaveBeenCalledOnce();
      expect(client.close).toHaveBeenCalledOnce();
      expect(session.signalSource.listenerCount("SIGINT")).toBe(0);
      expect(session.signalSource.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("cleans up stream and update listeners after exit", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitStream(TARGET_ID, { type: "turn_failed", provider: "mock", error: "failed" });

    await session.promise;
    expect(client.streamListeners.size).toBe(0);
    expect(client.updateListeners.size).toBe(0);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("exits when the exact readback says the target is no longer attachable", async () => {
    const client = new FakeAttachClient({ id: TARGET_ID, status: "closed", archivedAt: null });

    await createSession(client).promise;

    expect(client.startAgentUpdates).toHaveBeenCalledOnce();
    expect(client.fetchAgent).toHaveBeenCalledWith(TARGET_ID);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
