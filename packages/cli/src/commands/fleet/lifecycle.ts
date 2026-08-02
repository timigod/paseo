import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { CommandError } from "../../output/index.js";
import type { FleetHost } from "./topology.js";

export interface FleetAgentMatch {
  host: FleetHost;
  agentId: string;
  archived: boolean;
}

export interface FleetAgentLookupFailure {
  host: FleetHost;
  error: string;
}

export function findFleetAgentMatches(
  query: string,
  host: FleetHost,
  agents: readonly AgentSnapshotPayload[],
): FleetAgentMatch[] {
  const exact = agents.filter(({ id }) => id === query);
  const matches =
    exact.length > 0
      ? exact
      : agents.filter(
          ({ id, title }) => id.startsWith(query) || title?.toLowerCase() === query.toLowerCase(),
        );
  return matches.map((agent) => ({
    host,
    agentId: agent.id,
    archived: Boolean(agent.archivedAt),
  }));
}

export function selectFleetAgentLocation(
  query: string,
  matches: readonly FleetAgentMatch[],
  failures: readonly FleetAgentLookupFailure[],
): FleetAgentMatch {
  if (failures.length > 0) {
    throw {
      code: "FLEET_AGENT_LOOKUP_INCOMPLETE",
      message: `Cannot prove a unique owner for agent ${query}`,
      details: failures.map(({ host, error }) => `${host.id}: ${error}`).join("; "),
    } satisfies CommandError;
  }
  const exact = matches.filter(({ agentId }) => agentId === query);
  const candidates = exact.length > 0 ? exact : matches;
  if (candidates.length === 0) {
    throw {
      code: "FLEET_AGENT_NOT_FOUND",
      message: `Agent ${query} was not found on the inspected fleet hosts`,
    } satisfies CommandError;
  }
  if (candidates.length > 1) {
    throw {
      code: "FLEET_AGENT_AMBIGUOUS",
      message: `Agent ${query} matches more than one fleet agent`,
      details: candidates.map(({ host, agentId }) => `${host.id}:${agentId}`).join(", "),
    } satisfies CommandError;
  }
  return candidates[0]!;
}
