import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FinishAgentIdempotencyConflictError,
  FinishAgentRequestStore,
  fingerprintFinishAgentRequest,
  type FinishAgentTarget,
} from "./finish-agent-request-store.js";

const homes: string[] = [];

function createHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-finish-requests-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const TARGET: FinishAgentTarget = {
  agentId: "agent-1",
  worktreePath: "/repo/.paseo/worktrees/task-a",
  keepWorktree: false,
  force: false,
};

const FINGERPRINT = fingerprintFinishAgentRequest({
  agentId: "agent-1",
  force: false,
  keepWorktree: false,
});

function readReceipts(home: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(home, "finish-agent-requests.json"), "utf8"))
    .receipts as Array<Record<string, unknown>>;
}

describe("FinishAgentRequestStore", () => {
  it("persists the exact authorized target before any side effect runs", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    let targetOnDiskBeforeSideEffects: Record<string, unknown> | undefined;

    await store.run({
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: FINGERPRINT,
      authorize: async () => TARGET,
      execute: async (context) => {
        const receipts = readReceipts(home);
        targetOnDiskBeforeSideEffects = receipts[0]?.target as Record<string, unknown>;
        await context.markAgentArchived("2026-08-03T00:00:00.000Z");
      },
    });

    expect(targetOnDiskBeforeSideEffects).toEqual(TARGET);
  });

  it("resumes a partially completed finish from its checkpoint without re-authorizing", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    const authorize = vi.fn(async () => TARGET);

    await expect(
      store.run({
        key: "finish-agent-1",
        callerId: "cli-client",
        fingerprint: FINGERPRINT,
        authorize,
        execute: async (context) => {
          await context.markAgentArchived("2026-08-03T00:00:00.000Z");
          throw new Error("worktree release failed");
        },
      }),
    ).rejects.toThrow("worktree release failed");

    const phases: string[] = [];
    const outcome = await store.run({
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: FINGERPRINT,
      authorize,
      execute: async (context) => {
        phases.push(context.phase);
        expect(context.target).toEqual(TARGET);
        expect(context.archivedAt).toBe("2026-08-03T00:00:00.000Z");
      },
    });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["agent_archived"]);
    expect(outcome).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-08-03T00:00:00.000Z",
      worktree: "released",
    });
  });

  it("resumes across store instances after a daemon restart", async () => {
    const home = createHome();
    const first = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    await expect(
      first.run({
        key: "finish-agent-1",
        callerId: "cli-client",
        fingerprint: FINGERPRINT,
        authorize: async () => TARGET,
        execute: async (context) => {
          await context.markAgentArchived("2026-08-03T00:00:00.000Z");
          throw new Error("daemon crashed mid-finish");
        },
      }),
    ).rejects.toThrow("daemon crashed mid-finish");

    const second = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    const outcome = await second.run({
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: FINGERPRINT,
      authorize: async () => {
        throw new Error("resume must not re-authorize");
      },
      execute: async (context) => {
        expect(context.phase).toBe("agent_archived");
      },
    });
    expect(outcome.archivedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("replays a completed finish without re-running side effects when the response was lost", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    const execute = vi.fn(
      async (context: { markAgentArchived(archivedAt: string): Promise<void> }) => {
        await context.markAgentArchived("2026-08-03T00:00:00.000Z");
      },
    );
    const runInput = {
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: FINGERPRINT,
      authorize: async () => TARGET,
      execute,
    };

    const firstOutcome = await store.run(runInput);
    const replayedOutcome = await store.run({
      ...runInput,
      authorize: async () => {
        throw new Error("replay must not re-authorize");
      },
      execute: vi.fn(async () => {
        throw new Error("replay must not re-run side effects");
      }),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(replayedOutcome).toEqual(firstOutcome);
  });

  it("rejects a reused idempotency key whose request intent differs", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    await store.run({
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: FINGERPRINT,
      authorize: async () => TARGET,
      execute: async (context) => {
        await context.markAgentArchived("2026-08-03T00:00:00.000Z");
      },
    });

    await expect(
      store.run({
        key: "finish-agent-1",
        callerId: "cli-client",
        fingerprint: fingerprintFinishAgentRequest({
          agentId: "agent-1",
          force: true,
          keepWorktree: false,
        }),
        authorize: async () => ({ ...TARGET, force: true }),
        execute: async () => {},
      }),
    ).rejects.toBeInstanceOf(FinishAgentIdempotencyConflictError);
  });

  it("keeps no durable receipt when authorization refuses the finish", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    await expect(
      store.run({
        key: "finish-agent-1",
        callerId: "cli-client",
        fingerprint: FINGERPRINT,
        authorize: async () => {
          throw new Error("agent is still running");
        },
        execute: async () => {},
      }),
    ).rejects.toThrow("agent is still running");

    // A refused request left no side effects, so a corrected retry with a
    // different intent must not hit an idempotency conflict.
    const outcome = await store.run({
      key: "finish-agent-1",
      callerId: "cli-client",
      fingerprint: fingerprintFinishAgentRequest({
        agentId: "agent-1",
        force: true,
        keepWorktree: false,
      }),
      authorize: async () => ({ ...TARGET, force: true }),
      execute: async (context) => {
        await context.markAgentArchived("2026-08-03T00:00:00.000Z");
      },
    });
    expect(outcome.worktree).toBe("released");
  });

  it("scopes receipts by caller so different callers cannot replay each other", async () => {
    const home = createHome();
    const store = new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
    await store.run({
      key: "finish-agent-1",
      callerId: "cli-client-a",
      fingerprint: FINGERPRINT,
      authorize: async () => TARGET,
      execute: async (context) => {
        await context.markAgentArchived("2026-08-03T00:00:00.000Z");
      },
    });

    const authorize = vi.fn(async () => ({ ...TARGET, worktreePath: null }));
    const outcome = await store.run({
      key: "finish-agent-1",
      callerId: "cli-client-b",
      fingerprint: FINGERPRINT,
      authorize,
      execute: async (context) => {
        await context.markAgentArchived("2026-08-03T01:00:00.000Z");
      },
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(outcome.worktree).toBe("not_paseo_owned");
  });
});
