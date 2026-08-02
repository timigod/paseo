import os from "node:os";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { withOutput } from "../../output/index.js";
import type { CommandError, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import {
  addRunOptions,
  runRunCommand,
  type AgentRunOptions,
  type AgentRunResult,
} from "../agent/run.js";
import {
  addFinishOptions,
  runFinishCommand,
  type AgentFinishOptions,
  type AgentFinishResult,
} from "../agent/finish.js";
import { findFleetAgentMatches, selectFleetAgentLocation } from "./lifecycle.js";
import { selectFleetHost, selectFleetWorkspaceHost, type FleetRouteReason } from "./routing.js";
import { buildFleetDoctorResult, collectFleetStatus, type FleetHostStatus } from "./status.js";
import {
  FLEET_DEFAULT_THINKING,
  FLEET_HOSTS,
  findFleetHost,
  findFleetHostForCwd,
  findFleetHostForHostname,
} from "./topology.js";
import {
  resolveFleetProviderModelOptions,
  resolveFleetRunPrompt,
  resolveFleetWorktreeBase,
} from "./run.js";

interface FleetRunOptions extends AgentRunOptions {
  host?: string;
  prompt?: string;
  promptFile?: string;
}

interface FleetRunResult extends AgentRunResult {
  fleetHost: string;
  fleetEndpoint: string;
  routeReason: FleetRouteReason;
  effectiveModel: string | undefined;
  effectiveThinking: string;
}

const fleetStatusSchema: OutputSchema<FleetHostStatus> = {
  idField: (status) => status.host.id,
  columns: [
    { header: "HOST", field: (status) => status.host.name },
    { header: "STATE", field: "state" },
    { header: "ACTIVE", field: "activeAgents", align: "right" },
    {
      header: "PERMISSIONS",
      field: (status) =>
        status.activeTasks.reduce((count, task) => count + task.pendingPermissionCount, 0),
      align: "right",
    },
    { header: "DETAIL", field: (status) => status.issue ?? "healthy" },
  ],
};

const fleetRunSchema: OutputSchema<FleetRunResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "HOST", field: "fleetHost" },
    { header: "ROUTE", field: "routeReason" },
    { header: "STATUS", field: "status" },
    { header: "MODEL", field: (result) => result.effectiveModel ?? "default" },
  ],
};

function requireFleetHost(value: string | undefined) {
  if (!value) return null;
  const host = findFleetHost(value);
  if (!host) {
    throw {
      code: "INVALID_FLEET_HOST",
      message: `Unknown fleet host: ${value}`,
      details: "Use --host macbook or --host imac.",
    } satisfies CommandError;
  }
  return host;
}

async function runFleetStatusCommand(): Promise<ListResult<FleetHostStatus>> {
  return { type: "list", data: await collectFleetStatus(), schema: fleetStatusSchema };
}

async function runFleetDoctorCommand(): Promise<
  SingleResult<ReturnType<typeof buildFleetDoctorResult>>
> {
  const result = buildFleetDoctorResult(await collectFleetStatus());
  return {
    type: "single",
    data: result,
    schema: {
      idField: () => "fleet",
      columns: [
        { header: "STATE", field: "state" },
        { header: "RECOMMENDATION", field: "recommendation" },
      ],
    },
  };
}

async function runFleetRunCommand(
  positionalPrompt: string | undefined,
  options: FleetRunOptions,
  command: Command,
): Promise<SingleResult<FleetRunResult>> {
  const prompt = await resolveFleetRunPrompt(positionalPrompt, options);
  const pinnedHost = requireFleetHost(options.host);
  const statuses = await collectFleetStatus();
  const workspaceId = options.workspace ?? process.env.PASEO_WORKSPACE_ID;
  const cwd = options.cwd ?? process.cwd();
  const sourceHost = findFleetHostForCwd(cwd);
  const localHost = findFleetHostForHostname(os.hostname());
  const plan = workspaceId
    ? {
        ...selectFleetWorkspaceHost({
          observations: statuses,
          workspaceId,
          pinnedHost,
        }),
        cwd,
      }
    : selectFleetHost({
        observations: statuses,
        cwd,
        sourceHost,
        localHost,
        pinnedHost,
        requiresLocalContext: Boolean(process.env.PASEO_AGENT_ID),
      });
  const model = resolveFleetProviderModelOptions(options);
  const thinking = options.thinking ?? FLEET_DEFAULT_THINKING;
  const result = await runRunCommand(
    prompt,
    {
      ...options,
      host: plan.host.endpoint,
      cwd: plan.cwd,
      provider: model.provider,
      model: model.model,
      thinking,
      base: resolveFleetWorktreeBase(options, cwd),
    },
    command,
  );
  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: plan.host.id,
      fleetEndpoint: plan.host.endpoint,
      routeReason: plan.reason,
      effectiveModel: model.effectiveModel,
      effectiveThinking: thinking,
    },
    schema: fleetRunSchema,
  };
}

async function runFleetFinishCommand(
  query: string,
  options: AgentFinishOptions & { host?: string },
  command: Command,
): Promise<SingleResult<AgentFinishResult>> {
  const pinnedHost = requireFleetHost(options.host);
  const hosts = pinnedHost ? [pinnedHost] : FLEET_HOSTS;
  const results = await Promise.all(
    hosts.map(async (host) => {
      let client: Awaited<ReturnType<typeof connectToDaemon>> | null = null;
      try {
        client = await connectToDaemon({ host: host.endpoint });
        const response = await client.fetchAgents({ filter: { includeArchived: true } });
        const agents = response.entries.map(({ agent }) => agent as AgentSnapshotPayload);
        return { matches: findFleetAgentMatches(query, host, agents) };
      } catch (error) {
        return { failure: { host, error: error instanceof Error ? error.message : String(error) } };
      } finally {
        await client?.close().catch(() => {});
      }
    }),
  );
  const location = selectFleetAgentLocation(
    query,
    results.flatMap((result) => result.matches ?? []),
    results.flatMap((result) => (result.failure ? [result.failure] : [])),
  );
  return runFinishCommand(location.agentId, { ...options, host: location.host.endpoint }, command);
}

export function createFleetCommand(): Command {
  const fleet = new CommanderCommand("fleet").description(
    "Route and diagnose the configured Paseo fleet",
  );
  addJsonOption(fleet.command("status").description("Show fleet capacity and readiness")).action(
    withOutput(runFleetStatusCommand),
  );
  addJsonOption(
    fleet.command("doctor").description("Check fleet readiness without changing state"),
  ).action(withOutput(runFleetDoctorCommand));
  addJsonOption(
    addRunOptions(fleet.command("run"), { optionalPrompt: true })
      .option("--prompt <text>", "Provide the task inline as a flag")
      .option("--prompt-file <path>", "Read the task from a UTF-8 text file")
      .option("--host <host>", "Pin macbook or imac"),
  ).action(withOutput(runFleetRunCommand));
  addJsonOption(
    addFinishOptions(fleet.command("finish")).option("--host <host>", "Pin macbook or imac"),
  ).action(withOutput(runFleetFinishCommand));
  return fleet;
}
