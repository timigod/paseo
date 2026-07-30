import { Command } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
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
import {
  addSendOptions,
  resolveSendPromptInput,
  runSendCommand,
  type AgentSendOptions,
  type AgentSendResult,
} from "../agent/send.js";
import { FLEET_HOSTS, findFleetHost, type FleetHost } from "./topology.js";

export interface FleetAgentLocation {
  host: FleetHost;
  agentId: string;
  archived: boolean;
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

export interface FleetContinueOptions extends AgentSendOptions {
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

export interface FleetContinueResult extends AgentSendResult {
  fleetHost: string;
  fleetEndpoint: string;
  restored: boolean;
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

const fleetContinueSchema: OutputSchema<FleetContinueResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "HOST", field: "fleetHost" },
    { header: "STATUS", field: "status" },
    { header: "RESTORED", field: (result) => (result.restored ? "yes" : "no") },
    { header: "MESSAGE", field: "message" },
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
      "Use a host id or endpoint shown by paseo fleet status.",
    );
  }
  return [host];
}

export function selectFleetAgentLocation(
  agentIdArg: string,
  matches: readonly FleetAgentLocation[],
  failures: readonly FleetAgentLookupFailure[],
  queriedHostCount = FLEET_HOSTS.length,
): FleetAgentLocation {
  if (failures.length > 0) {
    throw commandError(
      failures.length === queriedHostCount
        ? "FLEET_AGENT_LOOKUP_FAILED"
        : "FLEET_AGENT_LOOKUP_INCOMPLETE",
      failures.length === queriedHostCount
        ? "Could not query any configured fleet host"
        : "Could not prove that the agent is absent because one or more fleet hosts could not be queried",
      failures.map((failure) => `${failure.host.id}: ${failure.error}`).join("; "),
    );
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw commandError(
      "FLEET_AGENT_AMBIGUOUS",
      `Agent reference ${agentIdArg} matches more than one fleet task`,
      matches.map((match) => `${match.host.id}:${match.agentId}`).join(", "),
    );
  }
  throw commandError(
    "AGENT_NOT_FOUND",
    `Agent not found in the Plexer fleet: ${agentIdArg}`,
    "Run paseo fleet status, then use paseo agent ls --host <endpoint> for a host-level listing.",
  );
}

export function findFleetAgentMatches(
  agentIdArg: string,
  host: FleetHost,
  agents: readonly AgentSnapshotPayload[],
): FleetAgentLocation[] {
  const query = agentIdArg.trim().toLowerCase();
  if (!query) return [];

  const exactIdMatches = agents.filter((agent) => agent.id.toLowerCase() === query);
  const candidates =
    exactIdMatches.length > 0
      ? exactIdMatches
      : agents.filter((agent) => {
          const title = agent.title?.toLowerCase();
          return agent.id.toLowerCase().startsWith(query) || title === query;
        });

  return candidates.map((agent) => ({
    host,
    agentId: agent.id,
    archived: Boolean(agent.archivedAt),
  }));
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
        matches.push(...findFleetAgentMatches(agentIdArg, host, agents));
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
  return selectFleetAgentLocation(
    agentIdArg,
    matches.sort(
      (left, right) =>
        left.host.id.localeCompare(right.host.id) || left.agentId.localeCompare(right.agentId),
    ),
    failures.sort((left, right) => left.host.id.localeCompare(right.host.id)),
    hosts.length,
  );
}

function addFleetHostOption(command: Command): Command {
  return command.option("--host <host>", "Pin lookup to a configured fleet host id or endpoint");
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

export function addFleetContinueOptions(command: Command): Command {
  return addFleetHostOption(addSendOptions(command)).description(
    "Find a preserved fleet task and send its next prompt on the owning host",
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

interface FleetContinueActions {
  recover: (agentId: string, options: AgentRecoverOptions, command: Command) => Promise<unknown>;
  send: (
    agentId: string,
    prompt: string | undefined,
    options: AgentSendOptions,
    command: Command,
  ) => Promise<SingleResult<AgentSendResult>>;
}

export async function continueFleetAgent(
  location: FleetAgentLocation,
  prompt: string | undefined,
  options: FleetContinueOptions,
  command: Command,
  actions: FleetContinueActions = { recover: runRecoverCommand, send: runSendCommand },
): Promise<SingleResult<FleetContinueResult>> {
  const promptInput = await resolveSendPromptInput({
    promptArgument: prompt,
    promptOption: options.prompt,
    promptFile: options.promptFile,
  });
  const { prompt: _promptOption, promptFile: _promptFile, ...sendOptions } = options;

  if (location.archived) {
    await actions.recover(location.agentId, { ...options, host: location.host.endpoint }, command);
  }
  const result = await actions.send(
    location.agentId,
    promptInput,
    { ...sendOptions, host: location.host.endpoint },
    command,
  );
  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: location.host.id,
      fleetEndpoint: location.host.endpoint,
      restored: location.archived,
    },
    schema: fleetContinueSchema,
  };
}

export async function runFleetContinueCommand(
  agentIdArg: string,
  prompt: string | undefined,
  options: FleetContinueOptions,
  command: Command,
): Promise<SingleResult<FleetContinueResult>> {
  const location = await lookupFleetAgent(agentIdArg, options.host);
  return continueFleetAgent(location, prompt, options, command);
}
