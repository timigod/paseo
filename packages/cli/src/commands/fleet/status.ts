import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { FLEET_HOSTS, FLEET_TOPOLOGY_VERSION, type FleetHost } from "./topology.js";

const ACTIVE_AGENT_STATUSES = new Set(["initializing", "running", "idle"]);

type FleetDaemonClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "getDaemonStatus" | "fetchAgents" | "close"
>;

export type FleetConnect = (options: {
  host: string;
  timeout?: number;
}) => Promise<FleetDaemonClient>;

export interface FleetHostStatus {
  id: string;
  name: string;
  endpoint: string;
  capacity: number;
  reachable: boolean;
  version: string | null;
  openCodeReady: boolean;
  activeAgents: number;
  freeSlots: number;
  statusCounts: Record<string, number>;
  issue: string | null;
}

export interface FleetDoctorResult {
  topologyVersion: number;
  hosts: FleetHostStatus[];
  recommendation: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countStatuses(statuses: readonly string[]): Record<string, number> {
  return statuses.reduce<Record<string, number>>((counts, status) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

export async function inspectFleetHost(
  host: FleetHost,
  connect: FleetConnect = connectToDaemon,
): Promise<FleetHostStatus> {
  let client: FleetDaemonClient | null = null;
  try {
    client = await connect({ host: host.endpoint, timeout: 1_500 });
    const [daemonStatus, agents] = await Promise.all([
      client.getDaemonStatus({ timeout: 5_000 }),
      client.fetchAgents({ scope: "active" }),
    ]);
    const statuses = agents.entries.map((entry) => entry.agent.status);
    const activeAgents = statuses.filter((status) => ACTIVE_AGENT_STATUSES.has(status)).length;
    const openCode = daemonStatus.providers.find((provider) => provider.provider === "opencode");

    return {
      id: host.id,
      name: host.name,
      endpoint: host.endpoint,
      capacity: host.capacity,
      reachable: true,
      version: daemonStatus.version ?? null,
      openCodeReady: openCode?.available === true,
      activeAgents,
      freeSlots: Math.max(host.capacity - activeAgents, 0),
      statusCounts: countStatuses(statuses),
      issue: openCode?.available === true ? null : (openCode?.error ?? "OpenCode is unavailable"),
    };
  } catch (error) {
    return {
      id: host.id,
      name: host.name,
      endpoint: host.endpoint,
      capacity: host.capacity,
      reachable: false,
      version: null,
      openCodeReady: false,
      activeAgents: 0,
      freeSlots: 0,
      statusCounts: {},
      issue: errorMessage(error),
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function collectFleetStatus(
  input: {
    hosts?: readonly FleetHost[];
    connect?: FleetConnect;
  } = {},
): Promise<FleetHostStatus[]> {
  const hosts = input.hosts ?? FLEET_HOSTS;
  const connect = input.connect ?? connectToDaemon;
  return Promise.all(hosts.map((host) => inspectFleetHost(host, connect)));
}

const fleetStatusSchema: OutputSchema<FleetHostStatus> = {
  idField: "id",
  columns: [
    { header: "HOST", field: "name" },
    { header: "DAEMON", field: (host) => (host.reachable ? "reachable" : "unreachable") },
    { header: "VERSION", field: (host) => host.version ?? "-" },
    { header: "OPENCODE", field: (host) => (host.openCodeReady ? "ready" : "unavailable") },
    { header: "ACTIVE", field: "activeAgents", align: "right" },
    { header: "FREE", field: "freeSlots", align: "right" },
    { header: "DETAIL", field: (host) => host.issue ?? "healthy" },
  ],
};

export async function runFleetStatusCommand(
  _options: CommandOptions,
  _command: Command,
): Promise<ListResult<FleetHostStatus>> {
  return { type: "list", data: await collectFleetStatus(), schema: fleetStatusSchema };
}

function diagnoseFleet(hosts: readonly FleetHostStatus[]): string[] {
  const issues: string[] = [];
  for (const host of hosts) {
    if (!host.reachable) {
      issues.push(`${host.name} is unreachable${host.issue ? `: ${host.issue}` : ""}`);
      continue;
    }
    if (!host.openCodeReady) {
      issues.push(`${host.name} cannot serve OpenCode${host.issue ? `: ${host.issue}` : ""}`);
    }
    if (host.activeAgents > host.capacity) {
      issues.push(`${host.name} is over capacity (${host.activeAgents}/${host.capacity})`);
    }
  }
  const versions = new Set(
    hosts.filter((host) => host.reachable && host.version).map((host) => host.version),
  );
  if (versions.size > 1) {
    issues.push(`Runtime versions differ across reachable hosts: ${[...versions].join(", ")}`);
  }
  return issues;
}

export async function runFleetDoctorCommand(
  _options: CommandOptions,
  _command: Command,
): Promise<SingleResult<FleetDoctorResult>> {
  const hosts = await collectFleetStatus();
  const issues = diagnoseFleet(hosts);
  if (issues.length > 0) {
    throw {
      code: "FLEET_DOCTOR_FAILED",
      message: `Fleet doctor found ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
      details: {
        issues,
        hosts,
        recommendation:
          "Resolve the named host condition before dispatching there; fleet run will not silently bypass an explicit host pin.",
      },
    } satisfies CommandError;
  }

  return {
    type: "single",
    data: {
      topologyVersion: FLEET_TOPOLOGY_VERSION,
      hosts,
      recommendation:
        "Fleet is healthy. Dispatch with paseo fleet run; it will select the least-loaded eligible host.",
    },
    schema: {
      idField: () => "fleet",
      columns: [
        { header: "STATUS", field: () => "healthy" },
        { header: "HOSTS", field: (result) => result.hosts.length },
        { header: "RECOMMENDATION", field: "recommendation" },
      ],
    },
  };
}

export { diagnoseFleet };
