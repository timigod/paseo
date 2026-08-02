import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreateAgentIdempotencyConflictError,
  CreateAgentRequestStore,
  fingerprintCreateAgentRequest,
} from "./create-agent-request-store.js";

const homes: string[] = [];

function createHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-create-requests-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("CreateAgentRequestStore", () => {
  it("coalesces concurrent requests and durably replays the created agent", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const create = vi.fn(async (agentId: string) => {
      existingAgents.add(agentId);
    });
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const input = { key: "fleet-create-1", fingerprint: "same-request", create };

    const [first, concurrent] = await Promise.all([firstStore.run(input), firstStore.run(input)]);
    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const replayCreate = vi.fn(async () => {});
    const replay = await restartedStore.run({ ...input, create: replayCreate });

    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(concurrent).toBe(first);
    expect(replay).toBe(first);
    expect(create).toHaveBeenCalledOnce();
    expect(replayCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of a key for a different create intent", async () => {
    const store = new CreateAgentRequestStore({
      paseoHome: createHome(),
      hasAgent: async () => true,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    });
    await store.run({ key: "fleet-create-2", fingerprint: "request-a", create: async () => {} });

    await expect(
      store.run({ key: "fleet-create-2", fingerprint: "request-b", create: async () => {} }),
    ).rejects.toBeInstanceOf(CreateAgentIdempotencyConflictError);
  });

  it("reconciles a durable receipt when the agent exists after an interrupted response", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000003",
    });
    await expect(
      firstStore.run({
        key: "interrupted-create",
        fingerprint: "request",
        create: async (agentId) => {
          existingAgents.add(agentId);
          throw new Error("response interrupted after create");
        },
      }),
    ).rejects.toThrow("response interrupted");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const duplicateCreate = vi.fn(async () => {});

    await expect(
      restartedStore.run({
        key: "interrupted-create",
        fingerprint: "request",
        create: duplicateCreate,
      }),
    ).resolves.toBe("00000000-0000-4000-8000-000000000003");
    expect(duplicateCreate).not.toHaveBeenCalled();
  });

  it("does not persist failure details and replays the failed state", async () => {
    const home = createHome();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
    });
    await expect(
      firstStore.run({
        key: "failed-create",
        fingerprint: "request",
        create: async () => {
          throw new Error("sensitive prompt or filesystem detail");
        },
      }),
    ).rejects.toThrow("sensitive prompt");

    const receiptFile = readFileSync(path.join(home, "create-agent-requests.json"), "utf8");
    expect(receiptFile).not.toContain("sensitive prompt");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
    });
    const duplicateCreate = vi.fn(async () => {});
    await expect(
      restartedStore.run({
        key: "failed-create",
        fingerprint: "request",
        create: duplicateCreate,
      }),
    ).rejects.toThrow("previous create request failed");
    expect(duplicateCreate).not.toHaveBeenCalled();
  });

  it("expires old receipts so intentionally reused keys can create again", async () => {
    const home = createHome();
    let now = new Date("2026-08-02T00:00:00.000Z");
    let nextId = 2;
    const store = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => true,
      now: () => now,
      retentionMs: 1000,
      idFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    const create = vi.fn(async () => {});
    const first = await store.run({ key: "expiring-key", fingerprint: "request", create });
    now = new Date("2026-08-02T00:00:02.000Z");
    const second = await store.run({ key: "expiring-key", fingerprint: "request", create });

    expect(second).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

it("fingerprints create intent independently of request transport identity and key order", () => {
  expect(
    fingerprintCreateAgentRequest({
      type: "create_agent_request",
      requestId: "request-a",
      idempotencyKey: "retry-a",
      labels: { z: "last", a: "first" },
    }),
  ).toBe(
    fingerprintCreateAgentRequest({
      labels: { a: "first", z: "last" },
      idempotencyKey: "retry-b",
      requestId: "request-b",
      type: "create_agent_request",
    }),
  );
});
