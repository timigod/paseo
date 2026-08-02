import type { CommandError } from "../../output/index.js";
import type { FleetHost } from "./topology.js";
import { translateFleetCwd } from "./topology.js";

export interface FleetHostObservation {
  host: FleetHost;
  reachable: boolean;
  providerReady: boolean;
  agentInventoryReady: boolean;
  workspaceInventoryReady: boolean;
  activeAgents: number;
  workspaceIds: readonly string[];
}

export type FleetRouteReason = "pinned" | "least_loaded" | "local_context" | "workspace_owner";

export interface FleetRunPlan {
  host: FleetHost;
  cwd: string;
  reason: FleetRouteReason;
}

function commandError(code: string, message: string, details?: string): CommandError {
  return { code, message, ...(details ? { details } : {}) };
}

export function selectFleetHost(input: {
  observations: readonly FleetHostObservation[];
  cwd: string;
  sourceHost: FleetHost | null;
  localHost: FleetHost | null;
  pinnedHost: FleetHost | null;
  requiresLocalContext: boolean;
}): FleetRunPlan {
  const { observations, cwd, sourceHost, localHost, pinnedHost, requiresLocalContext } = input;
  const candidates = observations.filter(
    ({ host, reachable, providerReady, agentInventoryReady, activeAgents }) => {
      if (!reachable || !providerReady || !agentInventoryReady || activeAgents >= host.capacity) {
        return false;
      }
      if (requiresLocalContext && localHost && host.id !== localHost.id) return false;
      if (!sourceHost && localHost && host.id !== localHost.id) return false;
      return true;
    },
  );

  if (pinnedHost) {
    const match = candidates.find(({ host }) => host.id === pinnedHost.id);
    if (!match) {
      throw commandError(
        "FLEET_PINNED_HOST_INELIGIBLE",
        `Pinned fleet host ${pinnedHost.id} is not eligible for this run`,
      );
    }
    return {
      host: match.host,
      cwd: sourceHost ? translateFleetCwd(cwd, sourceHost, match.host) : cwd,
      reason: "pinned",
    };
  }

  if (candidates.length === 0) {
    throw commandError("FLEET_NO_ELIGIBLE_HOST", "No healthy fleet host has capacity for this run");
  }

  const selected = [...candidates].sort(
    (left, right) =>
      left.activeAgents - right.activeAgents || left.host.id.localeCompare(right.host.id),
  )[0]!;

  return {
    host: selected.host,
    cwd: sourceHost ? translateFleetCwd(cwd, sourceHost, selected.host) : cwd,
    reason:
      requiresLocalContext || !sourceHost || (localHost && selected.host.id === localHost.id)
        ? "local_context"
        : "least_loaded",
  };
}

export function selectFleetWorkspaceHost(input: {
  observations: readonly FleetHostObservation[];
  workspaceId: string;
  pinnedHost: FleetHost | null;
}): Pick<FleetRunPlan, "host" | "reason"> {
  const workspaceId = input.workspaceId.trim();
  if (input.observations.some(({ workspaceInventoryReady }) => !workspaceInventoryReady)) {
    throw commandError(
      "FLEET_WORKSPACE_OWNER_UNPROVED",
      `Cannot prove a unique owner for workspace ${workspaceId}`,
      "Wait until every configured host has a complete workspace inventory.",
    );
  }
  const matches = input.observations.filter((observation) =>
    observation.workspaceIds.includes(workspaceId),
  );

  if (matches.length > 1) {
    throw commandError(
      "FLEET_WORKSPACE_AMBIGUOUS",
      `Workspace ${workspaceId} is present on more than one fleet host`,
      matches.map(({ host }) => host.id).join(", "),
    );
  }

  if (input.pinnedHost) {
    const match = matches[0];
    if (match && match.host.id !== input.pinnedHost.id) {
      throw commandError(
        "FLEET_WORKSPACE_ON_OTHER_HOST",
        `Workspace ${workspaceId} is owned by ${match.host.id}, not pinned host ${input.pinnedHost.id}`,
      );
    }
    if (!match) {
      throw commandError(
        "FLEET_WORKSPACE_NOT_FOUND",
        `Workspace ${workspaceId} is absent from pinned host ${input.pinnedHost.id}`,
      );
    }
    if (!match.reachable || !match.providerReady || !match.workspaceInventoryReady) {
      throw commandError(
        "FLEET_WORKSPACE_OWNER_UNHEALTHY",
        `Workspace owner ${match.host.id} is not healthy enough to run this task`,
      );
    }
    return { host: match.host, reason: "workspace_owner" };
  }

  if (matches.length === 0) {
    throw commandError(
      "FLEET_WORKSPACE_NOT_FOUND",
      `Workspace ${workspaceId} is absent from every configured fleet host`,
    );
  }

  const owner = matches[0]!;
  if (!owner.reachable || !owner.providerReady || !owner.workspaceInventoryReady) {
    throw commandError(
      "FLEET_WORKSPACE_OWNER_UNHEALTHY",
      `Workspace owner ${owner.host.id} is not healthy enough to run this task`,
    );
  }
  return { host: owner.host, reason: "workspace_owner" };
}
