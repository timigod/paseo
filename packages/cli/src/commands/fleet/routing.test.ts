import { describe, expect, it } from "vitest";
import { selectFleetHost, selectFleetWorkspaceHost, type FleetHostObservation } from "./routing.js";
import type { FleetHost } from "./topology.js";

const builderA: FleetHost = {
  id: "builder-a",
  name: "Builder A",
  endpoint: "builder-a.internal:6767",
  codeRoot: "/srv/code",
  hostnamePrefixes: ["builder-a"],
  capacity: 8,
};
const builderB: FleetHost = {
  id: "builder-b",
  name: "Builder B",
  endpoint: "builder-b.internal:6767",
  codeRoot: "/opt/code",
  hostnamePrefixes: ["builder-b"],
  capacity: 12,
};

function observed(
  host = builderA,
  overrides: Partial<Omit<FleetHostObservation, "host">> = {},
): FleetHostObservation {
  return {
    host,
    reachable: true,
    providerReady: true,
    agentInventoryReady: true,
    workspaceInventoryReady: true,
    activeAgents: 0,
    runtimeCapacity: null,
    workspaceIds: [],
    ...overrides,
  };
}

describe("fleet routing", () => {
  it("uses the least-loaded eligible host for a new workspace", () => {
    const plan = selectFleetHost({
      observations: [
        observed(builderA, { activeAgents: 4 }),
        observed(builderB, { activeAgents: 1 }),
      ],
      cwd: "/srv/code/project",
      sourceHost: builderA,
      localHost: builderA,
      pinnedHost: null,
      requiresLocalContext: false,
      idempotencyKey: null,
    });

    expect(plan).toEqual({
      host: builderB,
      cwd: "/opt/code/project",
      reason: "least_loaded",
    });
  });

  it("prefers authoritative runtime load over legacy agent-record load", () => {
    const plan = selectFleetHost({
      observations: [
        observed(builderA, {
          activeAgents: 4,
          runtimeCapacity: { limit: 8, live: 1, reserved: 0, free: 7 },
        }),
        observed(builderB, {
          activeAgents: 1,
          runtimeCapacity: { limit: 12, live: 5, reserved: 0, free: 7 },
        }),
      ],
      cwd: "/srv/code/project",
      sourceHost: builderA,
      localHost: builderA,
      pinnedHost: null,
      requiresLocalContext: false,
      idempotencyKey: null,
    });

    expect(plan.host).toBe(builderA);
  });

  it("rejects a runtime-full host even when legacy agent inventory appears below target", () => {
    expect(() =>
      selectFleetHost({
        observations: [
          observed(builderA, {
            activeAgents: 1,
            runtimeCapacity: { limit: 6, live: 5, reserved: 1, free: 0 },
          }),
        ],
        cwd: "/srv/code/project",
        sourceHost: builderA,
        localHost: builderA,
        pinnedHost: null,
        requiresLocalContext: false,
        idempotencyKey: null,
      }),
    ).toThrow(expect.objectContaining({ code: "FLEET_NO_ELIGIBLE_HOST" }));
  });

  it("uses legacy agent records when an older daemon omits runtime capacity", () => {
    expect(() =>
      selectFleetHost({
        observations: [observed(builderA, { activeAgents: builderA.capacity })],
        cwd: "/srv/code/project",
        sourceHost: builderA,
        localHost: builderA,
        pinnedHost: null,
        requiresLocalContext: false,
        idempotencyKey: null,
      }),
    ).toThrow(expect.objectContaining({ code: "FLEET_NO_ELIGIBLE_HOST" }));
  });

  it("routes the same idempotency key to the same host when fleet load changes", () => {
    const first = selectFleetHost({
      observations: [
        observed(builderA, { activeAgents: 0 }),
        observed(builderB, { activeAgents: 4 }),
      ],
      cwd: "/srv/code/project",
      sourceHost: builderA,
      localHost: builderA,
      pinnedHost: null,
      requiresLocalContext: false,
      idempotencyKey: "fleet-create-1",
    });
    const retry = selectFleetHost({
      observations: [
        observed(builderA, { activeAgents: 4 }),
        observed(builderB, { activeAgents: 0 }),
      ],
      cwd: "/srv/code/project",
      sourceHost: builderA,
      localHost: builderA,
      pinnedHost: null,
      requiresLocalContext: false,
      idempotencyKey: "fleet-create-1",
    });

    expect(retry.host.id).toBe(first.host.id);
    expect(first.reason).toBe("idempotency_key");
    expect(retry.reason).toBe("idempotency_key");
  });

  it("rejects a host pin that contradicts deterministic keyed routing", () => {
    const unpinned = selectFleetHost({
      observations: [observed(builderA), observed(builderB)],
      cwd: "/srv/code/project",
      sourceHost: builderA,
      localHost: builderA,
      pinnedHost: null,
      requiresLocalContext: false,
      idempotencyKey: "fleet-create-1",
    });
    const contradictoryHost = unpinned.host.id === builderA.id ? builderB : builderA;

    expect(() =>
      selectFleetHost({
        observations: [observed(builderA), observed(builderB)],
        cwd: "/srv/code/project",
        sourceHost: builderA,
        localHost: builderA,
        pinnedHost: contradictoryHost,
        requiresLocalContext: false,
        idempotencyKey: "fleet-create-1",
      }),
    ).toThrow(expect.objectContaining({ code: "FLEET_KEY_HOST_CONFLICT" }));
  });

  it("routes an existing workspace to its inventory-proved owner even when full", () => {
    const plan = selectFleetWorkspaceHost({
      observations: [
        observed(builderA, { activeAgents: builderA.capacity }),
        observed(builderB, {
          activeAgents: builderB.capacity,
          workspaceIds: ["workspace-1"],
        }),
      ],
      workspaceId: "workspace-1",
      pinnedHost: null,
    });

    expect(plan).toEqual({ host: builderB, reason: "workspace_owner" });
  });

  it("rejects a pinned apparent owner while another host inventory is unavailable", () => {
    expect(() =>
      selectFleetWorkspaceHost({
        observations: [
          observed(builderA, { workspaceInventoryReady: false }),
          observed(builderB, { workspaceIds: ["workspace-1"] }),
        ],
        workspaceId: "workspace-1",
        pinnedHost: builderB,
      }),
    ).toThrow(expect.objectContaining({ code: "FLEET_WORKSPACE_OWNER_UNPROVED" }));
  });

  it.each([
    {
      name: "absent",
      observations: [observed(builderA), observed(builderB)],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_NOT_FOUND",
    },
    {
      name: "ambiguous",
      observations: [
        observed(builderA, { workspaceIds: ["workspace-1"] }),
        observed(builderB, { workspaceIds: ["workspace-1"] }),
      ],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_AMBIGUOUS",
    },
    {
      name: "owned by another host",
      observations: [observed(builderA), observed(builderB, { workspaceIds: ["workspace-1"] })],
      pinnedHost: builderA,
      code: "FLEET_WORKSPACE_ON_OTHER_HOST",
    },
    {
      name: "unhealthy owner",
      observations: [
        observed(builderA),
        observed(builderB, { providerReady: false, workspaceIds: ["workspace-1"] }),
      ],
      pinnedHost: null,
      code: "FLEET_WORKSPACE_OWNER_UNHEALTHY",
    },
    {
      name: "unproved owner",
      observations: [
        observed(builderA, { workspaceInventoryReady: false }),
        observed(builderB, { workspaceIds: ["workspace-1"] }),
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
