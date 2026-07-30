import { describe, expect, it } from "vitest";
import { selectFleetHost, type FleetHostObservation } from "./routing.js";
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
    inventoryReady: true,
    activeAgents: 0,
    ...overrides,
  };
}

describe("fleet routing", () => {
  it("uses the least-loaded healthy host and translates a known source cwd", () => {
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

  it("honours a healthy explicit pin instead of silently falling back", () => {
    const plan = selectFleetHost({
      observations: [observed(macbook, { activeAgents: 0 }), observed(imac, { activeAgents: 5 })],
      cwd: "/Users/timiajiboye/Code/paseo",
      sourceHost: macbook,
      localHost: macbook,
      pinnedHost: imac,
      requiresLocalContext: false,
    });

    expect(plan.host).toBe(imac);
    expect(plan.reason).toBe("pinned");
  });

  it("refuses an unavailable pinned host instead of silently bypassing it", () => {
    expect(() =>
      selectFleetHost({
        observations: [observed(macbook), observed(imac, { reachable: false })],
        cwd: "/Users/timiajiboye/Code/paseo",
        sourceHost: macbook,
        localHost: macbook,
        pinnedHost: imac,
        requiresLocalContext: false,
      }),
    ).toThrow(/Pinned fleet host imac is not eligible/);
  });

  it("keeps ambient agent/workspace state on its owning host", () => {
    const plan = selectFleetHost({
      observations: [observed(macbook, { activeAgents: 5 }), observed(imac)],
      cwd: "/Users/timiajiboye/Code/paseo",
      sourceHost: macbook,
      localHost: macbook,
      pinnedHost: null,
      requiresLocalContext: true,
    });

    expect(plan).toEqual({
      host: macbook,
      cwd: "/Users/timiajiboye/Code/paseo",
      reason: "local_context",
    });
  });

  it("never uses a full or provider-unready host", () => {
    expect(() =>
      selectFleetHost({
        observations: [
          observed(macbook, { activeAgents: macbook.capacity }),
          observed(imac, { openCodeReady: false }),
        ],
        cwd: "/Users/timiajiboye/Code/paseo",
        sourceHost: macbook,
        localHost: macbook,
        pinnedHost: null,
        requiresLocalContext: false,
      }),
    ).toThrow(/No healthy fleet host has capacity/);
  });

  it("never dispatches to a reachable host whose inventory is still restoring", () => {
    expect(() =>
      selectFleetHost({
        observations: [
          observed(macbook, { inventoryReady: false }),
          observed(imac, { reachable: false }),
        ],
        cwd: "/Users/timiajiboye/Code/paseo",
        sourceHost: macbook,
        localHost: macbook,
        pinnedHost: null,
        requiresLocalContext: false,
      }),
    ).toThrow(/No healthy fleet host has capacity/);
  });
});
