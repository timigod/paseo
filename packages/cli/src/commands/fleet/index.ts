import os from "node:os";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { withOutput } from "../../output/index.js";
import type { CommandError, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { getOrCreateCliClientId } from "../../utils/client-id.js";
import { fetchAllAgents } from "../../utils/inventory.js";
import {
  addRunOptions,
  prepareAgentRunIntent,
  runAgentRunIntent,
  runRunCommand,
  type AgentRunIntent,
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
  findFleetHostById,
  findFleetHostForCwd,
  findFleetHostForHostname,
  loadFleetConfig,
  matchesFleetHostId,
  type FleetHost,
} from "./topology.js";
import {
  resolveFleetProviderModelOptions,
  resolveFleetRunPrompt,
  resolveFleetWorktreeBase,
} from "./run.js";
import { claimFleetAffinity, loadFleetAffinity } from "./affinity.js";

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

function matchesFleetAffinitySelector(
  value: string,
  owner: FleetHost,
  hosts: readonly FleetHost[],
): boolean {
  const currentHost = findFleetHost(value, hosts);
  return currentHost
    ? matchesFleetHostId(owner, currentHost.id)
    : findFleetHost(value, [owner]) !== null;
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

export async function runFleetRunCommand(
  positionalPrompt: string | undefined,
  options: FleetRunOptions,
  command: Command,
): Promise<SingleResult<FleetRunResult>> {
  const config = loadFleetConfig();
  const idempotencyKey = options.idempotencyKey?.trim() || null;
  const callerId = idempotencyKey ? await getOrCreateCliClientId() : null;
  const existingAffinity =
    idempotencyKey && callerId ? await loadFleetAffinity({ callerId, idempotencyKey }) : null;
  if (
    existingAffinity &&
    options.host &&
    !matchesFleetAffinitySelector(options.host, existingAffinity.host, loadFleetConfig().hosts)
  ) {
    throw {
      code: "FLEET_KEY_HOST_CONFLICT",
      message: `Idempotency key is owned by ${existingAffinity.host.id}, not pinned host ${options.host}`,
    } satisfies CommandError;
  }
  if (existingAffinity && idempotencyKey) {
    const currentHost = findFleetHostById(existingAffinity.host.id, loadFleetConfig().hosts);
    if (!currentHost) {
      throw {
        code: "FLEET_AFFINITY_HOST_MISSING",
        message: `Idempotency key is owned by fleet host ${existingAffinity.host.id}, which is no longer configured`,
      } satisfies CommandError;
    }
    const result = await runAgentRunIntent({
      intent: existingAffinity.intent,
      host: currentHost.endpoint,
      expectedDaemonId: existingAffinity.daemonId,
      idempotencyKey,
    });
    return buildFleetRunResult(result, {
      hostId: currentHost.id,
      reason: "idempotency_key",
      intent: existingAffinity.intent,
    });
  }

  const pinnedHost = requireFleetHost(options.host, config.hosts);
  const prompt = await resolveFleetRunPrompt(positionalPrompt, options);
  const workspaceId = options.workspace ?? process.env.PASEO_WORKSPACE_ID;
  const cwd = options.cwd ?? process.cwd();
  const plan = await resolveNewFleetRunPlan({
    config,
    workspaceId,
    cwd,
    sourceHost: findFleetHostForCwd(cwd, config.hosts),
    localHost: findFleetHostForHostname(os.hostname(), config.hosts),
    pinnedHost,
    idempotencyKey,
  });
  const model = resolveFleetProviderModelOptions(options, config.defaults);
  const thinking = options.thinking ?? config.defaults.thinking;
  const resolvedOptions = {
    ...options,
    host: plan.host.endpoint,
    cwd: plan.cwd,
    provider: model.provider,
    model: model.model,
    thinking,
    base: resolveFleetWorktreeBase(options, cwd),
  };

  if (idempotencyKey && callerId) {
    const prepared = await prepareAgentRunIntent(prompt, resolvedOptions);
    const affinity = await claimFleetAffinity({
      callerId,
      idempotencyKey,
      affinity: { host: plan.host, daemonId: prepared.daemonId, intent: prepared.intent },
    });
    if (pinnedHost && !matchesFleetHostId(affinity.host, pinnedHost.id)) {
      throw {
        code: "FLEET_KEY_HOST_CONFLICT",
        message: `Idempotency key is owned by ${affinity.host.id}, not pinned host ${pinnedHost.id}`,
      } satisfies CommandError;
    }
    const currentHost = findFleetHostById(affinity.host.id, loadFleetConfig().hosts);
    if (!currentHost) {
      throw {
        code: "FLEET_AFFINITY_HOST_MISSING",
        message: `Idempotency key is owned by fleet host ${affinity.host.id}, which is no longer configured`,
      } satisfies CommandError;
    }
    const result = await runAgentRunIntent({
      intent: affinity.intent,
      host: currentHost.endpoint,
      expectedDaemonId: affinity.daemonId,
      idempotencyKey,
    });
    return buildFleetRunResult(result, {
      hostId: currentHost.id,
      reason: "idempotency_key",
      intent: affinity.intent,
    });
  }

  const result = await runRunCommand(prompt, resolvedOptions, command);
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

function buildFleetRunResult(
  result: SingleResult<AgentRunResult>,
  input: { hostId: string; reason: FleetRouteReason; intent: AgentRunIntent },
): SingleResult<FleetRunResult> {
  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: input.hostId,
      routeReason: input.reason,
      effectiveModel: input.intent.create.config.model,
      effectiveThinking: input.intent.create.config.thinkingOptionId,
    },
    schema: fleetRunSchema,
  };
}

async function resolveNewFleetRunPlan(input: {
  config: ReturnType<typeof loadFleetConfig>;
  workspaceId: string | undefined;
  cwd: string;
  sourceHost: FleetHost | null;
  localHost: FleetHost | null;
  pinnedHost: FleetHost | null;
  idempotencyKey: string | null;
}) {
  const statuses = await collectFleetStatus(input.config);
  return input.workspaceId
    ? {
        ...selectFleetWorkspaceHost({
          observations: statuses,
          workspaceId: input.workspaceId,
          pinnedHost: input.pinnedHost,
        }),
        cwd: input.cwd,
      }
    : selectFleetHost({
        observations: statuses,
        cwd: input.cwd,
        sourceHost: input.sourceHost,
        localHost: input.localHost,
        pinnedHost: input.pinnedHost,
        requiresLocalContext: Boolean(process.env.PASEO_AGENT_ID),
        idempotencyKey: input.idempotencyKey,
      });
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
  if (pinnedHost && pinnedHost.id !== location.host.id) {
    throw {
      code: "FLEET_AGENT_ON_OTHER_HOST",
      message: `Agent ${location.agentId} is owned by ${location.host.id}, not pinned host ${pinnedHost.id}`,
    } satisfies CommandError;
  }
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
