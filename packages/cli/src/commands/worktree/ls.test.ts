import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runLsCommandWithDeps } from "./ls.js";

describe("runLsCommand", () => {
  it("lists worktrees from the caller repository context", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const client = {
      fetchAgents: vi.fn().mockResolvedValue({ entries: [] }),
      getPaseoWorktreeList: vi.fn(async (input) => {
        listCalls.push(input);
        return { worktrees: [], error: null, requestId: "req-list" };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaemonClient;

    const result = await runLsCommandWithDeps(
      {},
      { connectToDaemon: async () => client, cwd: () => "/repo/project" },
    );

    expect(listCalls).toEqual([{ cwd: "/repo/project" }]);
    expect(result).toMatchObject({ type: "list", data: [] });
    expect(client.close).toHaveBeenCalledOnce();
  });
});
