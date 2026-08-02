import os from "node:os";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { withOutput } from "../../output/index.js";
import type { CommandError, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { fetchAllAgents } from "../../utils/inventory.js";
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
import {
  buildFleetDoctorResult,
  collectFleetStatus,
  summarizeFleetHostStatus,
  type FleetHostSummary,
} from "./status.js";
import {
  findFleetHost,
  findFleetHostForCwd,
  findFleetHostForHostname,
  loadFleetConfig,
  type FleetHost,
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
  routeReason: FleetRouteReason;
  effectiveModel: string | undefined;
  effectiveThinking: string | undefined;
}

const fleetStatusSchema: OutputSchema<FleetHostSummary> = {
  idField: "host",
  columns: [
    { header: "HOST", field: "host" },
    { header: "STATE", field: "state" },
    { header: "ACTIVE", field: "activeAgents", align: "right" },
    {
      header: "PERMISSIONS",
      field: (status) => status.pendingPermissions,
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

function requireFleetHost(value: string | undefined, hosts: readonly FleetHost[]) {
  if (!value) return null;
  const host = findFleetHost(value, hosts);
  if (!host) {
    throw {
      code: "INVALID_FLEET_HOST",
      message: `Unknown fleet host: ${value}`,
      details: `Configured hosts: ${hosts.map(({ id }) => id).join(", ")}.`,
    } satisfies CommandError;
  }
  return host;
}

async function runFleetStatusCommand(): Promise<ListResult<FleetHostSummary>> {
  const statuses = await collectFleetStatus(loadFleetConfig());
  return {
    type: "list",
    data: statuses.map(summarizeFleetHostStatus),
    schema: fleetStatusSchema,
    exitCode: statuses.every(({ state }) => state === "ready") ? 0 : 1,
  };
}

async function runFleetDoctorCommand(): Promise<
  SingleResult<ReturnType<typeof buildFleetDoctorResult>>
> {
  const result = buildFleetDoctorResult(await collectFleetStatus(loadFleetConfig()));
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
    exitCode: result.state === "ready" ? 0 : 1,
  };
}

async function runFleetRunCommand(
  positionalPrompt: string | undefined,
  options: FleetRunOptions,
  command: Command,
): Promise<SingleResult<FleetRunResult>> {
  const config = loadFleetConfig();
  const prompt = await resolveFleetRunPrompt(positionalPrompt, options);
  const pinnedHost = requireFleetHost(options.host, config.hosts);
  const statuses = await collectFleetStatus(config);
  const workspaceId = options.workspace ?? process.env.PASEO_WORKSPACE_ID;
  const cwd = options.cwd ?? process.cwd();
  const sourceHost = findFleetHostForCwd(cwd, config.hosts);
  const localHost = findFleetHostForHostname(os.hostname(), config.hosts);
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
  const model = resolveFleetProviderModelOptions(options, config.defaults);
  const thinking = options.thinking ?? config.defaults.thinking;
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
      routeReason: plan.reason,
      effectiveModel: model.effectiveModel,
      effectiveThinking: thinking,
    },
    schema: fleetRunSchema,
  };
}

export async function runFleetFinishCommand(
  query: string,
  options: AgentFinishOptions & { host?: string },
  command: Command,
): Promise<SingleResult<AgentFinishResult>> {
  const config = loadFleetConfig();
  const pinnedHost = requireFleetHost(options.host, config.hosts);
  const results = await Promise.all(
    config.hosts.map(async (host) => {
      let client: Awaited<ReturnType<typeof connectToDaemon>> | null = null;
      try {
        client = await connectToDaemon({ host: host.endpoint });
        const agents = await fetchAllAgents(client, { includeArchived: true });
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
  return runFinishCommand(
    location.agentId,
    { ...options, host: (pinnedHost ?? location.host).endpoint },
    command,
  );
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
      .option("--host <host>", "Pin a configured fleet host"),
  ).action(withOutput(runFleetRunCommand));
  addJsonOption(
    addFinishOptions(fleet.command("finish")).option(
      "--host <host>",
      "Pin a configured fleet host",
    ),
  ).action(withOutput(runFleetFinishCommand));
  return fleet;
}
