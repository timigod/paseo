import { describe, expect, it, vi } from "vitest";
import { buildFleetDoctorResult, inspectFleetHost } from "./status.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;

describe("fleet status", () => {
  it("classifies pending permissions without exposing permission arguments", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.5",
        providers: [{ provider: "opencode", available: true }],
      }),
      fetchAgents: vi.fn().mockResolvedValue({
        entries: [
          {
            agent: {
              id: "agent-1",
              title: "Blocked task",
              status: "idle",
              pendingPermissions: [
                { id: "permission-1", name: "bash", input: { command: "private command" } },
              ],
            },
          },
        ],
      }),
      fetchWorkspaces: vi.fn().mockResolvedValue({
        entries: [{ id: "workspace-1" }],
        pageInfo: { nextCursor: null },
      }),
      close,
    });

    const status = await inspectFleetHost(macbook, connect);

    expect(status).toMatchObject({
      state: "needs_permission",
      activeAgents: 1,
      workspaceIds: ["workspace-1"],
      activeTasks: [
        {
          agentId: "agent-1",
          name: "Blocked task",
          status: "idle",
          state: "needs_permission",
          pendingPermissionCount: 1,
          permissionTools: ["bash"],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("private command");

    const doctor = buildFleetDoctorResult([status]);
    expect(doctor.state).toBe("needs_permission");
    expect(doctor.recommendation).toContain("permission");
    expect(JSON.stringify(doctor)).not.toContain("private command");
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails workspace inventory closed when workspace listing fails", async () => {
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.5",
        providers: [{ provider: "opencode", available: true }],
      }),
      fetchAgents: vi.fn().mockResolvedValue({ entries: [] }),
      fetchWorkspaces: vi.fn().mockRejectedValue(new Error("inventory restoring")),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await expect(inspectFleetHost(macbook, connect)).resolves.toMatchObject({
      reachable: true,
      agentInventoryReady: true,
      workspaceInventoryReady: false,
      workspaceIds: [],
      issue: expect.stringContaining("workspace inventory probe failed"),
    });
  });
});
