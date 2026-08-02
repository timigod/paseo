import { describe, expect, it, vi } from "vitest";
import { runFinishCommand } from "./finish.js";

const agent = {
  id: "agent-1",
  title: "Finished task",
  provider: "opencode",
  status: "idle",
  archivedAt: null,
  workspaceId: "workspace-1",
  cwd: "/repo/.paseo/worktrees/task-a/src",
  labels: {},
};

function installClient(overrides: Record<string, unknown> = {}) {
  const archivedAgent = { ...agent, archivedAt: "2026-07-30T00:00:00.000Z" };
  return {
    fetchAgent: vi
      .fn()
      .mockResolvedValueOnce({ agent })
      .mockResolvedValue({ agent: archivedAgent }),
    fetchAgents: vi.fn().mockResolvedValue({
      entries: [{ agent }],
      pageInfo: { nextCursor: null, hasMore: false },
    }),
    fetchWorkspaces: vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }),
    getPaseoWorktreeList: vi.fn().mockResolvedValue({
      worktrees: [{ worktreePath: "/repo/.paseo/worktrees/task-a", branchName: "task-a" }],
      error: null,
    }),
    archiveAgent: vi.fn().mockResolvedValue({ archivedAt: archivedAgent.archivedAt }),
    archivePaseoWorktree: vi.fn().mockResolvedValue({ success: true, removedAgents: [agent.id] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn().mockReturnValue("localhost:6767"),
}));

describe("runFinishCommand", () => {
  it("verifies the agent archive and exclusive workspace release before reporting success", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const client = installClient();
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data).toMatchObject({
      status: "finished",
      agent: "archived",
      workspace: "released",
      worktree: "released",
    });
    expect(client.archivePaseoWorktree).toHaveBeenCalledWith({
      worktreePath: "/repo/.paseo/worktrees/task-a",
      scope: "worktree",
    });
    expect(client.fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-1" },
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200 },
    });
  });

  it("does not release a workspace when agent archival is not proved", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const client = installClient({
      fetchAgent: vi.fn().mockResolvedValue({ agent }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    await expect(runFinishCommand("agent-1", {}, {} as never)).rejects.toMatchObject({
      code: "FINISH_POSTCONDITION_FAILED",
      details: expect.objectContaining({
        agent: "not_archived",
        workspace: "not_attempted",
        retry: expect.any(String),
        recovery: expect.any(String),
      }),
    });
    expect(client.archivePaseoWorktree).not.toHaveBeenCalled();
  });

  it("keeps a worktree when another active workspace shares it without an agent", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: index === 0 ? "workspace-1" : `workspace-${index + 1}`,
      workspaceDirectory:
        index === 0 ? "/repo/.paseo/worktrees/task-a/src" : `/other/workspace-${index + 1}`,
    }));
    const fetchWorkspaces = vi
      .fn()
      .mockImplementation(({ page }: { page: { cursor?: string } }) => {
        if (page.cursor === "page-2") {
          return Promise.resolve({
            entries: [
              {
                id: "workspace-shared",
                workspaceDirectory: "/repo/.paseo/worktrees/task-a/other",
              },
            ],
            pageInfo: { nextCursor: null, hasMore: false },
          });
        }
        return Promise.resolve({
          entries: firstPage,
          pageInfo: { nextCursor: "page-2", hasMore: true },
        });
      });
    const client = installClient({ fetchWorkspaces });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data).toMatchObject({
      status: "finished",
      agent: "archived",
      workspace: "kept",
      worktree: "not-paseo-owned",
    });
    expect(fetchWorkspaces).toHaveBeenNthCalledWith(1, {
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200 },
    });
    expect(fetchWorkspaces).toHaveBeenNthCalledWith(2, {
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200, cursor: "page-2" },
    });
    expect(client.archivePaseoWorktree).not.toHaveBeenCalled();
  });

  it("reports a residual workspace instead of claiming finish succeeded", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const client = installClient({
      fetchWorkspaces: vi.fn().mockResolvedValue({
        entries: [{ id: "workspace-1" }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    await expect(runFinishCommand("agent-1", {}, {} as never)).rejects.toMatchObject({
      code: "FINISH_POSTCONDITION_FAILED",
      details: expect.objectContaining({
        agent: "archived",
        workspace: "still_present",
        retry: expect.any(String),
        recovery: expect.any(String),
      }),
    });
  });
});
