import type { Logger } from "pino";

import {
  AgentRunCancellationError,
  type AgentRunCancellationResult,
  type ManagedAgent,
} from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentProviderNotice } from "./agent-sdk-types.js";
import {
  assertDestructiveActionAuthorized,
  type DestructiveActionName,
  type DestructiveCallerContext,
} from "./destructive-action-authority.js";

export type LifecycleAgentSnapshot = Pick<ManagedAgent, "id" | "cwd" | "workspaceId" | "lifecycle">;

export interface LifecycleAgentManager {
  getAgent(agentId: string): LifecycleAgentSnapshot | null;
  isCurrentAgentIncarnation?(agentId: string, incarnation: string): boolean;
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(
    agentId: string,
    options?: { assumeRunning?: boolean },
  ): Promise<AgentRunCancellationResult>;
  clearAgentAttention(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord>;
  closeAgent(agentId: string): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }>;
  notifyAgentState(agentId: string): void;
  setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void>;
}

export interface LifecycleAgentStorage {
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
}

export interface AgentLifecycleCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  logger: Logger;
}

export interface CancelAgentRunResult {
  agent: LifecycleAgentSnapshot | null;
  cancelled: boolean;
  outcome: CancelAgentRunOutcome;
}

export type CancelAgentRunOutcome =
  | "cancelled"
  | "not_running"
  | "not_found"
  | "archived"
  | "not_resumable";

export interface CancelAgentRunCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  loadAgent(agentId: string): Promise<LifecycleAgentSnapshot>;
  logger: Logger;
}

interface RequestedAgentRunCancellation {
  agent: LifecycleAgentSnapshot;
  cancelled: boolean;
  cancellation: AgentRunCancellationResult;
}

async function requestAgentRunCancellation(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger">,
  agentId: string,
  options?: { assumeRunning?: boolean; agent?: LifecycleAgentSnapshot },
): Promise<RequestedAgentRunCancellation> {
  const { agentManager, logger } = dependencies;
  const agent = options?.agent ?? agentManager.getAgent(agentId);
  if (!agent) {
    logger.trace({ agentId }, "cancelAgentRunCommand: agent not found");
    throw new Error(`Agent ${agentId} not found`);
  }

  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  if (!hasInFlightRun && !options?.assumeRunning) {
    logger.trace(
      { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
      "cancelAgentRunCommand: skipping because agent is not running",
    );
    return { agent, cancelled: false, cancellation: { status: "not_running" } };
  }

  logger.debug(
    { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
    "cancelAgentRunCommand: interrupting",
  );
  const startedAt = Date.now();
  const cancellation = await agentManager.cancelAgentRun(
    agentId,
    options?.assumeRunning ? { assumeRunning: true } : undefined,
  );
  logger.debug(
    { agentId, cancellation: cancellation.status, durationMs: Date.now() - startedAt },
    "cancelAgentRunCommand: cancelAgentRun completed",
  );

  return {
    agent,
    cancelled: cancellation.status === "settled",
    cancellation,
  };
}

export async function cancelAgentRunCommand(
  dependencies: CancelAgentRunCommandDependencies,
  agentId: string,
): Promise<CancelAgentRunResult> {
  let agent = dependencies.agentManager.getAgent(agentId);

  if (!agent) {
    const record = await dependencies.agentStorage.get(agentId);
    if (!record) {
      return { agent: null, cancelled: false, outcome: "not_found" };
    }
    if (record.archivedAt) {
      return { agent: null, cancelled: false, outcome: "archived" };
    }
    if (record.lastStatus !== "running") {
      return { agent: null, cancelled: false, outcome: "not_running" };
    }
    if (!record.persistence) {
      return { agent: null, cancelled: false, outcome: "not_resumable" };
    }

    const loadedAgent = await dependencies.loadAgent(agentId);
    agent = dependencies.agentManager.getAgent(agentId) ?? loadedAgent;
  } else if (agent.lifecycle === "initializing") {
    const record = await dependencies.agentStorage.get(agentId);
    if (record?.lastStatus === "running" && record.persistence && !record.archivedAt) {
      const loadedAgent = await dependencies.loadAgent(agentId);
      agent = dependencies.agentManager.getAgent(agentId) ?? loadedAgent;
    }
  }

  const result = await requestAgentRunCancellation(dependencies, agentId, { agent });
  if (result.cancellation.status === "refused") {
    dependencies.logger.warn(
      { agentId },
      "cancelAgentRunCommand: reported running but no active run was cancelled",
    );
    throw new AgentRunCancellationError(agentId, "stop");
  }

  return {
    agent: result.agent,
    cancelled: result.cancelled,
    outcome: result.cancelled ? "cancelled" : "not_running",
  };
}

export interface ArchiveAgentResult {
  agentId: string;
  archivedAt: string;
  record: StoredAgentRecord;
}

export async function archiveAgentCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
  options?: {
    caller?: DestructiveCallerContext;
    action?: "agent.archive" | "agent.finish";
    signal?: AbortSignal;
  },
): Promise<ArchiveAgentResult> {
  const liveAgent = dependencies.agentManager.getAgent(agentId);
  const authorize = () =>
    assertAgentDestructiveActionAuthorized(
      dependencies.agentManager,
      options?.caller,
      agentId,
      options?.action ?? "agent.archive",
      options?.signal,
    );
  authorize();
  let record: StoredAgentRecord | null;
  if (liveAgent) {
    await requestAgentRunCancellation(dependencies, agentId);
    await dependencies.agentManager.clearAgentAttention(agentId).catch(() => undefined);
    authorize();
    await dependencies.agentManager.archiveAgent(agentId);
    record = await dependencies.agentStorage.get(agentId);
  } else {
    record = await archiveStoredAgent(dependencies, agentId, authorize);
  }

  if (!record) {
    throw new Error(`Agent not found in storage after archive: ${agentId}`);
  }
  if (!record.archivedAt) {
    throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
  }

  return {
    agentId,
    archivedAt: record.archivedAt,
    record,
  };
}

export async function closeAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
  options?: { caller?: DestructiveCallerContext; signal?: AbortSignal },
): Promise<void> {
  assertAgentDestructiveActionAuthorized(
    dependencies.agentManager,
    options?.caller,
    agentId,
    "agent.kill",
    options?.signal,
  );
  await dependencies.agentManager.closeAgent(agentId);
}

