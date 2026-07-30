import type { FleetHost } from "./topology.js";
import { translateFleetCwd } from "./topology.js";

export interface FleetHostObservation {
  host: FleetHost;
  reachable: boolean;
  openCodeReady: boolean;
  activeAgents: number;
}

export type FleetRouteReason = "pinned" | "least_loaded" | "local_context";

export interface FleetRunPlan {
  host: FleetHost;
  cwd: string;
  reason: FleetRouteReason;
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
  const candidates = observations.filter(({ host, reachable, openCodeReady, activeAgents }) => {
    if (!reachable || !openCodeReady || activeAgents >= host.capacity) return false;
    if (requiresLocalContext && localHost && host.id !== localHost.id) return false;
    if (!sourceHost && localHost && host.id !== localHost.id) return false;
    return true;
  });

  if (pinnedHost) {
    const match = candidates.find(({ host }) => host.id === pinnedHost.id);
    if (!match) {
      throw new Error(`Pinned fleet host ${pinnedHost.id} is not eligible for this run`);
    }
    return {
      host: match.host,
      cwd: sourceHost ? translateFleetCwd(cwd, sourceHost, match.host) : cwd,
      reason: "pinned",
    };
  }

  if (candidates.length === 0) {
    throw new Error("No healthy fleet host has capacity for this run");
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
