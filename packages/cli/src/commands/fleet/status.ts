import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { fetchAllAgents, fetchAllWorkspaces } from "../../utils/inventory.js";
import type { FleetHostObservation } from "./routing.js";
import type { FleetConfig, FleetHost } from "./topology.js";

export type FleetTaskState = "running" | "idle" | "needs_permission";

interface FleetActiveTask {
  state: FleetTaskState;
  pendingPermissionCount: number;
}

export interface FleetHostStatus extends FleetHostObservation {
  state: "ready" | "degraded" | "needs_permission";
  activeTasks: FleetActiveTask[];
  issue: string | null;
}

export interface FleetHostSummary {
  host: string;
  state: FleetHostStatus["state"];
  reachable: boolean;
  providerReady: boolean;
  agentInventoryReady: boolean;
  workspaceInventoryReady: boolean;
  activeAgents: number;
  pendingPermissions: number;
  issue: string | null;
}

type FleetClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "getDaemonStatus" | "fetchAgents" | "fetchWorkspaces" | "close"
>;

export type FleetConnect = (options: { host: string; timeout?: number }) => Promise<FleetClient>;

function resolveTaskState(agent: AgentSnapshotPayload): FleetTaskState {
  if (agent.pendingPermissions.length > 0) return "needs_permission";
  if (agent.status === "running") return "running";
  return "idle";
}

function mapAgent(agent: AgentSnapshotPayload): FleetActiveTask {
  return {
    state: resolveTaskState(agent),
    pendingPermissionCount: agent.pendingPermissions.length,
  };
}

function resolveFleetState(needsPermission: boolean, degraded: boolean): FleetHostStatus["state"] {
  if (needsPermission) return "needs_permission";
  if (degraded) return "degraded";
  return "ready";
}

function readDaemonProbe(
  result: PromiseSettledResult<Awaited<ReturnType<FleetClient["getDaemonStatus"]>>>,
  provider: string,
  issues: string[],
): boolean {
  if (result.status === "rejected") {
    issues.push("readiness probe failed");
    return false;
  }
  const providerStatus = result.value.providers.find((entry) => entry.provider === provider);
  if (providerStatus?.available === true) return true;
  issues.push("configured provider is unavailable");
  return false;
}

function readAgentProbe(
  result: PromiseSettledResult<AgentSnapshotPayload[]>,
  issues: string[],
): FleetActiveTask[] {
  if (result.status === "rejected") {
    issues.push("agent inventory probe failed");
    return [];
  }
  return result.value
    .map((agent) => ({ agent, task: mapAgent(agent) }))
    .filter(({ agent }) => ["initializing", "running", "idle"].includes(agent.status))
    .map(({ task }) => task);
}

function readWorkspaceProbe(
  result: PromiseSettledResult<Awaited<ReturnType<typeof fetchAllWorkspaces>>>,
  issues: string[],
): { ready: boolean; workspaceIds: string[] } {
  if (result.status === "rejected") {
    issues.push("workspace inventory probe failed");
    return { ready: false, workspaceIds: [] };
  }
  return { ready: true, workspaceIds: result.value.map(({ id }) => id) };
}

async function inspectConnectedFleetHost(input: {
  host: FleetHost;
  provider: string;
  client: FleetClient;
}): Promise<FleetHostStatus> {
  const { host, provider, client } = input;
  const [daemonResult, agentsResult, workspacesResult] = await Promise.allSettled([
    client.getDaemonStatus({ timeout: 15_000 }),
    fetchAllAgents(client, { includeArchived: false, scope: "active", timeout: 15_000 }),
    fetchAllWorkspaces(client),
  ]);
  const issues: string[] = [];
  const providerReady = readDaemonProbe(daemonResult, provider, issues);
  const activeTasks = readAgentProbe(agentsResult, issues);
  const workspaceProbe = readWorkspaceProbe(workspacesResult, issues);
  const agentInventoryReady = agentsResult.status === "fulfilled";
  const degraded = !providerReady || !agentInventoryReady || !workspaceProbe.ready;
  const needsPermission = activeTasks.some(({ state }) => state === "needs_permission");
  return {
    host,
    reachable: true,
    providerReady,
    agentInventoryReady,
    workspaceInventoryReady: workspaceProbe.ready,
    activeAgents: activeTasks.length,
    workspaceIds: workspaceProbe.workspaceIds,
    state: resolveFleetState(needsPermission, degraded),
    activeTasks,
    issue: issues.length > 0 ? issues.join("; ") : null,
  };
}

export async function inspectFleetHost(input: {
  host: FleetHost;
  provider: string;
  connect?: FleetConnect;
}): Promise<FleetHostStatus> {
  const connect = input.connect ?? connectToDaemon;
  let client: FleetClient;
  try {
    client = await connect({ host: input.host.endpoint, timeout: 1_500 });
  } catch {
    return {
      host: input.host,
      reachable: false,
      providerReady: false,
      agentInventoryReady: false,
      workspaceInventoryReady: false,
      activeAgents: 0,
      workspaceIds: [],
      state: "degraded",
      activeTasks: [],
      issue: "connection failed",
    };
  }
  try {
    return await inspectConnectedFleetHost({
      host: input.host,
      provider: input.provider,
      client,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

export function summarizeFleetHostStatus(status: FleetHostStatus): FleetHostSummary {
  return {
    host: status.host.id,
    state: status.state,
    reachable: status.reachable,
    providerReady: status.providerReady,
    agentInventoryReady: status.agentInventoryReady,
    workspaceInventoryReady: status.workspaceInventoryReady,
    activeAgents: status.activeAgents,
    pendingPermissions: status.activeTasks.reduce(
      (count, task) => count + task.pendingPermissionCount,
      0,
    ),
    issue: status.issue,
  };
}

export function buildFleetDoctorResult(hosts: readonly FleetHostStatus[]) {
  const needsPermission = hosts.some(({ state }) => state === "needs_permission");
  const degraded = hosts.some(
    ({ reachable, providerReady, agentInventoryReady, workspaceInventoryReady }) =>
      !reachable || !providerReady || !agentInventoryReady || !workspaceInventoryReady,
  );
  let recommendation = "Fleet is ready for dispatch.";
  if (needsPermission) {
    recommendation = "Review pending permissions in Paseo; fleet doctor does not approve requests.";
  } else if (degraded) {
    recommendation =
      "Restore every configured host inventory and provider before dispatching work.";
  }
  return {
    state: resolveFleetState(needsPermission, degraded),
    hosts: hosts.map(summarizeFleetHostStatus),
    recommendation,
  };
}

export async function collectFleetStatus(
  config: FleetConfig,
  connect: FleetConnect = connectToDaemon,
): Promise<FleetHostStatus[]> {
  return Promise.all(
    config.hosts.map((host) =>
      inspectFleetHost({ host, provider: config.defaults.provider, connect }),
    ),
  );
}
