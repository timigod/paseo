import { describe, expect, test, vi } from "vitest";

import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  createAgentDestructiveCaller,
  createCoordinatorDestructiveCaller,
  type LiveAgentAuthority,
} from "./agent/destructive-action-authority.js";
import { killTerminalWithAuthority, killTerminalWithRecheck } from "./terminal-kill.js";

function createDependencies(options?: { beforeKill?: () => void }) {
  const terminal = {
    id: "terminal-1",
    cwd: "/tmp/workspace",
    workspaceId: "workspace-1",
  };
  const killTerminal = vi.fn();
  const terminalManager = {
    getTerminal: (terminalId: string) => (terminalId === terminal.id ? terminal : undefined),
    killTerminal,
    killTerminalAndWait: vi.fn(),
  } as unknown as TerminalManager;
  const agentAuthority: LiveAgentAuthority = {
    getAgent: (agentId) =>
      agentId === "caller"
        ? { id: agentId, cwd: terminal.cwd, workspaceId: terminal.workspaceId }
        : null,
    isCurrentAgentIncarnation: (agentId, incarnation) =>
      agentId === "caller" && incarnation === "caller-incarnation",
  };
  return {
    dependencies: {
      agentAuthority,
      terminalManager,
      ...(options?.beforeKill ? { beforeKill: options.beforeKill } : {}),
    },
    killTerminal,
  };
}

describe("authorized terminal kill", () => {
  test("blocks an agent from killing a terminal in its own workspace", async () => {
    const { dependencies, killTerminal } = createDependencies();

    await expect(
      killTerminalWithAuthority(
        dependencies,
        "terminal-1",
        createAgentDestructiveCaller({
          agentId: "caller",
          incarnation: "caller-incarnation",
        }),
      ),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });
    expect(killTerminal).not.toHaveBeenCalled();
  });

  test("rechecks authority immediately before the terminal kill", async () => {
    const { dependencies, killTerminal } = createDependencies();
    let recheckCount = 0;

    await expect(
      killTerminalWithRecheck(dependencies, "terminal-1", () => {
        recheckCount += 1;
        if (recheckCount === 2) {
          throw new Error("terminal kill authority revoked");
        }
      }),
    ).rejects.toThrow("terminal kill authority revoked");
    expect(killTerminal).not.toHaveBeenCalled();
  });

  test("allows an explicit coordinator capability", async () => {
    const { dependencies, killTerminal } = createDependencies();

    await expect(
      killTerminalWithAuthority(dependencies, "terminal-1", createCoordinatorDestructiveCaller()),
    ).resolves.toBe(true);
    expect(killTerminal).toHaveBeenCalledWith("terminal-1");
  });
});
