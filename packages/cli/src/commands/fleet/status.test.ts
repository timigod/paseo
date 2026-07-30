import { describe, expect, it, vi } from "vitest";
import { diagnoseFleet, inspectFleetHost, type FleetHostStatus } from "./status.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;

describe("fleet status", () => {
  it("reports provider readiness and counts every non-terminal agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.8",
        providers: [{ provider: "opencode", available: true }],
      }),
      fetchAgents: vi.fn().mockResolvedValue({
        entries: [
          { agent: { status: "initializing" } },
          { agent: { status: "running" } },
          { agent: { status: "idle" } },
          { agent: { status: "completed" } },
          { agent: { status: "archived" } },
        ],
      }),
      close,
    });

    await expect(inspectFleetHost(macbook, connect)).resolves.toMatchObject({
      reachable: true,
      openCodeReady: true,
      activeAgents: 3,
      freeSlots: 7,
      statusCounts: { initializing: 1, running: 1, idle: 1, completed: 1, archived: 1 },
      issue: null,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns a usable degraded status when a daemon cannot be reached", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(inspectFleetHost(macbook, connect)).resolves.toMatchObject({
      reachable: false,
      openCodeReady: false,
      activeAgents: 0,
      issue: "connection reset",
    });
  });

  it("names the exact no-dispatch conditions for doctor output", () => {
    const statuses: FleetHostStatus[] = [
      {
        id: "macbook",
        name: "MacBook",
        endpoint: macbook.endpoint,
        capacity: 10,
        reachable: true,
        version: "0.2.8",
        openCodeReady: false,
        activeAgents: 11,
        freeSlots: 0,
        statusCounts: {},
        issue: "provider overloaded",
      },
      {
        id: "imac",
        name: "iMac",
        endpoint: "imac.tail24bbb3.ts.net:6767",
        capacity: 10,
        reachable: false,
        version: null,
        openCodeReady: false,
        activeAgents: 0,
        freeSlots: 0,
        statusCounts: {},
        issue: "connection reset",
      },
    ];

    expect(diagnoseFleet(statuses)).toEqual([
      "MacBook cannot serve OpenCode: provider overloaded",
      "MacBook is over capacity (11/10)",
      "iMac is unreachable: connection reset",
    ]);
  });
});
