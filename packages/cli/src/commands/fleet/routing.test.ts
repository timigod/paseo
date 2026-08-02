import { describe, expect, it } from "vitest";
import { selectFleetHost, selectFleetWorkspaceHost, type FleetHostObservation } from "./routing.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

function observed(
  host = macbook,
  overrides: Partial<Omit<FleetHostObservation, "host">> = {},
): FleetHostObservation {
  return {
    host,
    reachable: true,
    openCodeReady: true,
    agentInventoryReady: true,
    workspaceInventoryReady: true,
    activeAgents: 0,
    workspaceIds: [],
    ...overrides,
  };
}

describe("fleet routing", () => {
  it("uses the least-loaded eligible host for a new workspace", () => {
    const plan = selectFleetHost({
      observations: [observed(macbook, { activeAgents: 4 }), observed(imac, { activeAgents: 1 })],
      cwd: "/Users/timiajiboye/Code/backoffice",
      sourceHost: macbook,
      localHost: macbook,
      pinnedHost: null,
      requiresLocalContext: false,
    });

    expect(plan).toEqual({
      host: imac,
      cwd: "/Users/timi/Code/backoffice",
      reason: "least_loaded",
    });
  });

  it("routes an existing workspace to its inventory-proved owner even when full", () => {
    const plan = selectFleetWorkspaceHost({
      observations: [
        observed(macbook, { activeAgents: macbook.capacity }),
        observed(imac, { activeAgents: imac.capacity, workspaceIds: ["workspace-1"] }),
      ],
      workspaceId: "workspace-1",
      pinnedHost: null,
    });

    expect(plan).toEqual({ host: imac, reason: "workspace_owner" });
  });

  it("allows one healthy pinned owner when another inventory is unavailable", () => {
    const plan = selectFleetWorkspaceHost({
      observations: [
        observed(macbook, { workspaceInventoryReady: false }),
        observed(imac, { workspaceIds: ["workspace-1"] }),
      ],
      workspaceId: "workspace-1",
      pinnedHost: imac,
    });

    expect(plan.host).toBe(imac);
  });

  it.each([
    {
      name: "absent",
      observations: [observed(macbook), observed(imac)],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_NOT_FOUND",
    },
    {
      name: "ambiguous",
      observations: [
        observed(macbook, { workspaceIds: ["workspace-1"] }),
        observed(imac, { workspaceIds: ["workspace-1"] }),
      ],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_AMBIGUOUS",
    },
    {
      name: "owned by another host",
      observations: [observed(macbook), observed(imac, { workspaceIds: ["workspace-1"] })],
      pinnedHost: macbook,
      code: "FLEET_WORKSPACE_ON_OTHER_HOST",
    },
    {
      name: "unhealthy owner",
      observations: [
        observed(macbook),
        observed(imac, { openCodeReady: false, workspaceIds: ["workspace-1"] }),
      ],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_OWNER_UNHEALTHY",
    },
    {
      name: "unproved owner",
      observations: [
        observed(macbook, { workspaceInventoryReady: false }),
        observed(imac, { workspaceIds: ["workspace-1"] }),
      ],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_OWNER_UNPROVED",
    },
  ])("rejects $name workspace routing", ({ observations, pinnedHost, code }) => {
    expect(() =>
      selectFleetWorkspaceHost({ observations, workspaceId: "workspace-1", pinnedHost }),
    ).toThrow(expect.objectContaining({ code }));
  });
});
