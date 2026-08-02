import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { FleetHostObservation } from "./routing.js";
import { FLEET_HOSTS, type FleetHost } from "./topology.js";

export type FleetTaskState = "running" | "idle" | "needs_permission";

export interface FleetActiveTask {
  agentId: string;
  name: string | null;
  status: string;
  state: FleetTaskState;
  pendingPermissionCount: number;
  permissionTools: string[];
}

export interface FleetHostStatus extends FleetHostObservation {
  state: "ready" | "degraded" | "needs_permission";
  activeTasks: FleetActiveTask[];
  issue: string | null;
}

type FleetClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "getDaemonStatus" | "fetchAgents" | "fetchWorkspaces" | "close"
>;

export type FleetConnect = (options: { host: string; timeout?: number }) => Promise<FleetClient>;

function resolveTaskState(agent: AgentSnapshotPayload): FleetTaskState {
  if ((agent.pendingPermissions?.length ?? 0) > 0) return "needs_permission";
  if (agent.status === "running") return "running";
  return "idle";
}

function mapAgent(agent: AgentSnapshotPayload): FleetActiveTask {
  const pendingPermissions = agent.pendingPermissions ?? [];
  return {
    agentId: agent.id,
    name: agent.title,
    status: agent.status,
    state: resolveTaskState(agent),
    pendingPermissionCount: pendingPermissions.length,
    permissionTools: pendingPermissions.map((permission) => permission.name),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveFleetState(needsPermission: boolean, degraded: boolean): FleetHostStatus["state"] {
  if (needsPermission) return "needs_permission";
  if (degraded) return "degraded";
  return "ready";
}

function readDaemonProbe(
  result: PromiseSettledResult<Awaited<ReturnType<FleetClient["getDaemonStatus"]>>>,
  issues: string[],
): boolean {
  if (result.status === "rejected") {
    issues.push(`readiness probe failed: ${errorMessage(result.reason)}`);
    return false;
  }
  const openCode = result.value.providers.find(({ provider }) => provider === "opencode");
  if (openCode?.available === true) return true;
  issues.push(openCode?.error ?? "OpenCode is unavailable");
  return false;
}

function readAgentProbe(
  result: PromiseSettledResult<Awaited<ReturnType<FleetClient["fetchAgents"]>>>,
  issues: string[],
): FleetActiveTask[] {
  if (result.status === "rejected") {
    issues.push(`agent inventory probe failed: ${errorMessage(result.reason)}`);
    return [];
  }
  return result.value.entries
    .map(({ agent }) => mapAgent(agent))
    .filter(({ status }) => ["initializing", "running", "idle"].includes(status));
}

async function readWorkspaceProbe(
  client: FleetClient,
  result: PromiseSettledResult<Awaited<ReturnType<FleetClient["fetchWorkspaces"]>>>,
  issues: string[],
): Promise<{ ready: boolean; workspaceIds: string[] }> {
  if (result.status === "rejected") {
    issues.push(`workspace inventory probe failed: ${errorMessage(result.reason)}`);
    return { ready: false, workspaceIds: [] };
  }
  const workspaceIds = result.value.entries.map(({ id }) => id);
  let cursor = result.value.pageInfo.nextCursor ?? undefined;
  try {
    while (cursor) {
      const page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
      workspaceIds.push(...page.entries.map(({ id }) => id));
      cursor = page.pageInfo.nextCursor ?? undefined;
    }
    return { ready: true, workspaceIds };
  } catch (error) {
    issues.push(`workspace inventory probe failed: ${errorMessage(error)}`);
    return { ready: false, workspaceIds: [] };
  }
}

async function inspectConnectedFleetHost(
  host: FleetHost,
  client: FleetClient,
): Promise<FleetHostStatus> {
  const [daemonResult, agentsResult, workspacesResult] = await Promise.allSettled([
    client.getDaemonStatus({ timeout: 15_000 }),
    client.fetchAgents({ filter: { includeArchived: false }, timeout: 15_000 }),
    client.fetchWorkspaces({ page: { limit: 200 } }),
  ]);
  const issues: string[] = [];
  const openCodeReady = readDaemonProbe(daemonResult, issues);
  const activeTasks = readAgentProbe(agentsResult, issues);
  const workspaceProbe = await readWorkspaceProbe(client, workspacesResult, issues);
  const agentInventoryReady = agentsResult.status === "fulfilled";
  const degraded = !openCodeReady || !agentInventoryReady || !workspaceProbe.ready;
  const needsPermission = activeTasks.some(({ state }) => state === "needs_permission");
  return {
    host,
    reachable: true,
    openCodeReady,
    agentInventoryReady,
    workspaceInventoryReady: workspaceProbe.ready,
    activeAgents: activeTasks.length,
    workspaceIds: workspaceProbe.workspaceIds,
    state: resolveFleetState(needsPermission, degraded),
    activeTasks,
    issue: issues.length > 0 ? issues.join("; ") : null,
  };
}

export async function inspectFleetHost(
  host: FleetHost,
  connect: FleetConnect = connectToDaemon,
): Promise<FleetHostStatus> {
  let client: FleetClient;
  try {
    client = await connect({ host: host.endpoint, timeout: 1_500 });
  } catch (error) {
    return {
      host,
      reachable: false,
      openCodeReady: false,
      agentInventoryReady: false,
      workspaceInventoryReady: false,
      activeAgents: 0,
      workspaceIds: [],
      state: "degraded",
      activeTasks: [],
      issue: errorMessage(error),
    };
  }
  try {
    return await inspectConnectedFleetHost(host, client);
  } finally {
    await client.close().catch(() => {});
  }
}

export function buildFleetDoctorResult(hosts: readonly FleetHostStatus[]) {
  const needsPermission = hosts.some(({ state }) => state === "needs_permission");
  const degraded = hosts.some(
    ({ reachable, openCodeReady, agentInventoryReady, workspaceInventoryReady }) =>
      !reachable || !openCodeReady || !agentInventoryReady || !workspaceInventoryReady,
  );
  let recommendation = "Fleet is ready for dispatch.";
  if (needsPermission) {
    recommendation =
      "Review the named permission tools in Paseo; fleet doctor does not approve requests.";
  } else if (degraded) {
    recommendation = "Resolve the named host inventory or provider issue before dispatching work.";
  }
  return { state: resolveFleetState(needsPermission, degraded), hosts, recommendation };
}

export async function collectFleetStatus(
  hosts: readonly FleetHost[] = FLEET_HOSTS,
  connect: FleetConnect = connectToDaemon,
): Promise<FleetHostStatus[]> {
  return Promise.all(hosts.map((host) => inspectFleetHost(host, connect)));
}
