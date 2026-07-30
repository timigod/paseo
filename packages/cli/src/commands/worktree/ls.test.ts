import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runLsCommandWithDeps } from "./ls.js";

describe("runLsCommand", () => {
  it("scopes the daemon worktree lookup to the current repository", async () => {
    const listCalls: Array<{
      input: Parameters<DaemonClient["getPaseoWorktreeList"]>[0];
    }> = [];
    const client = {
      fetchAgents: async () => ({ entries: [] }),
      getPaseoWorktreeList: async (input: Parameters<DaemonClient["getPaseoWorktreeList"]>[0]) => {
        listCalls.push({ input });
        return {
          worktrees: [],
          error: null,
          requestId: "req-list",
        };
      },
      close: async () => {},
    } as unknown as DaemonClient;

    const result = await runLsCommandWithDeps({}, { connectToDaemon: async () => client });

    expect(listCalls).toEqual([{ input: { cwd: process.cwd() } }]);
    expect(result).toMatchObject({ type: "list", data: [] });
  });
});
