import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreateAgentIdempotencyConflictError,
  CreateAgentRequestStore,
  type CreateAgentRequestContext,
  fingerprintCreateAgentRequest,
} from "./create-agent-request-store.js";

const REQUEST_A = "a".repeat(64);
const REQUEST_B = "b".repeat(64);

function scopedInput<T extends object>(input: T) {
  return { callerId: "cli-client", action: "create_agent" as const, ...input };
}

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
    const create = vi.fn(async ({ agentId }: { agentId: string }) => {
      existingAgents.add(agentId);
    });
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const input = scopedInput({ key: "fleet-create-1", fingerprint: REQUEST_A, create });

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
    const existingAgents = new Set<string>();
    const store = new CreateAgentRequestStore({
      paseoHome: createHome(),
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    });
    await store.run(
      scopedInput({
        key: "fleet-create-2",
        fingerprint: REQUEST_A,
        create: async ({ agentId }) => {
          existingAgents.add(agentId);
        },
      }),
    );

    await expect(
      store.run(
        scopedInput({ key: "fleet-create-2", fingerprint: REQUEST_B, create: async () => {} }),
      ),
    ).rejects.toBeInstanceOf(CreateAgentIdempotencyConflictError);
  });

  it("resumes a pending registered agent instead of treating existence as success", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000003",
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "interrupted-create",
          fingerprint: REQUEST_A,
          create: async ({ agentId, checkpoint }) => {
            existingAgents.add(agentId);
            await checkpoint("agent_registered");
            throw new Error("prompt dispatch interrupted after create");
          },
        }),
      ),
    ).rejects.toThrow("prompt dispatch interrupted");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const resumeCreate = vi.fn(async ({ phase, checkpoint }: CreateAgentRequestContext) => {
      expect(phase).toBe("agent_registered");
      await checkpoint("prompt_dispatched");
    });

    await expect(
      restartedStore.run(
        scopedInput({
          key: "interrupted-create",
          fingerprint: REQUEST_A,
          create: resumeCreate,
        }),
      ),
    ).resolves.toBe("00000000-0000-4000-8000-000000000003");
    expect(resumeCreate).toHaveBeenCalledOnce();
  });

  it("recovers registration when its receipt checkpoint failed", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000013",
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "registration-checkpoint-failed",
          fingerprint: REQUEST_A,
          create: async ({ agentId }) => {
            existingAgents.add(agentId);
            throw new Error("receipt checkpoint write failed");
          },
        }),
      ),
    ).rejects.toThrow("receipt checkpoint write failed");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const resumeCreate = vi.fn(async (context: CreateAgentRequestContext) => {
      expect(context.phase).toBe("agent_registered");
      await context.checkpoint("prompt_dispatched");
    });

    await expect(
      restartedStore.run(
        scopedInput({
          key: "registration-checkpoint-failed",
          fingerprint: REQUEST_A,
          create: resumeCreate,
        }),
      ),
    ).resolves.toBe("00000000-0000-4000-8000-000000000013");
    expect(resumeCreate).toHaveBeenCalledOnce();
  });

  it("fails closed when prompt provider acceptance is indeterminate", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000014",
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "prompt-acceptance-unknown",
          fingerprint: REQUEST_A,
          create: async ({ agentId, checkpoint }) => {
            existingAgents.add(agentId);
            await checkpoint("agent_registered");
            await checkpoint("prompt_dispatching");
            throw new Error("daemon crashed after provider call");
          },
        }),
      ),
    ).rejects.toThrow("daemon crashed");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const retryCreate = vi.fn(async () => {});
    await expect(
      restartedStore.run(
        scopedInput({
          key: "prompt-acceptance-unknown",
          fingerprint: REQUEST_A,
          create: retryCreate,
        }),
      ),
    ).rejects.toThrow("prompt delivery");
    expect(retryCreate).not.toHaveBeenCalled();
  });

  it("finishes replay without redispatching after the prompt checkpoint", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
      idFactory: () => "00000000-0000-4000-8000-000000000016",
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "prompt-checkpoint-complete",
          fingerprint: REQUEST_A,
          create: async ({ agentId, checkpoint }) => {
            existingAgents.add(agentId);
            await checkpoint("agent_registered");
            await checkpoint("prompt_dispatching");
            await checkpoint("prompt_dispatched");
            throw new Error("daemon crashed before success receipt");
          },
        }),
      ),
    ).rejects.toThrow("daemon crashed");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const retryCreate = vi.fn(async () => {});
    await expect(
      restartedStore.run(
        scopedInput({
          key: "prompt-checkpoint-complete",
          fingerprint: REQUEST_A,
          create: retryCreate,
        }),
      ),
    ).resolves.toBe("00000000-0000-4000-8000-000000000016");
    expect(retryCreate).not.toHaveBeenCalled();
  });

  it("migrates a succeeded version-1 receipt as accepted without redispatching", async () => {
    const home = createHome();
    const file = path.join(home, "create-agent-requests.json");
    const agentId = "00000000-0000-4000-8000-000000000015";
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        receipts: [
          { invalid: "ignored independently" },
          {
            key: "legacy-key",
            fingerprint: REQUEST_A,
            agentId,
            state: "succeeded",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = new CreateAgentRequestStore({
      paseoHome: home,
      daemonId: "daemon-a",
      hasAgent: async (candidate) => candidate === agentId,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    const create = vi.fn(async () => {});

    await expect(
      store.run(scopedInput({ key: "legacy-key", fingerprint: REQUEST_A, create })),
    ).resolves.toBe(agentId);
    expect(create).not.toHaveBeenCalled();
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    expect(migrated.version).toBe(2);
    expect(migrated.receipts).toEqual([
      expect.objectContaining({
        callerId: "cli-client",
        key: "legacy-key",
        agentId,
        state: "succeeded",
        phase: "prompt_dispatched",
      }),
    ]);
  });

  it("fails closed for a pending version-1 receipt whose agent exists", async () => {
    const home = createHome();
    const file = path.join(home, "create-agent-requests.json");
    const agentId = "00000000-0000-4000-8000-000000000017";
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        receipts: [
          {
            key: "legacy-pending-key",
            fingerprint: REQUEST_A,
            agentId,
            state: "pending",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = new CreateAgentRequestStore({
      paseoHome: home,
      daemonId: "daemon-a",
      hasAgent: async (candidate) => candidate === agentId,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    const create = vi.fn(async () => {});

    await expect(
      store.run(scopedInput({ key: "legacy-pending-key", fingerprint: REQUEST_A, create })),
    ).rejects.toThrow(
      `Initial prompt delivery for agent ${agentId} is indeterminate; inspect the agent before manually resubmitting`,
    );
    expect(create).not.toHaveBeenCalled();
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    expect(migrated.receipts).toEqual([
      expect.objectContaining({
        callerId: "cli-client",
        state: "pending",
        phase: "prompt_dispatching",
      }),
    ]);
  });

  it("reuses durable workspace placement after an interrupted create", async () => {
    const home = createHome();
    const placement = { workspaceId: "workspace-1", cwd: "/tmp/worktree-1" };
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
      idFactory: () => "00000000-0000-4000-8000-000000000004",
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "interrupted-placement",
          fingerprint: REQUEST_A,
          create: async ({ checkpoint }) => {
            await checkpoint("placement_created", placement);
            throw new Error("interrupted after placement");
          },
        }),
      ),
    ).rejects.toThrow("interrupted after placement");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
    });
    const resumeCreate = vi.fn(async (context: CreateAgentRequestContext) => {
      expect(context.phase).toBe("placement_created");
      expect(context.placement).toEqual(placement);
      await context.checkpoint("agent_registered");
    });

    await expect(
      restartedStore.run(
        scopedInput({
          key: "interrupted-placement",
          fingerprint: REQUEST_A,
          create: resumeCreate,
        }),
      ),
    ).resolves.toBe("00000000-0000-4000-8000-000000000004");
    expect(resumeCreate).toHaveBeenCalledOnce();
  });

  it("rejects receipt lifecycle regressions", async () => {
    const store = new CreateAgentRequestStore({
      paseoHome: createHome(),
      hasAgent: async () => false,
    });

    await expect(
      store.run(
        scopedInput({
          key: "phase-regression",
          fingerprint: REQUEST_A,
          create: async ({ checkpoint }) => {
            await checkpoint("agent_registered");
            await checkpoint("placement_created", {
              workspaceId: "workspace-1",
              cwd: "/tmp/worktree-1",
            });
          },
        }),
      ),
    ).rejects.toThrow("cannot move backward");
  });

  it("does not persist failure details and replays the failed state", async () => {
    const home = createHome();
    const firstStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
    });
    await expect(
      firstStore.run(
        scopedInput({
          key: "failed-create",
          fingerprint: REQUEST_A,
          create: async () => {
            throw new Error("sensitive prompt or filesystem detail");
          },
        }),
      ),
    ).rejects.toThrow("sensitive prompt");

    const receiptFile = readFileSync(path.join(home, "create-agent-requests.json"), "utf8");
    expect(receiptFile).not.toContain("sensitive prompt");

    const restartedStore = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
    });
    const duplicateCreate = vi.fn(async () => {});
    await expect(
      restartedStore.run(
        scopedInput({
          key: "failed-create",
          fingerprint: REQUEST_A,
          create: duplicateCreate,
        }),
      ),
    ).rejects.toThrow("previous create request failed");
    expect(duplicateCreate).not.toHaveBeenCalled();
  });

  it("refuses a delayed retry after pruning when the deterministic agent still exists", async () => {
    const home = createHome();
    let now = new Date("2026-08-02T00:00:00.000Z");
    const existingAgents = new Set<string>();
    const store = new CreateAgentRequestStore({
      paseoHome: home,
      daemonId: "daemon-a",
      hasAgent: async (agentId) => existingAgents.has(agentId),
      now: () => now,
      retentionMs: 1000,
    });
    const create = vi.fn(async ({ agentId }: CreateAgentRequestContext) => {
      existingAgents.add(agentId);
    });
    const input = scopedInput({ key: "expiring-key", fingerprint: REQUEST_A, create });
    await store.run(input);
    now = new Date("2026-08-02T00:00:02.000Z");

    await expect(store.run(input)).rejects.toThrow("receipt expired");
    expect(create).toHaveBeenCalledOnce();
  });

  it("scopes the same raw key by stable caller and daemon identity", async () => {
    const home = createHome();
    const existingAgents = new Set<string>();
    const create = vi.fn(async ({ agentId }: CreateAgentRequestContext) => {
      existingAgents.add(agentId);
    });
    const daemonA = new CreateAgentRequestStore({
      paseoHome: home,
      daemonId: "daemon-a",
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const callerA = await daemonA.run(
      scopedInput({ key: "shared-key", fingerprint: REQUEST_A, create }),
    );
    const callerB = await daemonA.run({
      ...scopedInput({ key: "shared-key", fingerprint: REQUEST_A, create }),
      callerId: "second-cli-client",
    });
    const daemonB = new CreateAgentRequestStore({
      paseoHome: home,
      daemonId: "daemon-b",
      hasAgent: async (agentId) => existingAgents.has(agentId),
    });
    const onDaemonB = await daemonB.run(
      scopedInput({ key: "shared-key", fingerprint: REQUEST_A, create }),
    );

    expect(new Set([callerA, callerB, onDaemonB]).size).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the bounded receipt count is reached", async () => {
    const store = new CreateAgentRequestStore({
      paseoHome: createHome(),
      hasAgent: async () => false,
      maxReceipts: 1,
    });
    await store.run(
      scopedInput({ key: "first-key", fingerprint: REQUEST_A, create: async () => {} }),
    );
    const secondCreate = vi.fn(async () => {});

    await expect(
      store.run(scopedInput({ key: "second-key", fingerprint: REQUEST_A, create: secondCreate })),
    ).rejects.toThrow("receipt limit of 1");
    expect(secondCreate).not.toHaveBeenCalled();
  });

  it("preserves malformed and unknown receipt data instead of rewriting it", async () => {
    const home = createHome();
    const file = path.join(home, "create-agent-requests.json");
    const raw = JSON.stringify({ version: 2, receipts: [], unknown: "preserve-me" });
    writeFileSync(file, raw);
    const store = new CreateAgentRequestStore({ paseoHome: home, hasAgent: async () => false });

    await expect(
      store.run(scopedInput({ key: "safe-key", fingerprint: REQUEST_A, create: async () => {} })),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it("preserves an oversized receipt file and rejects it before parsing", async () => {
    const home = createHome();
    const file = path.join(home, "create-agent-requests.json");
    const raw = "x".repeat(65);
    writeFileSync(file, raw);
    const store = new CreateAgentRequestStore({
      paseoHome: home,
      hasAgent: async () => false,
      maxFileBytes: 64,
    });

    await expect(
      store.run(scopedInput({ key: "safe-key", fingerprint: REQUEST_A, create: async () => {} })),
    ).rejects.toThrow("exceeds 64 bytes");
    expect(readFileSync(file, "utf8")).toBe(raw);
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
