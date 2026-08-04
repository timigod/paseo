import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FINISH_AGENT_ERROR_CODES,
  FinishAgentRefusedError,
  runFinishAgentCommand,
  type FinishAgentDependencies,
  type FinishAgentLiveView,
  type FinishAgentStoredView,
} from "./finish-agent.js";
import {
  FinishAgentIdempotencyConflictError,
  FinishAgentRequestStore,
} from "./finish-agent-request-store.js";

const homes: string[] = [];

function createStore(): FinishAgentRequestStore {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-finish-agent-"));
  homes.push(home);
  return new FinishAgentRequestStore({ paseoHome: home, daemonId: "daemon-1" });
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const WORKTREE = "/repo/.paseo/worktrees/task-a";

interface HarnessOverrides {
  live?: FinishAgentLiveView | null;
  stored?: FinishAgentStoredView | null;
  otherAgentCwds?: string[];
  otherWorkspaceCwds?: string[];
  worktrees?: string[];
  dirty?: boolean | null;
  worktreePresent?: boolean;
}

function createDependencies(overrides: HarnessOverrides = {}) {
  const stored: FinishAgentStoredView | null =
    overrides.stored !== undefined
      ? overrides.stored
      : {
          cwd: path.join(WORKTREE, "src"),
          workspaceId: "workspace-1",
          archivedAt: null,
          lastStatus: "idle",
          requiresAttention: false,
        };
  const state = { stored };
  const archiveAgent = vi.fn(async () => {
    state.stored = state.stored
      ? { ...state.stored, archivedAt: "2026-08-03T00:00:00.000Z" }
      : state.stored;
    return { archivedAt: "2026-08-03T00:00:00.000Z" };
  });
  const releaseWorktree = vi.fn(async () => {});
  const dependencies: FinishAgentDependencies = {
    store: createStore(),
    getLiveAgent: () => (overrides.live !== undefined ? overrides.live : null),
    getStoredAgent: async () => state.stored,
    listOtherActiveAgentCwds: async () => overrides.otherAgentCwds ?? [],
    listOtherActiveWorkspaceCwds: async () => overrides.otherWorkspaceCwds ?? [],
    listPaseoWorktrees: async () => overrides.worktrees ?? [WORKTREE],
    isWorktreeDirty: async () => overrides.dirty ?? false,
    worktreeStillPresent: async () => overrides.worktreePresent ?? true,
    archiveAgent,
    releaseWorktree,
  };
  return { dependencies, archiveAgent, releaseWorktree, state };
}

function input(overrides: Partial<Parameters<typeof runFinishAgentCommand>[1]> = {}) {
  return {
    agentId: "agent-1",
    idempotencyKey: "finish-agent-1",
    callerId: "cli-client",
    force: false,
    keepWorktree: false,
    ...overrides,
  };
}

describe("runFinishAgentCommand", () => {
  it("archives the agent and releases its exclusively owned worktree", async () => {
    const { dependencies, archiveAgent, releaseWorktree } = createDependencies();

    const outcome = await runFinishAgentCommand(dependencies, input());

    expect(outcome).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-08-03T00:00:00.000Z",
      worktree: "released",
    });
    expect(archiveAgent).toHaveBeenCalledTimes(1);
    expect(releaseWorktree).toHaveBeenCalledWith(WORKTREE);
  });

  it("refuses a running agent without force and proceeds with force", async () => {
    const running: FinishAgentLiveView = {
      cwd: path.join(WORKTREE, "src"),
      workspaceId: "workspace-1",
      running: true,
      requiresAttention: false,
      pendingPermissionCount: 0,
    };
    const refused = createDependencies({ live: running });
    await expect(runFinishAgentCommand(refused.dependencies, input())).rejects.toMatchObject({
      name: "FinishAgentRefusedError",
      code: FINISH_AGENT_ERROR_CODES.agentRunning,
    });
    expect(refused.archiveAgent).not.toHaveBeenCalled();
    expect(refused.releaseWorktree).not.toHaveBeenCalled();

    const forced = createDependencies({ live: running });
    const outcome = await runFinishAgentCommand(forced.dependencies, input({ force: true }));
    expect(outcome.worktree).toBe("released");
    expect(forced.archiveAgent).toHaveBeenCalledTimes(1);
  });

  it("accepts finished attention but refuses pending permissions without force", async () => {
    const finishedAttention = createDependencies({
      live: {
        cwd: path.join(WORKTREE, "src"),
        workspaceId: "workspace-1",
        running: false,
        requiresAttention: true,
        pendingPermissionCount: 0,
      },
    });
    await expect(runFinishAgentCommand(finishedAttention.dependencies, input())).resolves.toEqual({
      agentId: "agent-1",
      archivedAt: "2026-08-03T00:00:00.000Z",
      worktree: "released",
    });

    const blocked = createDependencies({
      live: {
        cwd: path.join(WORKTREE, "src"),
        workspaceId: "workspace-1",
        running: false,
        requiresAttention: false,
        pendingPermissionCount: 2,
      },
    });
    await expect(runFinishAgentCommand(blocked.dependencies, input())).rejects.toMatchObject({
      code: FINISH_AGENT_ERROR_CODES.unconsumedWork,
    });

    const storedFinishedAttention = createDependencies({
      stored: {
        cwd: path.join(WORKTREE, "src"),
        workspaceId: "workspace-1",
        archivedAt: null,
        lastStatus: "idle",
        requiresAttention: true,
      },
    });
    await expect(
      runFinishAgentCommand(storedFinishedAttention.dependencies, input()),
    ).resolves.toMatchObject({ agentId: "agent-1", worktree: "released" });
  });

  it("refuses to release a dirty worktree", async () => {
    const { dependencies, archiveAgent } = createDependencies({ dirty: true });
    await expect(runFinishAgentCommand(dependencies, input())).rejects.toMatchObject({
      code: FINISH_AGENT_ERROR_CODES.worktreeDirty,
    });
    expect(archiveAgent).not.toHaveBeenCalled();
  });

  it("refuses to release a worktree shared with another active agent or workspace", async () => {
    const sharedAgent = createDependencies({
      otherAgentCwds: [path.join(WORKTREE, "other")],
    });
    await expect(runFinishAgentCommand(sharedAgent.dependencies, input())).rejects.toMatchObject({
      code: FINISH_AGENT_ERROR_CODES.worktreeShared,
    });

    const sharedWorkspace = createDependencies({
      otherWorkspaceCwds: [path.join(WORKTREE, "nested")],
    });
    await expect(
      runFinishAgentCommand(sharedWorkspace.dependencies, input()),
    ).rejects.toMatchObject({ code: FINISH_AGENT_ERROR_CODES.worktreeShared });
    expect(sharedWorkspace.archiveAgent).not.toHaveBeenCalled();
  });

  it("keep-worktree archives the agent and bypasses worktree release and its safety checks", async () => {
    const { dependencies, archiveAgent, releaseWorktree } = createDependencies({
      dirty: true,
      otherAgentCwds: [path.join(WORKTREE, "other")],
    });

    const outcome = await runFinishAgentCommand(dependencies, input({ keepWorktree: true }));

    expect(outcome.worktree).toBe("kept");
    expect(archiveAgent).toHaveBeenCalledTimes(1);
    expect(releaseWorktree).not.toHaveBeenCalled();
  });

  it("reports not_paseo_owned when no Paseo worktree contains the agent cwd", async () => {
    const { dependencies, releaseWorktree } = createDependencies({ worktrees: [] });
    const outcome = await runFinishAgentCommand(dependencies, input());
    expect(outcome.worktree).toBe("not_paseo_owned");
    expect(releaseWorktree).not.toHaveBeenCalled();
  });

  it("finishes an already archived agent idempotently and still releases the worktree", async () => {
    const { dependencies, archiveAgent, releaseWorktree } = createDependencies({
      stored: {
        cwd: path.join(WORKTREE, "src"),
        workspaceId: "workspace-1",
        archivedAt: "2026-08-01T00:00:00.000Z",
        lastStatus: "closed",
        requiresAttention: false,
      },
    });

    const outcome = await runFinishAgentCommand(dependencies, input());

    expect(outcome.archivedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(outcome.worktree).toBe("released");
    expect(archiveAgent).not.toHaveBeenCalled();
    expect(releaseWorktree).toHaveBeenCalledTimes(1);
  });

  it("retries a partially completed finish without repeating the archive side effect", async () => {
    const { dependencies, archiveAgent, releaseWorktree } = createDependencies();
    releaseWorktree.mockRejectedValueOnce(new Error("worktree release failed"));

    await expect(runFinishAgentCommand(dependencies, input())).rejects.toThrow(
      "worktree release failed",
    );
    const outcome = await runFinishAgentCommand(dependencies, input());

    expect(outcome.worktree).toBe("released");
    expect(archiveAgent).toHaveBeenCalledTimes(1);
    expect(releaseWorktree).toHaveBeenCalledTimes(2);
  });

  it("treats an already removed worktree as released when resuming", async () => {
    const { dependencies, releaseWorktree } = createDependencies({ worktreePresent: false });
    const outcome = await runFinishAgentCommand(dependencies, input());
    expect(outcome.worktree).toBe("released");
    expect(releaseWorktree).not.toHaveBeenCalled();
  });

  it("replays a completed finish for the same idempotent request without new side effects", async () => {
    const { dependencies, archiveAgent, releaseWorktree } = createDependencies();

    const first = await runFinishAgentCommand(dependencies, input());
    const replay = await runFinishAgentCommand(dependencies, input());

    expect(replay).toEqual(first);
    expect(archiveAgent).toHaveBeenCalledTimes(1);
    expect(releaseWorktree).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting intent on a reused idempotency key", async () => {
    const { dependencies } = createDependencies();
    await runFinishAgentCommand(dependencies, input());
    await expect(
      runFinishAgentCommand(dependencies, input({ keepWorktree: true })),
    ).rejects.toBeInstanceOf(FinishAgentIdempotencyConflictError);
  });

  it("refuses an unknown agent", async () => {
    const { dependencies } = createDependencies({ stored: null, live: null });
    await expect(runFinishAgentCommand(dependencies, input())).rejects.toMatchObject({
      code: FINISH_AGENT_ERROR_CODES.agentNotFound,
    });
  });

  it("throws typed refusals", async () => {
    const { dependencies } = createDependencies({ dirty: true });
    const error = await runFinishAgentCommand(dependencies, input()).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FinishAgentRefusedError);
  });
});
