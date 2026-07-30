import { Command } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import {
  addFinishOptions,
  runFinishCommand,
  type AgentFinishOptions,
  type AgentFinishResult,
} from "../agent/finish.js";
import {
  addRecoverOptions,
  runRecoverCommand,
  type AgentRecoverOptions,
} from "../agent/recover.js";
import { type AgentReloadResult } from "../agent/reload.js";
import { FLEET_HOSTS, findFleetHost, type FleetHost } from "./topology.js";

export interface FleetAgentLocation {
  host: FleetHost;
  agentId: string;
}

export interface FleetAgentLookupFailure {
  host: FleetHost;
  error: string;
}

export interface FleetFinishOptions extends AgentFinishOptions {
  host?: string;
}

export interface FleetRecoverOptions extends AgentRecoverOptions {
  host?: string;
}

export interface FleetFinishResult extends AgentFinishResult {
  fleetHost: string;
  fleetEndpoint: string;
}

export interface FleetRecoverResult extends AgentReloadResult {
  fleetHost: string;
  fleetEndpoint: string;
}

const fleetFinishSchema: OutputSchema<FleetFinishResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "HOST", field: "fleetHost" },
    { header: "STATUS", field: "status" },
    { header: "WORKTREE", field: "worktree" },
    { header: "DETAIL", field: "detail" },
  ],
};

const fleetRecoverSchema: OutputSchema<FleetRecoverResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "HOST", field: "fleetHost" },
    { header: "STATUS", field: "status" },
    { header: "TIMELINE", field: "timelineSize" },
  ],
};

function commandError(code: string, message: string, details?: unknown): CommandError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function fleetHostsForOption(hostOption: string | undefined): readonly FleetHost[] {
  if (!hostOption?.trim()) return FLEET_HOSTS;
  const host = findFleetHost(hostOption);
  if (!host) {
    throw commandError(
      "INVALID_FLEET_HOST",
      `Unknown fleet host: ${hostOption}`,
      "Use --host macbook or --host imac.",
    );
  }
  return [host];
}

export function selectFleetAgentLocation(
  agentIdArg: string,
  matches: readonly FleetAgentLocation[],
  failures: readonly FleetAgentLookupFailure[],
): FleetAgentLocation {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw commandError(
      "FLEET_AGENT_AMBIGUOUS",
      `Agent reference ${agentIdArg} matches more than one fleet host`,
      matches.map((match) => `${match.host.id}:${match.agentId}`).join(", "),
    );
  }
  if (failures.length > 0) {
    throw commandError(
      failures.length === FLEET_HOSTS.length
        ? "FLEET_AGENT_LOOKUP_FAILED"
        : "FLEET_AGENT_LOOKUP_INCOMPLETE",
      failures.length === FLEET_HOSTS.length
        ? "Could not query any configured fleet host"
        : "Could not prove that the agent is absent because one or more fleet hosts could not be queried",
      failures.map((failure) => `${failure.host.id}: ${failure.error}`).join("; "),
    );
  }
  throw commandError(
    "AGENT_NOT_FOUND",
    `Agent not found in the Plexer fleet: ${agentIdArg}`,
    "Run paseo fleet status, then use paseo agent ls --host <endpoint> for a host-level listing.",
  );
}

async function lookupFleetAgent(
  agentIdArg: string,
  hostOption: string | undefined,
): Promise<FleetAgentLocation> {
  const hosts = fleetHostsForOption(hostOption);
  const matches: FleetAgentLocation[] = [];
  const failures: FleetAgentLookupFailure[] = [];

  await Promise.all(
    hosts.map(async (host) => {
      let client: Awaited<ReturnType<typeof connectToDaemon>> | null = null;
      try {
        client = await connectToDaemon({ host: host.endpoint, timeout: 5_000 });
        const payload = await client.fetchAgents({ filter: { includeArchived: true } });
        const agents = payload.entries.map((entry) => entry.agent) as AgentSnapshotPayload[];
        const agentId = resolveAgentId(agentIdArg, agents);
        if (agentId) matches.push({ host, agentId });
      } catch (error) {
        failures.push({
          host,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await client?.close().catch(() => {});
      }
    }),
  );

  // A host pin should report its own lookup failure rather than imply that the
  // rest of the fleet was queried.
  if (hosts.length !== FLEET_HOSTS.length && failures.length === hosts.length) {
    const failure = failures[0]!;
    throw commandError(
      "FLEET_AGENT_LOOKUP_FAILED",
      `Could not query pinned fleet host ${failure.host.id}`,
      failure.error,
    );
  }
  return selectFleetAgentLocation(agentIdArg, matches, failures);
}

function addFleetHostOption(command: Command): Command {
  return command.option("--host <host>", "Pin lookup to macbook or imac");
}

export function addFleetFinishOptions(command: Command): Command {
  return addFleetHostOption(addFinishOptions(command)).description(
    "Finish a fleet task and safely release its exclusive managed worktree",
  );
}

export function addFleetRecoverOptions(command: Command): Command {
  return addFleetHostOption(addRecoverOptions(command)).description(
    "Find and recover a preserved fleet task through its existing session",
  );
}

export async function runFleetFinishCommand(
  agentIdArg: string,
  options: FleetFinishOptions,
  command: Command,
): Promise<SingleResult<FleetFinishResult>> {
  const location = await lookupFleetAgent(agentIdArg, options.host);
  const result = await runFinishCommand(
    location.agentId,
    { ...options, host: location.host.endpoint },
    command,
  );
  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: location.host.id,
      fleetEndpoint: location.host.endpoint,
    },
    schema: fleetFinishSchema,
  };
}

export async function runFleetRecoverCommand(
  agentIdArg: string,
  options: FleetRecoverOptions,
  command: Command,
): Promise<SingleResult<FleetRecoverResult>> {
  const location = await lookupFleetAgent(agentIdArg, options.host);
  const result = await runRecoverCommand(
    location.agentId,
    { ...options, host: location.host.endpoint },
    command,
  );
  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: location.host.id,
      fleetEndpoint: location.host.endpoint,
    },
    schema: fleetRecoverSchema,
  };
}
