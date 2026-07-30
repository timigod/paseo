import { describe, expect, it, vi } from "vitest";
import { runFinishCommand } from "./finish.js";

const agent = {
  id: "agent-1",
  title: "Finished task",
  provider: "opencode",
  status: "idle",
  archivedAt: null,
  cwd: "/repo/.paseo/worktrees/task-a/src",
  labels: {},
};

function installClient(overrides: Record<string, unknown> = {}) {
  return {
    fetchAgent: vi.fn().mockResolvedValue({ agent }),
    fetchAgents: vi.fn().mockResolvedValue({ entries: [{ agent }] }),
    getPaseoWorktreeList: vi.fn().mockResolvedValue({
      worktrees: [{ worktreePath: "/repo/.paseo/worktrees/task-a", branchName: "task-a" }],
    }),
    archiveAgent: vi.fn().mockResolvedValue({ archivedAt: "2026-07-30T00:00:00.000Z" }),
    archivePaseoWorktree: vi.fn().mockResolvedValue({ removedAgents: [agent.id] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn().mockReturnValue("localhost:6767"),
}));

describe("runFinishCommand", () => {
  it("archives an idle task and releases its exclusively owned Paseo worktree", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const client = installClient();
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data).toMatchObject({ status: "finished", worktree: "released" });
    expect(client.archiveAgent).toHaveBeenCalledWith("agent-1");
    expect(client.archivePaseoWorktree).toHaveBeenCalledWith({
      worktreePath: "/repo/.paseo/worktrees/task-a",
      scope: "worktree",
    });
    expect(client.getPaseoWorktreeList).toHaveBeenCalledWith({
      cwd: "/repo/.paseo/worktrees/task-a/src",
    });
  });

  it("keeps a managed worktree when an unrelated active task shares it", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const other = { ...agent, id: "agent-2", cwd: "/repo/.paseo/worktrees/task-a/other" };
    const client = installClient({
      fetchAgents: vi.fn().mockResolvedValue({ entries: [{ agent }, { agent: other }] }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data.worktree).toBe("kept");
    expect(client.archivePaseoWorktree).not.toHaveBeenCalled();
  });

  it("releases the worktree when the daemon archived the agent before returning an RPC error", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const archivedAgent = { ...agent, archivedAt: "2026-07-30T00:00:00.000Z" };
    const client = installClient({
      fetchAgent: vi
        .fn()
        .mockResolvedValueOnce({ agent })
        .mockResolvedValueOnce({ agent: archivedAgent }),
      archiveAgent: vi.fn().mockRejectedValue(new Error("handler_error")),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data).toMatchObject({ status: "finished", worktree: "released" });
    expect(client.archivePaseoWorktree).toHaveBeenCalledWith({
      worktreePath: "/repo/.paseo/worktrees/task-a",
      scope: "worktree",
    });
  });

  it("retries worktree release after the agent was already archived", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const archivedAgent = { ...agent, archivedAt: "2026-07-30T00:00:00.000Z" };
    const client = installClient({
      fetchAgent: vi.fn().mockResolvedValue({ agent: archivedAgent }),
      fetchAgents: vi.fn().mockResolvedValue({ entries: [{ agent: archivedAgent }] }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data).toMatchObject({ status: "finished", worktree: "released" });
    expect(client.archiveAgent).not.toHaveBeenCalled();
    expect(client.archivePaseoWorktree).toHaveBeenCalledWith({
      worktreePath: "/repo/.paseo/worktrees/task-a",
      scope: "worktree",
    });
  });

  it("keeps a shared worktree when retrying an already archived agent", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const archivedAgent = { ...agent, archivedAt: "2026-07-30T00:00:00.000Z" };
    const other = { ...agent, id: "agent-2", cwd: "/repo/.paseo/worktrees/task-a/other" };
    const client = installClient({
      fetchAgent: vi.fn().mockResolvedValue({ agent: archivedAgent }),
      fetchAgents: vi
        .fn()
        .mockResolvedValue({ entries: [{ agent: archivedAgent }, { agent: other }] }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    const result = await runFinishCommand("agent-1", {}, {} as never);

    expect(result.data.worktree).toBe("kept");
    expect(client.archiveAgent).not.toHaveBeenCalled();
    expect(client.archivePaseoWorktree).not.toHaveBeenCalled();
  });

  it("does not finish a running task without an explicit force flag", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const client = installClient({
      fetchAgent: vi.fn().mockResolvedValue({ agent: { ...agent, status: "running" } }),
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    await expect(runFinishCommand("agent-1", {}, {} as never)).rejects.toMatchObject({
      code: "AGENT_RUNNING",
    });
    expect(client.archiveAgent).not.toHaveBeenCalled();
  });
});
