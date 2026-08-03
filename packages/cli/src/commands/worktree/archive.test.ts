import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";

function createFakeDaemonClient(
  overrides: Partial<
    Pick<DaemonClient, "getPaseoWorktreeList" | "archivePaseoWorktree" | "close">
  > = {},
): DaemonClient {
  return {
    getPaseoWorktreeList: async () => ({
      worktrees: [],
      error: null,
      requestId: "req-list",
    }),
    archivePaseoWorktree: async () => ({
      success: true,
      removedAgents: [],
      error: null,
      requestId: "req-archive",
    }),
    close: async () => {},
    ...overrides,
  } as unknown as DaemonClient;
}

// NOTE: This file tests CLI routing/resolution only. The actual directory-removal
// outcome is covered by composition: workspace-archive-service.test.ts and
// worktree-session.test.ts prove real filesystem removal end-to-end.

describe("runArchiveCommand", () => {
  it("lists worktrees from the caller repository context", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return { worktrees: [], error: null, requestId: "req-list" };
      },
    });

    await expect(
      runArchiveCommandWithDeps(
        "missing",
        {},
        {
          connectToDaemon: async () => fakeClient,
          cwd: () => "/repo/project",
        },
      ),
    ).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });

    expect(listCalls).toEqual([{ cwd: "/repo/project" }]);
  });

  it("sends scope worktree when archiving by worktree path", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: ["agent-1"],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    const result = await runArchiveCommandWithDeps(
      "feature",
      {},
      {
        connectToDaemon: async () => fakeClient,
      },
      {},
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
    expect(archiveCalls[0]?.input.caller).toBeUndefined();
    expect(result).toEqual({
      type: "single",
      data: {
        name: "feature",
        status: "archived",
        removedAgents: ["agent-1"],
      },
      schema: expect.any(Object),
    });
  });

  it("sends daemon-issued caller identity from a provider environment", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const archiveCalls: Array<Parameters<DaemonClient["archivePaseoWorktree"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push(input);
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await runArchiveCommandWithDeps("feature", {}, { connectToDaemon: async () => fakeClient });

    expect(archiveCalls[0]).toEqual({ worktreePath, scope: "worktree" });
  });

  it("preserves the typed self-archive rejection code", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async () => ({
        success: false,
        removedAgents: [],
        error: { code: "UNKNOWN", message: "Agent cannot archive its own workspace" },
        errorCode: "SELF_ARCHIVE_BLOCKED",
        requestId: "req-archive",
      }),
    });

    await expect(
      runArchiveCommandWithDeps("feature", {}, { connectToDaemon: async () => fakeClient }, {}),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });
  });

  it("does not claim success when the backing directory remains", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async () => ({
        success: true,
        removedAgents: [],
        removedDirectory: false,
        cleanupPending: false,
        error: null,
        requestId: "req-archive",
      }),
    });

    await expect(
      runArchiveCommandWithDeps("feature", {}, { connectToDaemon: async () => fakeClient }),
    ).rejects.toMatchObject({ code: "WORKTREE_NOT_REMOVED" });
  });

  it("archives by matching branch name when no directory name matches", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature-branch";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature-x",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await runArchiveCommandWithDeps(
      "feature-x",
      {},
      {
        connectToDaemon: async () => fakeClient,
      },
      {},
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
  });

  it("throws a CommandError when the worktree is not found", async () => {
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [],
        error: null,
        requestId: "req-list",
      }),
    });

    await expect(
      runArchiveCommandWithDeps(
        "missing",
        {},
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });
});