export function assertAgentDestructiveActionAuthorized(
  agentManager: Pick<LifecycleAgentManager, "getAgent" | "isCurrentAgentIncarnation">,
  caller: DestructiveCallerContext | undefined,
  agentId: string,
  action: Extract<
    DestructiveActionName,
    "agent.archive" | "agent.delete" | "agent.kill" | "agent.finish"
  >,
  signal?: AbortSignal,
): void {
  if (!caller) {
    return;
  }
  const target = agentManager.getAgent(agentId);
  assertDestructiveActionAuthorized(
    {
      getAgent: (id) => agentManager.getAgent(id),
      isCurrentAgentIncarnation: (id, incarnation) =>
        agentManager.isCurrentAgentIncarnation?.(id, incarnation) === true,
    },
    caller,
    {
      action,
      targetAgentIds: [agentId],
      targetWorkspaceIds: target?.workspaceId ? [target.workspaceId] : [],
      hasLiveTarget: target !== null,
    },
    signal,
  );
}

export interface UpdateAgentResult {
  accepted: boolean;
  error: string | null;
}

export async function updateAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    name?: string;
    labels?: Record<string, string>;
  },
): Promise<UpdateAgentResult> {
  const title = input.name?.trim();
  const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined;

  if (!title && !labels) {
    return {
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    };
  }

  await dependencies.agentManager.updateAgentMetadata(input.agentId, {
    ...(title ? { title } : {}),
    ...(labels ? { labels } : {}),
  });

  return {
    accepted: true,
    error: null,
  };
}

export interface DetachAgentResult {
  agentId: string;
  record: StoredAgentRecord;
  live: boolean;
  previousParentAgentId: string | null;
}

export async function detachAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<DetachAgentResult> {
  const result = await dependencies.agentManager.detachAgent(agentId);
  return {
    agentId,
    ...result,
  };
}

export async function setAgentModeCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    modeId: string;
  },
): Promise<{ modeId: string; notice: AgentProviderNotice | null }> {
  const notice = await dependencies.agentManager.setAgentMode(input.agentId, input.modeId);
  return { modeId: input.modeId, notice };
}

async function archiveStoredAgent(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage">,
  agentId: string,
  authorize: () => void,
): Promise<StoredAgentRecord> {
  const existing = await dependencies.agentStorage.get(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (existing.archivedAt) {
    return existing;
  }

  authorize();
  const archivedAt = new Date().toISOString();
  return dependencies.agentManager.archiveSnapshot(agentId, archivedAt);
}
