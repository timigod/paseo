import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export interface AgentArchiveGraphAgent {
  readonly id: string;
  readonly workspaceId?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface AgentArchiveGraphStoredAgent extends AgentArchiveGraphAgent {
  readonly archivedAt?: string | null;
}

export interface AgentArchiveCascadePlan {
  readonly targetAgentIds: readonly string[];
  readonly targetWorkspaceIds: readonly string[];
  readonly liveAgentIds: ReadonlySet<string>;
  readonly childrenByParentAgentId: ReadonlyMap<string, readonly string[]>;
}

/**
 * Captures one authoritative cascade graph. Live metadata wins over its
 * persisted counterpart so an in-flight detach or parent-label update cannot
 * be undone by a later traversal of stale storage.
 */
export function buildAgentArchiveCascadePlan(
  seedAgentIds: readonly string[],
  liveAgents: readonly AgentArchiveGraphAgent[],
  storedRecords: readonly AgentArchiveGraphStoredAgent[],
): AgentArchiveCascadePlan {
  const parentAgentIdById = new Map<string, string | undefined>();
  const workspaceIdById = new Map<string, string>();
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));

  for (const record of storedRecords) {
    if (record.archivedAt && !liveAgentIds.has(record.id)) {
      continue;
    }
    parentAgentIdById.set(record.id, record.labels?.[PARENT_AGENT_ID_LABEL]);
    if (record.workspaceId) {
      workspaceIdById.set(record.id, record.workspaceId);
    }
  }
  for (const agent of liveAgents) {
    parentAgentIdById.set(agent.id, agent.labels?.[PARENT_AGENT_ID_LABEL]);
    if (agent.workspaceId) {
      workspaceIdById.set(agent.id, agent.workspaceId);
    } else {
      workspaceIdById.delete(agent.id);
    }
  }

  const targetAgentIds = Array.from(new Set(seedAgentIds));
  const targetAgentIdSet = new Set(targetAgentIds);
  const mutableChildrenByParentAgentId = new Map<string, string[]>();
  for (let index = 0; index < targetAgentIds.length; index += 1) {
    const parentAgentId = targetAgentIds[index];
    for (const [candidateAgentId, candidateParentAgentId] of parentAgentIdById) {
      if (targetAgentIdSet.has(candidateAgentId) || candidateParentAgentId !== parentAgentId) {
        continue;
      }
      targetAgentIdSet.add(candidateAgentId);
      targetAgentIds.push(candidateAgentId);
      const children = mutableChildrenByParentAgentId.get(parentAgentId) ?? [];
      children.push(candidateAgentId);
      mutableChildrenByParentAgentId.set(parentAgentId, children);
    }
  }

  const targetWorkspaceIds = Array.from(
    new Set(
      targetAgentIds
        .map((targetAgentId) => workspaceIdById.get(targetAgentId))
        .filter((workspaceId): workspaceId is string => typeof workspaceId === "string"),
    ),
  );
  const childrenByParentAgentId = new Map<string, readonly string[]>(
    Array.from(mutableChildrenByParentAgentId, ([parentAgentId, childAgentIds]) => [
      parentAgentId,
      Object.freeze([...childAgentIds]),
    ]),
  );

  return {
    targetAgentIds: Object.freeze([...targetAgentIds]),
    targetWorkspaceIds: Object.freeze(targetWorkspaceIds),
    liveAgentIds,
    childrenByParentAgentId,
  };
}
